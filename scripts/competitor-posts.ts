// Competitor posts the answer engines reward.
//
// Ranks the exact competitor pages the engines cite, and how often the answer
// that cites a page also names the competitor who wrote it. Groups those pages
// by the search intent they answer, matches each intent to your own page
// (live, drafted, queued, or none), and orders everything by the either-list
// priority in lib/competitor-posts.ts.
//
// One ranking, one source: the dashboard card and anything that picks the
// next page to write read data/competitor-posts.json. None of them re-derives
// this from the database.
//
// Data hygiene: latest row per question x model x day; API surfaces plus
// google-aio rows where Google actually showed an answer; google-ai-mode
// excluded (its browser-path citations undercount); discovery questions only
// (cat:company and validation/sentiment/market-perception rows excluded).
// bySurface shows each surface's share per page, so a surface that read zero
// citations for part of the window is visible.
//
// Your own pages come from two places:
//   - your sitemap (SITE_SITEMAP, default BRAND_DOMAIN/sitemap.xml)
//     -> status "live"
//   - an optional content queue (CONTENT_QUEUE_PATH), a markdown table whose
//     rows read | # | Draft date | Page | Kind | Slug | Bank q | Benchmark | Status |
//     -> status "drafted" or "queued" (Status starting "queued" or "skipped"
//     keeps that meaning; anything else counts as drafted)

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  intentKey, isNearIntent, normalizeUrl, ownerIn, pageTypeOf, rankEitherList, slugAnswersIntent, slugTokens, type PageType
} from "./lib/competitor-posts.ts";
import { BRAND_NAME, BRAND_SITE, isOwnDomain } from "./brand.ts";

const DB_PATH = join(import.meta.dir, "..", "data", "geo.db");
const OUT_PATH = join(import.meta.dir, "..", "data", "competitor-posts.json");
const QUEUE_PATH = process.env.CONTENT_QUEUE_PATH ?? "";
const SITEMAP_URL = process.env.SITE_SITEMAP ?? `${BRAND_SITE}/sitemap.xml`;
const WINDOW_DAYS = 28;
const SURFACES = ["gpt", "claude", "perplexity", "gemini", "google-aio"];
const NON_DISCOVERY = /cat:company|type:(validation|sentiment|market-perception)/;
const CONTENT_TYPES: PageType[] = ["article", "comparison", "docs"];

const db = new Database(DB_PATH, { readonly: true });
// Wait on a locked database instead of throwing SQLITE_BUSY: a review run,
// extract and a tracker pass can overlap on the same file.
db.run("PRAGMA busy_timeout = 30000");
const end = (db.query("SELECT date(max(run_ts)) d FROM runs").get() as { d: string | null }).d;
if (!end) { console.error("competitor-posts: no runs in the database"); process.exit(1); }
const shift = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const start = shift(end, -(WINDOW_DAYS - 1));
const prevStart = shift(start, -WINDOW_DAYS);
const prevEnd = shift(start, -1);

interface Row { id: number; model: string; qid: number; tags: string; citations: string | null; competitors: string | null; d: string }
const rows = db.query(`
  WITH latest AS (
    SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.question_id, r.model, date(r.run_ts) ORDER BY r.run_ts DESC) rn
    FROM runs r WHERE date(r.run_ts) BETWEEN ?1 AND ?2
  )
  SELECT l.id, l.model, l.question_id qid, q.tags, l.citations, m.competitors, date(l.run_ts) d
  FROM latest l JOIN questions q ON q.id = l.question_id
  LEFT JOIN mentions m ON m.run_id = l.id AND m.brand = ?3
  WHERE l.rn = 1 AND l.error IS NULL
    AND (l.model IN ('gpt','claude','perplexity','gemini') OR (l.model = 'google-aio' AND l.serp_state = 'answer'))
`).all(prevStart, end, BRAND_NAME.toLowerCase()) as Row[];

