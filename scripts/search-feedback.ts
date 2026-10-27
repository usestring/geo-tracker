// Search Console feedback loop. Turns the latest GSC pull into action lists
// for the content work and the weekly review, so the next page, or the next
// refresh, starts from what searchers actually did:
//
//   lowCtr       pages with real impressions and a click rate far under their
//                position -> title/description and intent fix, not a new page
//   nearPage1    non-branded queries sitting at position 8-20 -> strengthen the
//                page that already ranks (sections, internal links, answer)
//   losing       pages whose clicks or impressions fell 30%+ vs the pull 7+
//                days earlier -> refresh in place
//   newQueries   non-branded queries absent from that earlier pull and from the
//                question bank -> intents nobody targeted on purpose
//   wrongIntent  a query split across 2+ of your URLs (cannibalisation), or a
//                non-branded category query served by the homepage -> one
//                canonical page
//   deadPages    pages still earning 100+ impressions that no longer return
//                2xx/3xx (e.g. a page flipped back to draft: true)
//
// Reads:  data/gsc/daily/{queries,pages,query-pages}-*.csv (newest = current,
//         written by `bun scripts/gsc.ts <mode> --daily`), falling back to the
//         weekly files in data/gsc/; the comparison pull is the newest weekly
//         data/gsc/{queries,pages}-*.csv dated 7+ days before the current one.
//         data/geo.db questions (bank match for newQueries).
// Writes: data/search-feedback.json. Prints one SUMMARY line for whatever
//         posts the daily tracker message. Read-only against GSC; one HEAD
//         request per page on your own domain with 100+ impressions.
//
// Brand and category words come from .env:
//   BRAND_NAME, BRAND_DOMAIN, BRAND_ALIASES   a query naming any of these is
//                                             branded and skipped
//   SEARCH_BRANDED_TERMS   extra branded spellings, comma-separated (common
//                          typos of your name, for example)
//   SEARCH_CATEGORY_TERMS  words that name your category, comma-separated.
//                          A homepage-served query counts as wrong intent only
//                          when it contains one of these; otherwise it is
//                          most likely a brand typo and the homepage is right.
//                          Unset, every non-branded homepage query counts.
//
// Thresholds live here and nowhere else.

import { join } from "node:path";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { BRAND_DOMAIN, BRAND_MARKERS, isOwnDomain } from "./brand.ts";

const MIN_PAGE_IMPR = 200;       // lowCtr floor
const LOW_CTR = 0.02;            // lowCtr: under 2% ...
const LOW_CTR_MAX_POS = 10;      // ... while ranking on page one
const NEAR_POS: [number, number] = [8, 20];
const NEAR_MIN_IMPR = 20;
const LOSS = 0.3;                // losing: 30%+ drop
const LOSS_MIN_PREV_IMPR = 100;
const NEW_MIN_IMPR = 10;
const SPLIT_SHARE = 0.15;        // wrongIntent: 2nd URL holds 15%+ of the query's impressions
const SPLIT_MIN_IMPR = 30;
const DEAD_MIN_IMPR = 100;
const TOP = 15;                  // rows kept per list
const listEnv = (key: string) =>
  (process.env[key] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Any query carrying the brand name, the domain, an alias, or a listed typo is
// branded: those resolve to the homepage by design.
const brandTerms = [...new Set([...BRAND_MARKERS, BRAND_DOMAIN.split(".")[0], ...listEnv("SEARCH_BRANDED_TERMS")])]
  .filter(Boolean)
  .map(escapeRe);
const BRANDED = new RegExp(`\\b(${brandTerms.join("|")})s?\\b`, "i");
// A homepage-served query is a wrong-intent case only when it names the
// category; otherwise it is a brand typo and the homepage is the right answer.
const categoryTerms = listEnv("SEARCH_CATEGORY_TERMS").map(escapeRe);
const CATEGORY = categoryTerms.length ? new RegExp(categoryTerms.join("|"), "i") : null;
const LOSS_MIN_PREV_CLICKS = 5;  // a click-rate drop counts only from 5+ clicks

const GSC = join(import.meta.dir, "..", "data", "gsc");
const DAILY = join(GSC, "daily");

type Row = Record<string, string | number>;
function parseCsv(path: string): Row[] {
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  const rows: string[][] = [];
  let cur: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { cur.push(cell); cell = ""; }
    else if (c === "\n") { cur.push(cell); rows.push(cur); cur = []; cell = ""; }
    else cell += c;
  }
  cur.push(cell); rows.push(cur);
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, /^(clicks|impressions|ctr|position)$/.test(h) ? Number(r[i]) : r[i]])));
}

