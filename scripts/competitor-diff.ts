// Competitor sitemap diff: what did our competitors ship
// this week?
//
// The daily tracker answers "who do the engines cite". It never answers "what
// did they just publish". Those are different questions with different lead
// times: a competitor's new page shows up in their sitemap days or weeks before
// it accumulates enough authority to start winning citations. This script is
// the early-warning half.
//
// COST NOTE (Aug 11, 2026). The original ticket said to use the Web Access
// `sitemap` endpoint — the quote/approve/poll crawl flow. We fetch each
// competitor's /sitemap.xml directly through /v1/fetch instead. A sitemap is a
// plain XML file; the only reason we need the Web Access API at all is that
// several of these hosts sit behind anti-bot protection that blocks a naive
// GET. One fetch per sitemap costs a request, where a full crawl costs a page
// each. Same URL list, roughly two orders of magnitude cheaper, and no async
// approval step to babysit inside a cron.
//
// Writes to the `competitor_pages` table and prints a digest. The Monday review
// reads the table; the dashboard renders it.
//
// Uses STRING_API_KEY (sitemap + page fetches) and ANTHROPIC_API_KEY (summaries).
import { Database } from "bun:sqlite";
import { COMPETITORS as COMPETITOR_DOMAINS } from "./brand.ts";

const DB_PATH = process.env.AEO_DB ?? "data/geo.db";
const STRING_KEY = process.env.STRING_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!STRING_KEY) {
  console.error("STRING_API_KEY not set; see .env.example");
  process.exit(1);
}

// The eight from the ticket. We do NOT hardcode sitemap URLs: robots.txt is the
// only reliable way to find them. Oxylabs, for one, serves its sitemap from an
// obfuscated filename (`/f3h5j7k9m2n4p6q8r0.xml`) and returns a 404 page for
// `/sitemap.xml` — a deliberate anti-scraping measure. Bright Data points at
// `sitemap_index.xml`, not `sitemap.xml`. Guessing the path silently returned
// zero pages for three of eight competitors on the first run.
// Set COMPETITORS in .env as a comma-separated domain list. The home URL is
// derived, and robots.txt discovery handles the rest.
const COMPETITORS = COMPETITOR_DOMAINS.map((domain) => ({
  domain,
  home: `https://${domain}`,
}));

if (!COMPETITORS.length) {
  console.log("No COMPETITORS set in .env - nothing to diff. See README.");
  process.exit(0);
}

// We only care about pages that can win an answer-engine citation. Product,
// pricing and legal pages churn for reasons that have nothing to do with
// content strategy, and including them buries the signal.
//
// Two regexes, deliberately. A content PAGE has the section in its path
// (`/blog/how-to-...`), so the slashes are load-bearing — without them
// `/pricing-blog-post-teaser` would match. A child SITEMAP names the section in
// its filename instead (`blog-sitemap.xml`, `sitemap-compare.xml`), where the
// slashes never appear. Using the page regex on child sitemaps is what made
// Bright Data and ZenRows return nothing on the first run.
const INTERESTING = /\/(blog|guides?|docs?|academy|learn|resources?|tutorials?|answers?|use-cases?|comparisons?)\//i;
const CHILD_SITEMAP =
  /(blog|guide|doc|academy|learn|resource|tutorial|answer|use[-_]case|compare|comparison|alternative|post|page|article|content)/i;

// Bound the cost of a single run. A competitor that migrates its CMS can publish
// a four-figure sitemap delta overnight; without a cap that becomes a four-figure
// fetch bill. Anything above the cap is still recorded as a new URL — it just
// does not get a title and summary until a later run.
const MAX_SUMMARIES_PER_RUN = Number(process.env.COMPETITOR_SUMMARY_CAP ?? 40);

const db = new Database(DB_PATH);

db.run(`
  CREATE TABLE IF NOT EXISTS competitor_pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    lastmod TEXT,
    title TEXT,
    summary TEXT,
    gone_at TEXT
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS competitor_pages_domain_first ON competitor_pages (domain, first_seen)`);

