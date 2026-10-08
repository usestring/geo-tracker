// Daily picks: one ranked list of what to write next, across every kind of
// work - a new page, a refresh of a live page, or a queued row. It replaces
// fixed weekday lanes ("Monday is comparisons") with the tracker's own
// evidence of where you lose answers.
//
// A candidate is a bank question you are losing. Its score:
//   lost answers in the last 14 days (runs where you are neither mentioned nor
//   cited) x prio weight (prio:1 = 3, prio:2 = 2, else 1)
//   x coverage weight (content-coverage verdict: missing 1.0, partial 0.6)
// Questions that resolve to the same page slug are summed into one pick, so
// two picks never share an intent. Excluded, never a page: cat:company,
// claim-probe:*, theme:brand (those belong on trust/security pages) and
// variant-of:* (measurement-only rewordings). Answered questions drop out.
//
// Slug resolution, first hit wins:
//   1. CONTENT_QUEUE_PATH  markdown table, one row per planned page:
//        | # | Draft date | Page | Kind | Slug | Bank q | Benchmark | Status |
//      "Bank q" names the questions it answers (q12, q40). Status starts with
//      shipped / drafted / queued; anything else counts as merged.
//   2. CONTENT_DIR   your site's markdown source. A page that answers bank
//      questions carries `bankIds: [12, 40]` in its front matter;
//      `draft: true` marks it drafted.
//   3. DRAFTS_DIR    markdown drafts not yet in CONTENT_DIR, same front matter.
//   4. A page on your own domain that the engines cited for the question in
//      the window.
// No slug = a new page. Before you draft one, check that no live page in the
// sitemap already answers the question.
//
// Reads:  data/geo.db, data/content-coverage.json (`make content-coverage`),
//         your sitemap (SITE_SITEMAP, default https://<BRAND_DOMAIN>/sitemap.xml),
//         plus the optional sources above.
// Writes: data/daily-picks.json. Prints the top picks.

import { join } from "node:path";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { BRAND_DOMAIN, BRAND_NAME, BRAND_SITE, isOwnDomain } from "./brand.ts";

const WINDOW_DAYS = 14;
const TOP = 20;
const PRIO_WEIGHT: Record<string, number> = { "1": 3, "2": 2 };
const VERDICT_WEIGHT: Record<string, number> = { missing: 1, partial: 0.6 };
const EXCLUDE = /(^|;)(cat:company|claim-probe:[^;]*|theme:brand|variant-of:[^;]*)(;|$)/;

const ROOT = join(import.meta.dir, "..");
const QUEUE = process.env.CONTENT_QUEUE_PATH ?? "";
const CONTENT_DIR = process.env.CONTENT_DIR ?? "";
const DRAFTS = process.env.DRAFTS_DIR ?? "";
const SITEMAP_URL = process.env.SITE_SITEMAP ?? `${BRAND_SITE}/sitemap.xml`;

type Status = "shipped" | "live" | "merged" | "drafted" | "queued" | "cited" | "none";
interface Owner { slug: string; status: Status; source: string }

const qids = (s: string) => [...s.matchAll(/\bq(\d+)\b/g)].map((m) => Number(m[1]));
const owners = new Map<number, Owner>();
const claim = (id: number, o: Owner) => { if (!owners.has(id)) owners.set(id, o); };

const frontIds = (text: string) => {
  const m = text.match(/^bankIds:\s*\[([^\]]*)\]/m);
  return m ? m[1].split(",").map((x) => Number(x.trim())).filter(Number.isFinite) : [];
};
const markdownFiles = (dir: string) =>
  (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".md") && !f.split("/").pop()!.startsWith("_"));

// 1. Content queue rows.
if (QUEUE && existsSync(QUEUE)) {
  for (const line of readFileSync(QUEUE, "utf8").split("\n")) {
    const c = line.split("|").map((x) => x.trim());
    if (c.length < 10 || !/^\d+$/.test(c[1])) continue;
    const [, , , , kind, slug, bank, , status] = c;
    if (!slug || !kind) continue;
    const st: Status = status.startsWith("shipped") ? "shipped" : status.startsWith("drafted") ? "drafted" : status.startsWith("queued") ? "queued" : "merged";
    for (const id of qids(bank)) claim(id, { slug, status: st, source: `queue (${status.slice(0, 40)})` });
  }
}

