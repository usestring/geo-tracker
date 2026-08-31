// Visibility rank (make rank): where does your brand sit in the answers next
// to every competitor, overall and per theme, this week against last week?
//
// Share of voice per brand over the latest-row extracted mentions on
// NON-BRANDED questions, trailing 7 days vs the 7 days before:
//   your brand    share = mentions.mentioned = 1 rate
//   competitor c  share = fraction of rows whose competitors JSON names c
// All surfaces where MENTION data is trustworthy count - the Google surfaces
// included, but only rows where Google actually showed an AI answer
// (serp_state = 'answer'); their CITATION extraction is broken, mention data
// is not. Retries append rows, so every count reads the latest row per
// question x model x day.
//
// Breakouts: per theme:* always; per prio: level only where prio tags exist
// in questions.csv - absent tags mean the breakout is skipped, never guessed.
//
// Writes data/visibility-rank.json; prints a compact ladder.

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { rankBrands, type RankedBrand } from "./lib/rank";
import { themeOf, prioOf, isBranded } from "./lib/tags";
import { BRAND_NAME } from "./brand.ts";

const DB_PATH = join(import.meta.dir, "..", "data", "geo.db");
const OUT_PATH = join(import.meta.dir, "..", "data", "visibility-rank.json");
const db = new Database(DB_PATH, { readonly: true });

const BRAND = BRAND_NAME;
// Mirrors extract.ts - the extraction pass only ever emits competitor names
// from COMPETITOR_NAMES (.env), so this is the full brand universe. Empty is
// fine: the ladder then contains only you.
const COMPETITORS = (process.env.COMPETITOR_NAMES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface Row {
  question_id: number;
  d: string;
  mentioned: number;
  competitors: string;
  tags: string;
}

// Latest row per question x model x day, extracted, mention-trustworthy.
const rows = db.query(`
  SELECT r.question_id, date(r.run_ts) d, m.mentioned, COALESCE(m.competitors,'[]') competitors, q.tags
  FROM runs r
  JOIN (
    SELECT question_id, model, date(run_ts) d, MAX(id) mid
    FROM runs GROUP BY question_id, model, date(run_ts)
  ) k ON k.mid = r.id
  JOIN mentions m ON m.run_id = r.id AND m.brand = $brand
  JOIN questions q ON q.id = r.question_id
  WHERE r.error IS NULL
    AND date(r.run_ts) > date('now', '-14 day')
    AND (r.model NOT IN ('google-aio','google-ai-mode') OR r.serp_state = 'answer')
    AND q.tags NOT LIKE '%cat:company%'
`).all({ $brand: BRAND_NAME.toLowerCase() }) as Row[];

const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
const inCurrent = (r: Row) => r.d > weekAgo;

function shares(sel: Row[]): { n: number; shares: Record<string, number> } {
  const out: Record<string, number> = { [BRAND]: 0 };
  for (const c of COMPETITORS) out[c] = 0;
  for (const r of sel) {
    if (r.mentioned) out[BRAND]++;
    let comps: string[] = [];
    try { comps = JSON.parse(r.competitors); } catch {}
    for (const c of comps) out[c] = (out[c] ?? 0) + 1;
  }
  const n = sel.length;
  for (const k of Object.keys(out)) out[k] = n === 0 ? 0 : (100 * out[k]) / n;
  return { n, shares: out };
}

interface Scope {
  rows: number;
  prevRows: number;
  brand: {
    share: number; prevShare: number;
    rank: number | null; prevRank: number | null;
    move: number | null; // prevRank - rank; positive = climbed
  };
  top: { brand: string; share: number; prevShare: number; rank: number | null }[];
}

function scope(sel: Row[]): Scope {
  const cur = shares(sel.filter(inCurrent));
  const prv = shares(sel.filter((r) => !inCurrent(r)));
  const ranked = rankBrands(cur.shares);
  const prevRanked = rankBrands(prv.shares);
  const prevRankOf = new Map(prevRanked.map((b) => [b.brand, b.rank]));
  const prevShareOf = new Map(prevRanked.map((b) => [b.brand, b.share]));
  const me = ranked.find((b) => b.brand === BRAND)!;
  const mePrevRank = prevRankOf.get(BRAND) ?? null;
  const round = (v: number) => Number(v.toFixed(1));
  return {
    rows: cur.n,
    prevRows: prv.n,
    brand: {
      share: round(me.share),
      prevShare: round(prevShareOf.get(BRAND) ?? 0),
      rank: me.rank,
      prevRank: mePrevRank,
      move: me.rank !== null && mePrevRank !== null ? mePrevRank - me.rank : null
    },
    top: ranked
      .filter((b) => b.rank !== null)
      .slice(0, 8)
      .map((b) => ({
        brand: b.brand,
        share: round(b.share),
        prevShare: round(prevShareOf.get(b.brand) ?? 0),
        rank: b.rank
      }))
  };
}

const overall = scope(rows);

const themes = [...new Set(rows.map((r) => themeOf(r.tags)).filter((t): t is string => !!t))].sort();
const byTheme = themes
  .map((theme) => ({ theme, ...scope(rows.filter((r) => themeOf(r.tags) === theme)) }))
  .filter((t) => t.rows + t.prevRows > 0);

// Prio breakout only when the tags exist at all - an untagged bank is
// expected, not an error.
const prios = [...new Set(rows.map((r) => prioOf(r.tags)).filter((p): p is number => p !== null))].sort();
const byPrio = prios.map((prio) => ({ prio, ...scope(rows.filter((r) => prioOf(r.tags) === prio)) }));

const out = {
  generatedAt: new Date().toISOString(),
  windowDays: 7,
  note: "share = % of clean latest-row non-branded answers naming the brand; rank is competition-style over brands with share > 0; move = prevRank - rank (positive = climbed).",
  overall,
  byTheme,
  byPrio
};
await Bun.write(OUT_PATH, JSON.stringify(out, null, 2));

// --- compact table -----------------------------------------------------------

const fmtMove = (m: number | null) => (m === null ? "  new" : m === 0 ? "    •" : m > 0 ? ` ▲ +${m}` : `  ▼ ${m}`);
const s = overall.brand;
console.log(
  `visibility rank: ${BRAND} #${s.rank ?? "—"} at ${s.share}% (prev #${s.prevRank ?? "—"} at ${s.prevShare}%,${fmtMove(s.move)}) over ${overall.rows} answers`
);
for (const b of overall.top) {
  console.log(
    `  #${String(b.rank).padStart(2)} ${b.brand.padEnd(14)} ${String(b.share.toFixed(1)).padStart(5)}%  (prev ${b.prevShare.toFixed(1)}%)${b.brand === BRAND ? ` <- ${BRAND}` : ""}`
  );
}
for (const t of byTheme) {
  const ts = t.brand;
  console.log(
    `  theme ${t.theme.padEnd(14)} ${BRAND} #${ts.rank ?? "—"} at ${String(ts.share.toFixed(1)).padStart(5)}%${fmtMove(ts.move)}  (${t.rows} answers)`
  );
}
if (byPrio.length === 0) console.log("  (no prio: tags in the bank yet - prio breakout skipped)");
else for (const p of byPrio) {
  console.log(`  prio:${p.prio}  ${BRAND} #${p.brand.rank ?? "—"} at ${p.brand.share}%${fmtMove(p.brand.move)}  (${p.rows} answers)`);
}
console.log(`-> ${OUT_PATH}`);