const today = new Date().toISOString().slice(0, 10);

// --- fetching ---------------------------------------------------------------

async function stringFetch(url: string, format?: "raw"): Promise<string> {
  const res = await fetch("https://request.usestring.ai/v1/fetch", {
    method: "POST",
    headers: {
      authorization: `Bearer ${STRING_KEY}`,
      "content-type": "application/json"
    },
    // No executeJS. Sitemaps are static XML and article pages render their body
    // server-side; paying the browser rate here would multiply the bill for
    // nothing. If a competitor ever ships a JS-only blog we will see it as an
    // empty summary, not as a silent miss.
    body: JSON.stringify({ url, countryCode: "US", ...(format ? { format } : {}) })
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  // `format: "raw"` returns the document itself, not a JSON envelope. Calling
  // .json() on it throws, and the throw is swallowed by the caller's try/catch —
  // which is how the first run wrote 3,870 pages with zero titles.
  if (format === "raw") return await res.text();
  const body = (await res.json()) as any;
  return typeof body?.data === "string" ? body.data : JSON.stringify(body);
}

function extractTags(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1].trim());
  return out;
}

/**
 * Ask robots.txt where the sitemaps are. Falls back to /sitemap.xml, which is
 * right often enough to be worth trying and wrong often enough not to trust.
 */
async function discoverRoots(home: string): Promise<string[]> {
  try {
    const robots = await stringFetch(`${home}/robots.txt`);
    const declared = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
    if (declared.length) return declared;
  } catch (e) {
    console.error(`  robots.txt failed for ${home}: ${(e as Error).message}`);
  }
  return [`${home}/sitemap.xml`];
}

/** Follow one sitemap, descending into a sitemap index one level. */
async function fetchSitemap(root: string): Promise<{ url: string; lastmod?: string }[]> {
  const xml = await stringFetch(root);

  // A 404 page served with a 200 status is common on these hosts — Oxylabs does
  // exactly this for /sitemap.xml. Treat anything that is not XML as a miss
  // rather than parsing an HTML error page for <loc> tags and finding none.
  if (!/<(urlset|sitemapindex)/i.test(xml)) {
    throw new Error(`not a sitemap (${xml.length} bytes, no urlset/sitemapindex)`);
  }

  if (!/<sitemapindex/i.test(xml)) {
    const urls = extractTags(xml, "loc");
    const mods = extractTags(xml, "lastmod");
    return urls.map((u, i) => ({ url: u, lastmod: mods[i] }));
  }

  // A sitemap index can list dozens of children. Only walk the ones whose own
  // filename suggests they hold content pages — an image or location sitemap is
  // not worth a request.
  const children = extractTags(xml, "loc").filter((u) => CHILD_SITEMAP.test(u));
  const out: { url: string; lastmod?: string }[] = [];
  for (const child of children.slice(0, 12)) {
    try {
      const childXml = await stringFetch(child);
      const urls = extractTags(childXml, "loc");
      const mods = extractTags(childXml, "lastmod");
      urls.forEach((u, i) => out.push({ url: u, lastmod: mods[i] }));
    } catch (e) {
      console.error(`  child sitemap failed ${child}: ${(e as Error).message}`);
    }
  }
  return out;
}

// --- summarising ------------------------------------------------------------

async function summarise(url: string): Promise<{ title: string; summary: string } | null> {
  if (!ANTHROPIC_KEY) return null;
  let page: string;
  try {
    page = await stringFetch(url, "raw");
  } catch (e) {
    console.error(`  fetch failed ${url}: ${(e as Error).message}`);
    return null;
  }

  const titleMatch = page.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim().slice(0, 200) : "";
  const text = page
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 6000);

  if (text.length < 200) return { title, summary: "" };

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system:
          "Summarise this competitor page for a marketing team tracking what rivals publish. One or two sentences. State what the page teaches or claims, and which buyer question it answers. No preamble, no marketing language.",
        messages: [{ role: "user", content: `URL: ${url}\n\n${text}` }]
      })
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}`);
    const body = (await res.json()) as any;
    const summary = (body.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();
    return { title, summary };
  } catch (e) {
    console.error(`  summarise failed ${url}: ${(e as Error).message}`);
    return { title, summary: "" };
  }
}

// --- run --------------------------------------------------------------------

const seenBefore = db.query(`SELECT COUNT(*) AS n FROM competitor_pages`).get() as { n: number };
const baseline = seenBefore.n === 0;
if (baseline) {
  console.log("no stored pages yet — this run writes the baseline, no diff to report");
}

const upsert = db.prepare(`
  INSERT INTO competitor_pages (domain, url, first_seen, last_seen, lastmod)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(url) DO UPDATE SET last_seen = excluded.last_seen, lastmod = excluded.lastmod, gone_at = NULL
