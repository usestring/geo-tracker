// Headroom scoring: rank pages by the clicks a fix would earn, not by age.
//
// Every page gets three estimates, and the biggest one decides what kind of
// fix to propose:
//
//   recover  clicks lost vs the previous window        -> regression: diff the
//                                                         page, check coverage
//   ctr      page-one clicks the page did not get vs   -> title/description
//            the CTR its position should earn             rewrite
//   rank     clicks a page-two post would gain by      -> content push: expand,
//            landing on page one                          internal links, links
//
// The CTR lever needs a model of how many clicks a position should earn. The
// curve below is a soft one on purpose: GSC's "position" is an average blended
// across every query the page appears for, which can over-count headroom (one
// good query masks many bad ones) or hide it entirely (a page beating its
// blended expectation clamps to zero). Treat opportunity as an ordering, never
// as a forecast.
//
// Reads:  data/gsc/pages-*.csv (latest = current 28d window, second-latest =
//         the prior pull), data/gsc/queries-*.csv (latest, for near-misses).
// Writes: data/opportunity.json. A weekly review turns the top rows into
//         proposals; nothing here edits anything.

import { writeFileSync } from "fs";
import { join } from "path";
import { listPulls, readPerfCsv } from "./lib/gsc-csv";

const DATA = join(import.meta.dir, "..", "data");

// Organic CTR by average position. Midpoints of the published curves (they
// disagree with each other by half their value, which is another reason this
// is an ordering signal only). Past position 10 everything earns page-two
// scraps.
const CTR_CURVE: Record<number, number> = {
  1: 0.28, 2: 0.15, 3: 0.11, 4: 0.08, 5: 0.065,
  6: 0.05, 7: 0.04, 8: 0.033, 9: 0.028, 10: 0.024,
};
const PAGE2_CTR = 0.01;
// Where a page lands when a content push moves it from page two to page one.
// Bottom of page one, not the top - assuming better is how estimates inflate.
const RANK_TARGET_POSITION = 8;
const WINDOW_DAYS = 28;

// Guardrails. A low CTR on a page nobody sees is not an opportunity - no edit
// fixes "nobody is searching for this" - and a clicks drop must be material
// both in absolute and proportional terms before it counts as a regression.
//
// The floors are tuned for a young site. On thin pages a CTR-curve estimate is
// noise, not signal: at position ~8 the curve expects ~3.3% CTR, so 400
// impressions is only ~13 expected clicks - below that, the gap between actual
// and expected CTR is a handful of clicks and well inside random variation.
// The floors keep the CTR-curve estimate honest; thin pages drop out of the
// ranking entirely rather than ranking on noise. A high-traffic site can lower
// them.
const MIN_IMPRESSIONS = 150;
const CTR_MIN_IMPRESSIONS = 400;
const RECOVER_MIN_ABS = 10;
const RECOVER_MIN_PROP = 0.25;
const NEAR_MISS_MIN_IMPRESSIONS = 150;
// Near-miss queries (Google already ranks us ~5-20 with no dedicated win) are
// the strongest signal a young site gets: proven demand plus proven relevance.
// Weight them up in the combined ordering so they surface ahead of same-sized
// page levers.
const NEAR_MISS_WEIGHT = 1.5;

const expectedCtr = (position: number): number => {
  if (position <= 0) return 0;
  if (position > 10) return PAGE2_CTR;
  const lo = CTR_CURVE[Math.floor(position)] ?? PAGE2_CTR;
  const hi = CTR_CURVE[Math.ceil(position)] ?? PAGE2_CTR;
  return lo + (hi - lo) * (position - Math.floor(position));
};

const pagePulls = listPulls(DATA, "pages");
if (pagePulls.length === 0) {
  console.error("no data/gsc/pages-*.csv - run `make gsc` first");
  process.exit(1);
}
const currPull = pagePulls[pagePulls.length - 1];
const prevPull = pagePulls.length > 1 ? pagePulls[pagePulls.length - 2] : null;
const curr = readPerfCsv(currPull.file, { normalizeKeys: true });
const prev = prevPull ? readPerfCsv(prevPull.file, { normalizeKeys: true }) : new Map();

// Consecutive trailing-28d windows overlap, so a steady regression only shows
// through the non-overlapping days: pulls 7 days apart see a quarter of a
// 28-day collapse. Scale the observed diff back up to full-window units so the
// recover lever competes fairly with the full-window ctr/rank levers, capped
// at the clicks the page actually had.
const gapDays = prevPull
  ? Math.max(1, Math.round((currPull.ts - prevPull.ts) / 86_400_000))
  : WINDOW_DAYS;
const recoverScale = Math.min(WINDOW_DAYS / Math.min(gapDays, WINDOW_DAYS), WINDOW_DAYS);