// 2. Pages in your site's source.
if (CONTENT_DIR && existsSync(CONTENT_DIR)) {
  for (const f of markdownFiles(CONTENT_DIR)) {
    const text = readFileSync(join(CONTENT_DIR, f), "utf8").slice(0, 4000);
    const slug = f.replace(/\.md$/, "");
    const draft = /^draft:\s*true/m.test(text);
    for (const id of frontIds(text)) claim(id, { slug, status: draft ? "drafted" : "merged", source: "content dir" });
  }
}

// 3. Drafts not yet in the site source.
if (DRAFTS && existsSync(DRAFTS)) {
  for (const f of markdownFiles(DRAFTS)) {
    const text = readFileSync(join(DRAFTS, f), "utf8").slice(0, 2000);
    const slug = f.split("/").pop()!.replace(/(-v\d+|-refresh-\d+)?\.md$/, "");
    for (const id of frontIds(text)) claim(id, { slug, status: "drafted", source: `drafts/${f}` });
  }
}

// Live sitemap, so merged/shipped slugs report their real state.
const sitemap = new Set<string>();
try {
  const res = await fetch(SITEMAP_URL, { signal: AbortSignal.timeout(20_000) });
  if (res.ok) {
    for (const m of (await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)) {
      try { sitemap.add(new URL(m[1].trim()).pathname.replace(/^\/|\/$/g, "")); } catch { /* bad loc */ }
    }
  }
} catch { /* offline: nothing reads as live */ }
const isLive = (slug: string) => [...sitemap].some((p) => p === slug || p.endsWith(`/${slug}`));

// Tracker window.
const db = new Database(join(ROOT, "data", "geo.db"), { readonly: true });
// Wait on a locked database instead of throwing SQLITE_BUSY: a review run,
// extract and a tracker pass can overlap on the same file.
db.run("PRAGMA busy_timeout = 30000");
const since = new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString();
const questions = db.query("select id, text, tags from questions where active = 1").all() as { id: number; text: string; tags: string }[];
const runs = db.query(`
  select r.question_id as qid, r.citations as citations,
         coalesce(max(case when m.brand = ? then m.mentioned end), 0) as mentioned
  from runs r left join mentions m on m.run_id = r.id
  where r.run_ts >= ? and r.error is null group by r.id`).all(BRAND_NAME.toLowerCase(), since) as { qid: number; citations: string | null; mentioned: number }[];

const ownPath = (u: string): string | null => {
  try {
    const url = new URL(u);
    if (!isOwnDomain(url.hostname)) return null;
    return url.pathname.replace(/^\/|\/$/g, "");
  } catch { return null; }
};

interface Tally { runs: number; lost: number; compCites: number; ownUrls: Map<string, number> }
const tally = new Map<number, Tally>();
for (const r of runs) {
  const t = tally.get(r.qid) ?? { runs: 0, lost: 0, compCites: 0, ownUrls: new Map() };
  let urls: string[] = [];
  try { urls = JSON.parse(r.citations ?? "[]"); } catch { /* bad row */ }
  let ours = 0;
  for (const u of urls) {
    const path = ownPath(u);
    if (path === null) continue;
    ours++;
    if (path) t.ownUrls.set(path, (t.ownUrls.get(path) ?? 0) + 1);
  }
  t.runs++;
  t.compCites += urls.length - ours;
  if (!r.mentioned && ours === 0) t.lost++;
  tally.set(r.qid, t);
}

const covPath = join(ROOT, "data", "content-coverage.json");
if (!existsSync(covPath)) {
  console.error("daily-picks: no data/content-coverage.json - run `make content-coverage` first");
  process.exit(1);
}
const coverage = new Map<number, { verdict: string; gap: string }>();
const cov = JSON.parse(readFileSync(covPath, "utf8"));
for (const q of cov.questions) coverage.set(q.id, { verdict: q.verdict, gap: q.gap });