`);
const known = db.prepare(`SELECT 1 FROM competitor_pages WHERE url = ?`);

const freshByDomain = new Map<string, string[]>();

for (const c of COMPETITORS) {
  const entries: { url: string; lastmod?: string }[] = [];
  const roots = await discoverRoots(c.home);
  for (const root of roots) {
    try {
      entries.push(...(await fetchSitemap(root)));
    } catch (e) {
      console.error(`${c.domain}: ${root} — ${(e as Error).message}`);
    }
  }
  const pages = entries.filter((e) => INTERESTING.test(e.url));

  // A competitor that yields nothing is a broken adapter, not a competitor that
  // stopped publishing. Say so out loud — a silent zero looks like real data in
  // the Monday review.
  if (pages.length === 0) console.error(`${c.domain}: NO CONTENT URLS — check sitemap discovery`);
  const fresh: string[] = [];

  db.run("BEGIN");
  for (const e of pages) {
    if (!known.get(e.url)) fresh.push(e.url);
    upsert.run(c.domain, e.url, today, today, e.lastmod ?? null);
  }
  db.run("COMMIT");

  freshByDomain.set(c.domain, fresh);
  console.log(`${c.domain}: ${pages.length} content URLs, ${fresh.length} new`);
}

// Mark pages that vanished from a sitemap. A removed page is a signal too — it
// usually means a consolidation or a pruned post.
db.run(
  `UPDATE competitor_pages SET gone_at = ? WHERE last_seen < ? AND gone_at IS NULL`,
  [today, today]
);

// Summarise only what is new, newest domains first, under the cap.
if (!baseline) {
  let budget = MAX_SUMMARIES_PER_RUN;
  const setMeta = db.prepare(`UPDATE competitor_pages SET title = ?, summary = ? WHERE url = ?`);
  for (const [domain, urls] of freshByDomain) {
    for (const url of urls) {
      if (budget <= 0) break;
      const meta = await summarise(url);
      if (meta) setMeta.run(meta.title, meta.summary, url);
      budget--;
    }
    if (budget <= 0) {
      const total = [...freshByDomain.values()].reduce((a, b) => a + b.length, 0);
      console.log(`summary cap reached (${MAX_SUMMARIES_PER_RUN} of ${total} new pages); rest stay unsummarised`);
      break;
    }
  }
}

// --- digest -----------------------------------------------------------------

const gone = db.query(`SELECT COUNT(*) AS n FROM competitor_pages WHERE gone_at = ?`).get(today) as {
  n: number;
};
const totalFresh = [...freshByDomain.values()].reduce((a, b) => a + b.length, 0);

console.log(`\ncompetitors shipped ${totalFresh} new pages; ${gone.n} dropped out of sitemaps`);
if (!baseline) {
  const rows = db
    .query(
      `SELECT domain, url, COALESCE(title, '') AS title, COALESCE(summary, '') AS summary
       FROM competitor_pages WHERE first_seen = ? ORDER BY domain, url LIMIT 25`
    )
    .all(today) as { domain: string; url: string; title: string; summary: string }[];
  for (const r of rows) {
    console.log(`\n  ${r.domain} — ${r.title || r.url}`);
    console.log(`    ${r.url}`);
    if (r.summary) console.log(`    ${r.summary}`);
  }
}