type Lever = "recover" | "ctr" | "rank";
const FIX: Record<Lever, string> = {
  recover: "regression: diff the page, re-check coverage and freshness",
  ctr: "title/description rewrite",
  rank: "content push: expand, internal links, external links",
};

const pages = [...curr.values()]
  .filter((p) => p.impressions >= MIN_IMPRESSIONS)
  .map((p) => {
    const ctr = p.impressions > 0 ? p.clicks / p.impressions : 0;
    const levers: Record<Lever, number> = { recover: 0, ctr: 0, rank: 0 };

    const was = prev.get(p.key);
    if (was) {
      const lost = was.clicks - p.clicks;
      if (lost >= RECOVER_MIN_ABS && lost >= was.clicks * RECOVER_MIN_PROP) {
        levers.recover = Math.min(Math.round(lost * recoverScale), was.clicks);
      }
    }
    if (p.position <= 10 && p.impressions >= CTR_MIN_IMPRESSIONS) {
      levers.ctr = Math.max(0, Math.round(p.impressions * (expectedCtr(p.position) - ctr)));
    }
    if (p.position > 10 && p.position <= 20 && p.impressions >= CTR_MIN_IMPRESSIONS) {
      levers.rank = Math.round(p.impressions * expectedCtr(RANK_TARGET_POSITION));
    }

    const lever = (Object.keys(levers) as Lever[]).reduce((a, b) => (levers[b] > levers[a] ? b : a));
    return {
      url: p.key,
      clicks: p.clicks,
      impressions: p.impressions,
      ctr: Number(ctr.toFixed(4)),
      position: Number(p.position.toFixed(1)),
      levers,
      lever,
      opportunity: levers[lever],
      fix: FIX[lever],
    };
  })
  .filter((p) => p.opportunity > 0)
  .sort((a, b) => b.opportunity - a.opportunity);

// Near-miss queries: demand Google already shows this site for, at positions
// where nobody clicks. Whether a dedicated page exists is not answerable from
// GSC alone - cross-check these against coverage before proposing a new page.
// Query text is the key here, deliberately unnormalized.
const queryPulls = listPulls(DATA, "queries");
const nearMissQueries = queryPulls.length === 0 ? [] :
  [...readPerfCsv(queryPulls[queryPulls.length - 1].file).values()]
    .filter((q) => q.impressions >= NEAR_MISS_MIN_IMPRESSIONS && q.position >= 5 && q.position <= 20)
    .map((q) => {
      const potentialClicks = Math.round(q.impressions * expectedCtr(RANK_TARGET_POSITION));
      return {
        query: q.key,
        clicks: q.clicks,
        impressions: q.impressions,
        position: Number(q.position.toFixed(1)),
        potentialClicks,
        weightedPotential: Math.round(potentialClicks * NEAR_MISS_WEIGHT),
      };
    })
    .sort((a, b) => b.potentialClicks - a.potentialClicks);

// Combined ordering: near-misses and page levers in one list, near-misses
// weighted by NEAR_MISS_WEIGHT. Additive field - `pages` and `nearMissQueries`
// keep their shapes for existing readers.
const ranked = [
  ...pages.map((p) => ({ type: "page" as const, key: p.url, score: p.opportunity, lever: p.lever, fix: p.fix })),
  ...nearMissQueries.map((q) => ({
    type: "nearMiss" as const,
    key: q.query,
    score: q.weightedPotential,
    lever: "nearMiss",
    fix: "content-brief candidate: cross-check coverage first (existing coverage = title/meta fix)",
  })),
].sort((a, b) => b.score - a.score);

const out = {
  generatedAt: new Date().toISOString(),
  windows: { current: currPull.date, previous: prevPull?.date ?? null, assumedWindowDays: WINDOW_DAYS },
  note: "opportunity = estimated clicks per 28d a fix would earn; ordering signal, not a forecast. ctr is a 0-1 fraction. ranked = combined ordering, near-misses weighted x" + NEAR_MISS_WEIGHT + ".",
  pages,
  nearMissQueries,
  ranked,
};
writeFileSync(join(DATA, "opportunity.json"), JSON.stringify(out, null, 2));

// Near-misses first: on a young site they are the highest-value signal.
for (const q of nearMissQueries.slice(0, 10)) {
  console.log(`near-miss ${String(q.potentialClicks).padStart(5)} clicks if won  pos ${q.position}  "${q.query}"`);
}
for (const p of pages.slice(0, 20)) {
  console.log(
    `${String(p.opportunity).padStart(6)} clicks  ${p.lever.padEnd(7)} pos ${String(p.position).padStart(4)}  ${p.url}`,
  );
}
if (!prevPull) console.log("(one pages CSV only - recover lever needs two pulls)");
console.log(`\nopportunity: ${pages.length} pages with headroom, ${nearMissQueries.length} near-miss queries -> data/opportunity.json`);