const stampOf = (f: string) => f.match(/(\d{8})\.csv$/)?.[1] ?? "";
const toDate = (s: string) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
function files(dir: string, base: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => new RegExp(`^${base}-\\d{8}\\.csv$`).test(f)).sort().map((f) => join(dir, f));
}
function current(base: string): string | undefined {
  const all = [...files(DAILY, base), ...files(GSC, base)].sort((a, b) => stampOf(a).localeCompare(stampOf(b)));
  return all.at(-1);
}
function prior(base: string, curStamp: string): string | undefined {
  const cutoff = toDate(curStamp).getTime() - 7 * 864e5;
  return files(GSC, base).filter((f) => toDate(stampOf(f)).getTime() <= cutoff).at(-1);
}

const curPages = current("pages"), curQueries = current("queries"), curQP = current("query-pages");
if (!curPages || !curQueries) { console.error("no GSC pull found - run `make gsc` or `make gsc-daily` first"); process.exit(1); }
const curStamp = stampOf(curPages);
const prevPages = prior("pages", curStamp), prevQueries = prior("queries", curStamp);

const pages = parseCsv(curPages), queries = parseCsv(curQueries);
const qp = curQP ? parseCsv(curQP) : [];
const pPages = new Map((prevPages ? parseCsv(prevPages) : []).map((r) => [String(r.page), r]));
const pQueries = new Set((prevQueries ? parseCsv(prevQueries) : []).map((r) => String(r.query)));

// query -> your URLs serving it, by impressions
const byQuery = new Map<string, Row[]>();
for (const r of qp) { const k = String(r.query); (byQuery.get(k) ?? byQuery.set(k, []).get(k)!).push(r); }
for (const v of byQuery.values()) v.sort((a, b) => Number(b.impressions) - Number(a.impressions));
const topPage = (q: string) => byQuery.get(q)?.[0]?.page ?? null;
const hostOf = (u: unknown) => { try { return new URL(String(u)).hostname; } catch { return ""; } };
const isHome = (u: unknown) => {
  try {
    const url = new URL(String(u));
    return url.hostname.replace(/^www\./, "") === BRAND_DOMAIN && (url.pathname === "/" || url.pathname === "");
  } catch { return false; }
};

// bank match: a query "is in the bank" when 60%+ of its content words appear in one question
const STOP = new Set("a an the to for of in on and or is are with how what which best vs do does can i my from by".split(" "));
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
let bank: string[][] = [];
try {
  const db = new Database(join(import.meta.dir, "..", "data", "geo.db"), { readonly: true });
  db.exec("PRAGMA busy_timeout = 30000");
  bank = (db.query("SELECT text FROM questions WHERE active = 1").all() as { text: string }[]).map((r) => words(r.text));
  db.close();
} catch { /* bank match is a nice-to-have; newQueries still lists without it */ }
const inBank = (q: string) => {
  const w = words(q);
  if (w.length === 0) return false;
  return bank.some((b) => w.filter((x) => b.includes(x)).length / w.length >= 0.6);
};

const lowCtr = pages
  .filter((r) => Number(r.impressions) >= MIN_PAGE_IMPR && Number(r.position) <= LOW_CTR_MAX_POS && Number(r.ctr) < LOW_CTR)
  .sort((a, b) => Number(b.impressions) - Number(a.impressions))
  .slice(0, TOP)
  .map((r) => ({ page: r.page, impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, position: r.position, fix: "title + description to the searcher's words; check the page answers the query in paragraph one" }));

const nearPage1 = queries
  .filter((r) => !BRANDED.test(String(r.query)) && Number(r.position) >= NEAR_POS[0] && Number(r.position) <= NEAR_POS[1] && Number(r.impressions) >= NEAR_MIN_IMPR)
  .sort((a, b) => Number(b.impressions) - Number(a.impressions))
  .slice(0, TOP)
  .map((r) => ({ query: r.query, impressions: r.impressions, position: r.position, page: topPage(String(r.query)), fix: "add the section this query asks for, link to the page from 2+ related pages, tighten the answer" }));

const losing = pages
  .map((r) => ({ r, p: pPages.get(String(r.page)) }))
  .filter(({ p }) => p && Number(p.impressions) >= LOSS_MIN_PREV_IMPR)
  .map(({ r, p }) => ({
    page: r.page,
    clicks: r.clicks, prevClicks: p!.clicks,
    impressions: r.impressions, prevImpressions: p!.impressions,
    drop: Math.max(
      Number(p!.clicks) >= LOSS_MIN_PREV_CLICKS ? 1 - Number(r.clicks) / Number(p!.clicks) : 0,
      1 - Number(r.impressions) / Number(p!.impressions),
    ),
  }))
  .filter((x) => x.drop >= LOSS)
  .sort((a, b) => Number(b.prevImpressions) - Number(a.prevImpressions))
  .slice(0, TOP)
  .map((x) => ({ ...x, drop: Number(x.drop.toFixed(2)), fix: "refresh in place: same URL, new material content, re-check the intent" }));