const cls = new Map<string, string>();
for (const r of db.query("SELECT domain, classification FROM domains").all() as { domain: string; classification: string }[]) {
  cls.set(r.domain, r.classification);
}
const qText = new Map<number, string>();
for (const q of db.query("SELECT id, text FROM questions").all() as { id: number; text: string }[]) qText.set(q.id, q.text);
const themeOf = (tags: string) => tags.match(/theme:([a-z-]+)/)?.[1] ?? "other";
const parse = (s: string | null): string[] => { try { const v = JSON.parse(s ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };

// Every competitor name the extractor recorded in the window. An owner outside
// this set is "not tracked", and its mention count is unknown rather than zero.
// A prior window with less data than the current one cannot carry a trend.
const prevDays = new Set(rows.filter((r) => r.d < start).map((r) => r.d)).size;
const curDays = new Set(rows.filter((r) => r.d >= start).map((r) => r.d)).size;
const prevComplete = prevDays >= Math.floor(curDays * 0.8);

const trackedNames = new Set<string>();
for (const r of rows) if (r.d >= start) for (const n of parse(r.competitors)) trackedNames.add(n);
const trackedList = [...trackedNames];

interface Agg {
  url: string; host: string; registrable: string; path: string; cls: string; pageType: PageType;
  owner: string | null; rows: Set<number>; mentionRows: Set<number>; prevRows: Set<number>;
  qids: Set<number>; qCounts: Map<number, number>; surfaces: Record<string, number>; themes: Record<string, number>;
}
const agg = new Map<string, Agg>();
const ownCitedQ = new Set<number>();
const discoveryQ = new Set<number>();
let usableRows = 0;

for (const r of rows) {
  if (NON_DISCOVERY.test(r.tags)) continue;
  const current = r.d >= start;
  if (current) { usableRows++; discoveryQ.add(r.qid); }
  const comps = parse(r.competitors);
  const seen = new Set<string>();
  for (const raw of parse(r.citations)) {
    const n = normalizeUrl(raw);
    if (!n) continue;
    if (isOwnDomain(n.host)) { if (current) ownCitedQ.add(r.qid); continue; }
    const c = cls.get(n.host) ?? cls.get(n.registrable) ?? "";
    if (c !== "competitor-owned" && c !== "affiliate-benchmark") continue;
    if (seen.has(n.key)) continue;
    seen.add(n.key);
    let e = agg.get(n.key);
    if (!e) {
      e = {
        url: "https://" + n.key, host: n.host, registrable: n.registrable, path: n.path, cls: c,
        pageType: pageTypeOf(n.host, n.path), owner: ownerIn(n.registrable, trackedList),
        rows: new Set(), mentionRows: new Set(), prevRows: new Set(), qids: new Set(), qCounts: new Map(), surfaces: {}, themes: {}
      };
      agg.set(n.key, e);
    }
    if (!current) { e.prevRows.add(r.id); continue; }
    e.rows.add(r.id);
    e.qids.add(r.qid);
    e.qCounts.set(r.qid, (e.qCounts.get(r.qid) ?? 0) + 1);
    e.surfaces[r.model] = (e.surfaces[r.model] ?? 0) + 1;
    const t = themeOf(r.tags);
    e.themes[t] = (e.themes[t] ?? 0) + 1;
    if (e.owner && ownerIn(n.registrable, comps)) e.mentionRows.add(r.id);
  }
}

const topQuestion = (counts: Map<number, number>, lost: number[]) => {
  const pool = lost.length ? lost : [...counts.keys()];
  return pool.reduce((best, q) => ((counts.get(q) ?? 0) > (counts.get(best) ?? 0) ? q : best), pool[0]);
};
const lostOf = (qids: Iterable<number>) => [...qids].filter((q) => !ownCitedQ.has(q)).sort((a, b) => a - b);

// --- your own pages: live (sitemap), then drafted/queued (queue file) --------

interface OwnPage { status: "live" | "drafted" | "queued" | "none" | "unknown"; slug?: string; url?: string; queueRow?: number; note?: string }
const live: { slug: string; url: string }[] = [];
let sitemapOk = false;
try {
  const res = await fetch(SITEMAP_URL, { signal: AbortSignal.timeout(10000) });
  if (res.ok) {
    for (const m of (await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const u = m[1].trim();
      const s = new URL(u).pathname.split("/").filter(Boolean).pop();
      if (s) live.push({ slug: s, url: u });
    }
    sitemapOk = live.length > 0;
  }
} catch { /* offline: statuses fall back to the queue file, and "none" becomes "unknown" */ }

const queued: { slug: string; row: number; status: string }[] = [];
if (QUEUE_PATH && existsSync(QUEUE_PATH)) {
  for (const line of readFileSync(QUEUE_PATH, "utf8").split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    // | # | Draft date | Page | Kind | Slug | Bank q | Benchmark | Status |
    if (cells.length < 10 || !/^\d+$/.test(cells[1])) continue;
    queued.push({ row: Number(cells[1]), slug: cells[5], status: cells[8] });
  }
}

// Your pages that share words with an intent without answering it outright.
// "best web scraping tools" is not a "best-web-scraping-apis" slug, but it may
// be the same search intent; that needs a human call before you draft.
function nearOwnPages(tokens: string[], competitorPath: string) {
  const near = [
    ...live.map((p) => ({ slug: p.slug, status: "live" })),
    ...queued.map((r) => ({ slug: r.slug, status: r.status.startsWith("queued") ? "queued" : r.status.startsWith("skipped") ? "skipped" : "drafted" }))
  ].filter((p) => !slugAnswersIntent(p.slug, tokens) && isNearIntent(p.slug, competitorPath));
  return [...new Map(near.map((p) => [p.slug, p])).values()].slice(0, 5);
}

function ownPageFor(tokens: string[]): OwnPage {
  const liveHit = live.filter((p) => slugAnswersIntent(p.slug, tokens))
    .sort((a, b) => slugTokens(b.slug).length - slugTokens(a.slug).length)[0];
  if (liveHit) return { status: "live", slug: liveHit.slug, url: liveHit.url };
  const q = queued.filter((r) => slugAnswersIntent(r.slug, tokens));
  const drafted = q.find((r) => !r.status.startsWith("queued") && !r.status.startsWith("skipped"));
  if (drafted) return { status: "drafted", slug: drafted.slug, queueRow: drafted.row, note: drafted.status.slice(0, 120) };
  const waiting = q.find((r) => r.status.startsWith("queued"));
  if (waiting) return { status: "queued", slug: waiting.slug, queueRow: waiting.row };
  return { status: sitemapOk ? "none" : "unknown" };
}

// --- per-page ranking ----------------------------------------------------------

const pageRecord = (e: Agg) => {
  const lost = lostOf(e.qids);
  return {
    url: e.url, domain: e.registrable, owner: e.owner, ownerTracked: e.owner !== null,
    pageType: e.pageType, intent: intentKey(e.path),
    citations: e.rows.size, prevCitations: e.prevRows.size,
    mentions: e.owner ? e.mentionRows.size : null,
    mentionRate: e.owner && e.rows.size ? Math.round((100 * e.mentionRows.size) / e.rows.size) : null,
    questions: e.qids.size, lostQuestions: lost.length, lostQids: lost,
    bySurface: e.surfaces, byTheme: e.themes
  };
};
const current = [...agg.values()].filter((e) => e.rows.size > 0);
const posts = rankEitherList(current.filter((e) => e.cls === "competitor-owned").map(pageRecord)).slice(0, 50);
const affiliatePosts = [...current.filter((e) => e.cls === "affiliate-benchmark").map(pageRecord)]
  .sort((a, b) => b.citations - a.citations).slice(0, 25);

// --- intents: competitor content pages grouped by what they answer ------------

interface IntentAgg { key: string; members: Agg[]; rows: Set<number>; mentionRows: Set<number>; prevRows: Set<number>; qids: Set<number>; qCounts: Map<number, number>; anyTracked: boolean }
const intents = new Map<string, IntentAgg>();
for (const e of current) {
  if (e.cls !== "competitor-owned" || !CONTENT_TYPES.includes(e.pageType)) continue;
  const key = intentKey(e.path);
  if (!key) continue;
  const g = intents.get(key) ?? { key, members: [], rows: new Set(), mentionRows: new Set(), prevRows: new Set(), qids: new Set(), qCounts: new Map(), anyTracked: false };
  g.members.push(e);
  for (const id of e.rows) g.rows.add(id);
  for (const id of e.mentionRows) g.mentionRows.add(id);
  for (const id of e.prevRows) g.prevRows.add(id);
  for (const q of e.qids) g.qids.add(q);
  for (const [q, n] of e.qCounts) g.qCounts.set(q, (g.qCounts.get(q) ?? 0) + n);
  g.anyTracked ||= e.owner !== null;
  intents.set(key, g);
}
const intentRanked = rankEitherList([...intents.values()].map((g) => {
  const tokens = g.key.split(" ");
  const members = [...g.members].sort((a, b) => b.rows.size - a.rows.size);
  const lost = lostOf(g.qids);
  const surfaces: Record<string, number> = {};
  for (const m of members) for (const [s, n] of Object.entries(m.surfaces)) surfaces[s] = (surfaces[s] ?? 0) + n;
  return {
    intent: g.key,
    label: members[0].path.split("/").filter(Boolean).pop() ?? g.key,
    citations: g.rows.size, prevCitations: g.prevRows.size,
    mentions: g.anyTracked ? g.mentionRows.size : null,
    questions: g.qids.size, lostQuestions: lost.length, lostQids: lost,
    // The question this topic wins most often, preferring one you lose.
    sampleQuestion: qText.get(topQuestion(g.qCounts, lost)) ?? "",
    owners: [...new Set(members.map((m) => m.owner ?? m.registrable))],
    topUrl: members[0].url,
    urls: members.slice(0, 6).map((m) => ({ url: m.url, owner: m.owner ?? m.registrable, citations: m.rows.size, mentions: m.owner ? m.mentionRows.size : null })),
    bySurface: surfaces,
    ownPage: ownPageFor(tokens),
    nearOwnPages: nearOwnPages(tokens, members[0].path)
  };
})).slice(0, 30);

const out = {
  generatedAt: new Date().toISOString(),
  window: { from: start, to: end, days: WINDOW_DAYS },
  prevWindow: { from: prevStart, to: prevEnd, daysWithData: prevDays, complete: prevComplete },
  currentDaysWithData: curDays,
  method: {
    surfaces: SURFACES,
    rows: "latest row per question x model x day; error-free; google-aio only where Google showed an AI answer; google-ai-mode excluded",
    questions: "discovery only: cat:company and type:validation/sentiment/market-perception excluded",
    citations: "answers that cite the page (one answer counts once per page)",
    mentions: "citing answers that also name the page's owner, from mentions.competitors; null when the extractor does not track the owner",
    priority: "better of citation rank and mention rank; ties go to more citations",
    intents: "competitor article, comparison and docs pages grouped by slug tokens; home, pricing and account pages excluded",
    ownPage: "live = a slug in your sitemap answers the intent; drafted/queued = a row in CONTENT_QUEUE_PATH; unknown = sitemap unreachable",
    nearOwnPages: "your slugs with the same template (best/alternatives/vs/how-to) sharing half their words; check the intent before drafting"
  },
  usableRows, discoveryQuestions: discoveryQ.size, ownCitedQuestions: ownCitedQ.size,
  sitemapChecked: sitemapOk, queueChecked: queued.length > 0,
  intents: intentRanked, posts, affiliatePosts
};
await Bun.write(OUT_PATH, JSON.stringify(out, null, 1));

console.log(`competitor-posts: ${OUT_PATH} (${start}..${end}, ${usableRows} answers, ${posts.length} posts, ${intentRanked.length} intents)`);
for (const i of intentRanked.slice(0, 10)) {
  console.log(`  #${i.priority} ${i.label}: ${i.citations} cites, ${i.mentions ?? "n/a"} mentions, ${i.lostQuestions} lost q, own page ${i.ownPage.status}${i.ownPage.slug ? " (" + i.ownPage.slug + ")" : ""}`);
}