// Score questions, then group by owner slug.
interface Pick {
  key: string; slug: string | null; status: Status; action: string; score: number;
  lost: number; runs: number; compCites: number; qids: number[]; questions: string[]; gaps: string[]; source: string;
}
const picks = new Map<string, Pick>();
for (const q of questions) {
  if (EXCLUDE.test(q.tags)) continue;
  const c = coverage.get(q.id);
  if (!c || !(c.verdict in VERDICT_WEIGHT)) continue;
  const t = tally.get(q.id);
  if (!t || t.lost === 0) continue;
  const prio = q.tags.match(/prio:(\d)/)?.[1] ?? "3";
  const score = t.lost * (PRIO_WEIGHT[prio] ?? 1) * VERDICT_WEIGHT[c.verdict];

  let owner = owners.get(q.id);
  if (!owner && t.ownUrls.size) {
    const [path] = [...t.ownUrls.entries()].sort((a, b) => b[1] - a[1])[0];
    owner = { slug: path, status: "cited", source: "cited by engines in window" };
  }
  let status: Status = owner?.status ?? "none";
  if (owner && (status === "shipped" || status === "merged" || status === "cited")) status = isLive(owner.slug) ? "live" : status;
  const action =
    owner?.status === "cited" && status === "live" ? `new page or refresh: engines cite /${owner.slug}, decide whether it owns the intent` :
    status === "live" ? "refresh" :
    status === "drafted" ? "publish waiting (do not redraft)" :
    status === "queued" ? "draft queued row" :
    status === "merged" || status === "shipped" ? "deploy waiting (in source, not live)" :
    "new page (check the sitemap for a page that already answers it)";
  const key = owner?.slug ?? `q${q.id}`;
  const p = picks.get(key) ?? { key, slug: owner?.slug ?? null, status, action, score: 0, lost: 0, runs: 0, compCites: 0, qids: [], questions: [], gaps: [], source: owner?.source ?? "" };
  p.score += score; p.lost += t.lost; p.runs += t.runs; p.compCites += t.compCites;
  p.qids.push(q.id); p.questions.push(q.text); if (c.gap) p.gaps.push(`q${q.id}: ${c.gap}`);
  picks.set(key, p);
}

const ranked = [...picks.values()].map((p) => ({ ...p, score: Math.round(p.score) })).sort((a, b) => b.score - a.score || b.compCites - a.compCites);
const draftable = ranked.filter((p) => p.action === "refresh" || p.action.startsWith("new page") || p.action === "draft queued row");
const out = {
  generatedAt: new Date().toISOString(),
  windowDays: WINDOW_DAYS,
  brandDomain: BRAND_DOMAIN,
  note: "score = lost answers (no mention or citation of the brand) x prio weight x coverage weight, summed per owning slug. draftable = refresh, new page or queued row. Waiting rows are reported, not drafted.",
  coverageGeneratedAt: cov.generatedAt,
  sitemapChecked: sitemap.size > 0,
  draftable: draftable.slice(0, TOP),
  waiting: ranked.filter((p) => !draftable.includes(p)).slice(0, TOP),
};
writeFileSync(join(ROOT, "data", "daily-picks.json"), JSON.stringify(out, null, 2) + "\n");

console.log(`daily-picks: ${ranked.length} losing intents, ${draftable.length} draftable (window ${WINDOW_DAYS}d, coverage ${cov.generatedAt}${sitemap.size ? "" : ", sitemap unreachable"})`);
for (const [i, p] of out.draftable.slice(0, 10).entries())
  console.log(`  #${i + 1} [${p.score}] ${p.action}: ${p.slug ?? p.key} · lost ${p.lost}/${p.runs} · q${p.qids.join(",q")} · ${p.questions[0].slice(0, 70)}`);
console.log("  waiting:");
for (const p of out.waiting.slice(0, 5)) console.log(`    [${p.score}] ${p.action}: ${p.slug} · q${p.qids.join(",q")}`);