// Pages that vanished from the current pull entirely also count as losing.
for (const [url, p] of pPages) {
  if (losing.length >= TOP) break;
  if (Number(p.impressions) >= LOSS_MIN_PREV_IMPR && !pages.some((r) => r.page === url))
    losing.push({ page: url, clicks: 0, prevClicks: p.clicks, impressions: 0, prevImpressions: p.impressions, drop: 1, fix: "page left the index or the pull: check it still returns 200" });
}

const newQueries = prevQueries
  ? queries
      .filter((r) => !BRANDED.test(String(r.query)) && Number(r.impressions) >= NEW_MIN_IMPR && !pQueries.has(String(r.query)))
      .sort((a, b) => Number(b.impressions) - Number(a.impressions))
      .map((r) => ({ query: r.query, impressions: r.impressions, position: r.position, page: topPage(String(r.query)), inBank: inBank(String(r.query)) }))
      .filter((r) => !r.inBank)
      .slice(0, TOP)
  : [];

const wrongIntent: any[] = [];
for (const [q, rows] of byQuery) {
  const total = rows.reduce((s, r) => s + Number(r.impressions), 0);
  if (BRANDED.test(q) || total < SPLIT_MIN_IMPR) continue;
  if (rows.length >= 2 && Number(rows[1].impressions) / total >= SPLIT_SHARE)
    wrongIntent.push({ query: q, impressions: total, kind: "split", pages: rows.slice(0, 3).map((r) => ({ page: r.page, impressions: r.impressions, position: r.position })), fix: "pick the canonical page; link the other to it and cut the duplicate section" });
  else if (isHome(rows[0].page) && (!CATEGORY || CATEGORY.test(q)))
    wrongIntent.push({ query: q, impressions: total, kind: "homepage", pages: [{ page: rows[0].page, impressions: rows[0].impressions, position: rows[0].position }], fix: "no dedicated page ranks: point an existing page at it, or queue one" });
}
wrongIntent.sort((a, b) => b.impressions - a.impressions).splice(TOP);

const deadPages: any[] = [];
for (const r of pages.filter((r) => Number(r.impressions) >= DEAD_MIN_IMPR && isOwnDomain(hostOf(r.page)))) {
  try {
    const res = await fetch(String(r.page), { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (res.status >= 400) deadPages.push({ page: r.page, status: res.status, impressions: r.impressions, clicks: r.clicks, fix: "restore the page or 301 it to the page that owns the intent" });
  } catch (e) {
    deadPages.push({ page: r.page, status: "fetch failed", impressions: r.impressions, clicks: r.clicks });
  }
}

const out = {
  generatedAt: new Date().toISOString(),
  current: curStamp,
  comparedWith: prevPages ? stampOf(prevPages) : null,
  queryPagesPull: curQP ? stampOf(curQP) : null,
  note: "lists feed the content work (new pages and refreshes) and the weekly review. Thresholds at the top of scripts/search-feedback.ts.",
  lowCtr, nearPage1, losing, newQueries, wrongIntent, deadPages,
};
const path = join(import.meta.dir, "..", "data", "search-feedback.json");
writeFileSync(path, JSON.stringify(out, null, 2));

const siteRe = new RegExp(`^https?://(www\\.)?${escapeRe(BRAND_DOMAIN)}`);
const short = (u: unknown) => String(u).replace(siteRe, "") || "/";
const top =
  deadPages[0] ? `dead ${short(deadPages[0].page)} (${deadPages[0].status}, ${deadPages[0].impressions} impr)` :
  lowCtr[0] ? `${short(lowCtr[0].page)} ${lowCtr[0].impressions} impr at ${(Number(lowCtr[0].ctr) * 100).toFixed(1)}% CTR, pos ${lowCtr[0].position}` :
  nearPage1[0] ? `"${nearPage1[0].query}" pos ${nearPage1[0].position}` : "none";
console.log(`wrote ${path} (current ${curStamp}, compared with ${out.comparedWith ?? "nothing - no pull 7+ days older"}${curQP ? "" : ", no query-pages pull so wrongIntent is empty"})`);
console.log(`SUMMARY: search: ${nearPage1.length} near page 1 · ${lowCtr.length} low CTR · ${losing.length} losing · ${newQueries.length} new queries · ${wrongIntent.length} wrong intent · ${deadPages.length} dead · top: ${top}`);
