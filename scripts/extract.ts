// Extraction pass: turn raw runs rows into mentions + classified
// domains. Two models:
//   - Haiku reads every unprocessed successful run and answers: is String
//     mentioned, at what shortlist position, with what sentiment, and which
//     competitors appear.
//   - Sonnet classifies NEW citation domains into the ledger enum, once,
//     cached forever (domains.classification).
//
// Idempotent: only runs rows with no mentions row yet, only domains still
// 'unclassified'. Safe to run after every daily run or in bulk.
//
// Uses ANTHROPIC_API_KEY from the same .env as run-daily.ts.

import { Database } from "bun:sqlite";
import { runBatch, type BatchRequest } from "./anthropic-batch";
import { join } from "node:path";
import { parseSerp } from "./serp.ts";
import { BRAND_NAME, BRAND_DOMAIN, BRAND_MARKERS, isOwnDomain } from "./brand.ts";

const DB_PATH = join(import.meta.dir, "..", "data", "geo.db");
const BRAND = BRAND_NAME.toLowerCase();
const NO_BATCH = process.argv.includes("--no-batch");

// How much of an answer the mentions pass reads. Lowered from 24,000 after
// measuring on our own data: 12% of calls were hitting the old cap and carried
// 46% of all input characters, and zero rows had their only brand or
// competitor mention past 8,000 characters. Run that check on your own stored
// answers before lowering it further.
const MENTION_MAX_CHARS = 8000;

const SERP_MODELS = new Set(["google-aio", "google-ai-mode"]);
// Display names the mention pass looks for when it reports "who else was in
// this answer". Set COMPETITOR_NAMES in .env; without it the pass still runs
// and simply reports no competitors.
const COMPETITORS = (process.env.COMPETITOR_NAMES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY) {
  console.error("ANTHROPIC_API_KEY not set; see .env.example");
  process.exit(1);
}

async function anthropic(model: string, system: string, user: string, maxTokens = 1024): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }]
    })
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as any;
  return (body.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
}

// Pull the first JSON object out of a model reply (tolerates prose around it).
function parseJson(text: string): any {
  const cleaned = text.replace(/```(?:json)?/g, "");
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`no JSON in reply: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

// Same, but salvages a reply that ran out of output tokens mid-object. A
// truncated classification batch used to throw away every pair in it, including
// the complete ones before the cut.
function parseJsonSalvaging(text: string): Record<string, string> {
  try {
    return parseJson(text);
  } catch {
    const pairs: Record<string, string> = {};
    for (const m of text.matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)) pairs[m[1]] = m[2];
    if (Object.keys(pairs).length === 0) throw new Error(`no JSON in reply: ${text.slice(0, 200)}`);
    return pairs;
  }
}

const db = new Database(DB_PATH);
// Wait on a locked database instead of throwing SQLITE_BUSY: a review run,
// extract and a tracker pass can overlap on the same file.
db.run("PRAGMA busy_timeout = 30000");

// --- 0. migrations (idempotent) ----------------------------------------------

const runColumns = (db.query("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name);
if (!runColumns.includes("serp_state")) {
  // "answer" | "unavailable" | "shell" for the two Google surfaces, null elsewhere.
  db.run("ALTER TABLE runs ADD COLUMN serp_state TEXT");
  console.log("migration: added runs.serp_state");
}

const domainsDdl =
  (db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='domains'").get() as { sql: string } | null)?.sql ?? "";
if (!domainsDdl.includes("'own'")) {
  // SQLite cannot alter a CHECK constraint, so rebuild the table. 'own' keeps our
  // properties in the ledger (own-domain citation share is worth trending) while
  // excluding them from outreach targets and competitor counts.
  db.run("BEGIN");
  db.run(`CREATE TABLE domains_new (
  domain TEXT PRIMARY KEY,
  classification TEXT CHECK (classification IN (
    'legit-publisher', 'affiliate-benchmark', 'astroturf',
    'competitor-owned', 'forum', 'docs', 'own', 'unclassified'
  )) DEFAULT 'unclassified',
  first_seen TEXT NOT NULL,
  citation_count INTEGER NOT NULL DEFAULT 0
)`);
  db.run("INSERT INTO domains_new SELECT domain, classification, first_seen, citation_count FROM domains");
  db.run("DROP TABLE domains");
  db.run("ALTER TABLE domains_new RENAME TO domains");
  db.run("COMMIT");
  console.log("migration: domains.classification now allows 'own'");
}

const ownFixed = db
  .query("SELECT domain FROM domains WHERE classification != 'own'")
  .all()
  .filter((d: any) => isOwnDomain(d.domain)) as { domain: string }[];
if (ownFixed.length > 0) {
  const setOwn = db.prepare("UPDATE domains SET classification = 'own' WHERE domain = ?");
  for (const d of ownFixed) setOwn.run(d.domain);
  console.log(`own domains reclassified: ${ownFixed.map((d) => d.domain).join(", ")}`);
}

// --- 0b. SERP parse ------------------------------------------------
// The Google surfaces store a fetch envelope holding rendered HTML. Turn it into
// a state, citations, and (when there is one) the AI answer text.

const unparsedSerp = db
  .query(
    `SELECT id, model, raw_answer FROM runs
     WHERE model IN ('google-aio', 'google-ai-mode')
       AND error IS NULL AND raw_answer IS NOT NULL AND serp_state IS NULL
     ORDER BY id`
  )
  .all() as { id: number; model: string; raw_answer: string }[];

// Shared by the SERP parse (0b) and redirect resolution (0c) below.
const bumpDomain = db.prepare(`
  INSERT INTO domains (domain, first_seen, citation_count) VALUES (?, ?, 1)
  ON CONFLICT(domain) DO UPDATE SET citation_count = citation_count + 1
`);

if (unparsedSerp.length > 0) {
  const setSerp = db.prepare("UPDATE runs SET serp_state = ?, citations = ? WHERE id = ?");
  const counts: Record<string, number> = { answer: 0, unavailable: 0, shell: 0 };
  for (const row of unparsedSerp) {
    const parsed = parseSerp(row.raw_answer, row.model);
    counts[parsed.state]++;
    // Citations only exist when Google actually showed an AI answer. A SERP
    // with no AI Overview still has outbound organic links, and storing those
    // as citations contaminated the citation mix (found Aug 10: 72 of 80 AIO
    // rows were 'unavailable' yet contributed 1,128 fake citations — a third
    // of the weekly mix).
    const citations = parsed.state === "answer" ? parsed.citations : [];
    setSerp.run(parsed.state, JSON.stringify(citations), row.id);
    for (const url of citations) {
      try {
        bumpDomain.run(new URL(url).hostname.replace(/^www\./, ""), new Date().toISOString());
      } catch {
        // Unparseable URL, skip.
      }
    }
  }
  console.log(
    `serp: ${unparsedSerp.length} parsed - ${counts.answer} with an AI answer, ` +
      `${counts.unavailable} where Google showed none, ${counts.shell} unrendered`
  );
}

// --- 0c. Gemini grounding redirects ------------------------------------------
// Gemini cites through vertexaisearch.cloud.google.com/grounding-api-redirect/
// tokens, which hide every real destination from the citation mix and the
// domain ledger (found Aug 10: 453 opaque citations in one week). The tokens
// expire within days — resolve them here, same-day, while they still redirect.
// Unresolvable ones are left in place; rows older than 3 days are skipped so a
// dead token is not retried forever.
const REDIRECT_MARKER = "vertexaisearch.cloud.google.com/grounding-api-redirect";
const redirectRows = db
  .query(
    `SELECT id, citations FROM runs
     WHERE error IS NULL AND citations LIKE '%${REDIRECT_MARKER}%'
       AND run_ts >= datetime('now', '-3 days')`
  )
  .all() as { id: number; citations: string }[];

if (redirectRows.length > 0) {
  const cache = new Map<string, string | null>();
  const resolveOne = async (url: string): Promise<string | null> => {
    if (cache.has(url)) return cache.get(url)!;
    let final: string | null = null;
    try {
      const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(8000) });
      if (res.url && !res.url.includes(REDIRECT_MARKER)) final = res.url;
    } catch {
      // token expired or endpoint refused — keep the opaque URL
    }
    cache.set(url, final);
    return final;
  };

  const setCitations = db.prepare("UPDATE runs SET citations = ? WHERE id = ?");
  let resolved = 0, kept = 0;
  for (const row of redirectRows) {
    let urls: string[];
    try { urls = JSON.parse(row.citations); } catch { continue; }
    const out: string[] = [];
    for (const u of urls) {
      if (!u.includes(REDIRECT_MARKER)) { out.push(u); continue; }
      const final = await resolveOne(u);
      if (final) {
        out.push(final);
        resolved++;
        try {
          bumpDomain.run(new URL(final).hostname.replace(/^www\./, ""), new Date().toISOString());
        } catch { /* unparseable — skip the ledger bump */ }
      } else {
        out.push(u);
        kept++;
      }
    }
    setCitations.run(JSON.stringify(out), row.id);
  }
  console.log(`redirects: ${resolved} resolved to real domains, ${kept} still opaque (expired or refused)`);
}

// --- 1. mentions (Haiku) -----------------------------------------------------

// BRAND_DISAMBIGUATION exists because some product names are also ordinary
// words. Without a hint the pass counts every casual use of the word and the
// mention rate is meaningless. Example: "the word 'string' is also a common
// programming term - only count the product."
const DISAMBIGUATION = process.env.BRAND_DISAMBIGUATION
  ? ` ${process.env.BRAND_DISAMBIGUATION}`
  : "";

const MENTION_SYSTEM = `You analyze answer-engine output for brand monitoring. The brand is "${BRAND_NAME}" (${BRAND_DOMAIN}).${DISAMBIGUATION} Reply with ONLY a JSON object:
{"mentioned": true|false, "position": <int or null>, "sentiment": "positive"|"neutral"|"negative"|"inaccurate"|null, "competitors": ["..."]}
- mentioned: does the answer name the ${BRAND_NAME} product (or cite ${BRAND_DOMAIN})?
- position: if the answer is a list/shortlist of providers and ${BRAND_NAME} appears, its 1-based rank; else null.
- sentiment: only when mentioned; "inaccurate" if the answer states something false about ${BRAND_NAME}.
- competitors: ${
  COMPETITORS.length
    ? `which of these appear (exact names from this list only): ${COMPETITORS.join(", ")}.`
    : `always return an empty array (no competitor list is configured).`
}`;

// Shell rows are excluded: a page that never rendered is a fetch problem, not a
// measurement, and scoring it as "String not mentioned" would quietly pad the
// denominator with rows that could not have mentioned anything.
const unprocessed = db
  .query(
    `SELECT r.id, r.model, r.raw_answer, r.citations, r.serp_state FROM runs r
     LEFT JOIN mentions m ON m.run_id = r.id AND m.brand = ?
     WHERE r.error IS NULL AND r.raw_answer IS NOT NULL AND m.id IS NULL
       AND (r.serp_state IS NULL OR r.serp_state != 'shell')
     ORDER BY r.id`
  )
  .all(BRAND) as {
  id: number;
  model: string;
  raw_answer: string;
  citations: string;
  serp_state: string | null;
}[];

const insertMention = db.prepare(
  "INSERT INTO mentions (run_id, brand, mentioned, position, sentiment, competitors) VALUES (?, ?, ?, ?, ?, ?)"
);

console.log(`${unprocessed.length} runs to extract`);
let extracted = 0;
let extractFailures = 0;

// Split the work first: rows that need no model call are settled here, and the
// rest are collected so they go out as ONE batch instead of N serial calls.
// Nothing about the prompt changes - only when it is sent.
const pending: { run: (typeof unprocessed)[number]; prompt: string }[] = [];

for (const run of unprocessed) {
  const isSerp = SERP_MODELS.has(run.model);

  // Google showed no AI answer. That is a real negative and needs no model call.
  if (isSerp && run.serp_state === "unavailable") {
    insertMention.run(run.id, BRAND, 0, null, null, "[]");
    extracted++;
    continue;
  }

  // SERP rows from the fetch path hold a JSON envelope; send the extracted
  // answer, not the HTML. Rows from the Playwright surface (google-ai-mode via
  // run-apps) already store plain answer text - those must not go through the
  // envelope parse, which would misread short answers as shells.
  const isEnvelope = isSerp && run.raw_answer.startsWith('{"statusCode"');
  const answer = isEnvelope
    ? parseSerp(run.raw_answer, run.model).answerText
    : run.raw_answer.slice(0, MENTION_MAX_CHARS);
  const cheap = answer.toLowerCase();
  const maybeBrand = BRAND_MARKERS.some((m) => cheap.includes(m));
  const maybeCompetitor = COMPETITORS.some((c) => cheap.includes(c.toLowerCase()));

  if (!maybeBrand && !maybeCompetitor) {
    // Nothing to disambiguate - skip the API call, record the negative.
    insertMention.run(run.id, BRAND, 0, null, null, "[]");
    extracted++;
    continue;
  }

  const surface = isSerp
    ? "The text below is the AI-generated answer Google returned for this query."
    : "The text below is an answer-engine response.";
  pending.push({
    run,
    prompt: `${surface}\n\nCited URLs: ${run.citations || "[]"}\n\n---\n${answer}`
  });
}

const textOf = (message: any): string =>
  (message?.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");

let mentionAnswers = new Map<string, { message?: any; error?: string }>();
if (!NO_BATCH && pending.length > 0) {
  const requests: BatchRequest[] = pending.map(({ run, prompt }) => ({
    custom_id: `r${run.id}`,
    params: {
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: MENTION_SYSTEM,
      messages: [{ role: "user", content: prompt }]
    }
  }));
  mentionAnswers = await runBatch(requests, { label: "mentions" }).catch((error) => {
    console.log(`batch mentions: could not start (${error}); falling back to sync`);
    return new Map<string, { message?: any; error?: string }>();
  });
}

for (const { run, prompt } of pending) {
  try {
    const outcome = mentionAnswers.get(`r${run.id}`);
    // Absent from the map means canceled, expired, or batching was off. Ask the
    // normal way rather than leave a hole in the day.
    const reply = outcome?.message
      ? textOf(outcome.message)
      : await anthropic("claude-haiku-4-5", MENTION_SYSTEM, prompt);
    const parsed = parseJson(reply);
    insertMention.run(
      run.id,
      BRAND,
      parsed.mentioned ? 1 : 0,
      Number.isInteger(parsed.position) ? parsed.position : null,
      parsed.mentioned ? (parsed.sentiment ?? "neutral") : null,
      JSON.stringify(Array.isArray(parsed.competitors) ? parsed.competitors : [])
    );
    extracted++;
  } catch (error) {
    extractFailures++;
    console.error(`extract failed run ${run.id}: ${String(error).slice(0, 160)}`);
  }
}
console.log(`mentions: ${extracted} extracted, ${extractFailures} failed`);

// --- 2. domain classification (Sonnet, new domains only) ----------------------

const CLASSIFY_SYSTEM = `You classify web domains for an AEO citation ledger in the web scraping / web data API market. Classify each domain into exactly one of:
- "legit-publisher": independent editorial or review site (real methodology or journalism)
- "affiliate-benchmark": comparison/listicle site monetized by affiliate links or paid placement
- "astroturf": vendor-run site posing as independent
- "competitor-owned": blog/docs of a scraping-market vendor (Bright Data, Oxylabs, Zyte, Apify, Firecrawl, ScrapingBee, Scrapfly, Scrape.do, Decodo, Nimble, etc.)
- "forum": community content (Reddit, Stack Overflow, HN, Quora)
- "docs": official documentation of a non-competitor product or standard
Reply with ONLY a JSON object mapping each domain to its classification.`;

// A hostname with no letters, or a label that is empty, is a broken URL that
// reached the ledger (e.g. "https://.../" from a malformed source). Sent alone
// it made the classifier reply that no list was given, and the batch failed
// every run, so it is dropped here instead of classified.
const VALID_HOST = /^(?=.*[a-z])[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const dropped = db
  .query("SELECT domain FROM domains WHERE classification = 'unclassified'")
  .all()
  .map((d: any) => d.domain as string)
  .filter((d) => !VALID_HOST.test(d));
if (dropped.length) {
  const del = db.prepare("DELETE FROM domains WHERE domain = ?");
  for (const d of dropped) del.run(d);
  console.log(`domains: dropped ${dropped.length} invalid hostname(s): ${dropped.slice(0, 5).join(", ")}`);
}

const newDomains = (
  db
    .query("SELECT domain FROM domains WHERE classification = 'unclassified' ORDER BY citation_count DESC")
    .all() as { domain: string }[]
).filter((d) => !isOwnDomain(d.domain));

if (newDomains.length > 0) {
  const setClass = db.prepare("UPDATE domains SET classification = ? WHERE domain = ?");
  const valid = new Set([
    "legit-publisher", "affiliate-benchmark", "astroturf", "competitor-owned", "forum", "docs"
  ]);
  // Batch 15 with an 8k cap. The old 25-per-call at 4k ran out of output tokens
  // on long domain names, and the truncated reply threw away the whole batch,
  // including the pairs that had already been emitted before the cut.
  let classified = 0;
  // Groups of 15 go out together as one Message Batch. The grouping is
  // unchanged - only the transport is - so a truncated reply still costs at
  // most the 15 domains in its own group.
  const groups: string[][] = [];
  for (let i = 0; i < newDomains.length; i += 15) {
    groups.push(newDomains.slice(i, i + 15).map((d) => d.domain));
  }

  let classifyAnswers = new Map<string, { message?: any; error?: string }>();
  if (!NO_BATCH && groups.length > 0) {
    const requests: BatchRequest[] = groups.map((batch, i) => ({
      custom_id: `g${i}`,
      params: {
        model: "claude-sonnet-5",
        max_tokens: 8000,
        system: CLASSIFY_SYSTEM,
        messages: [{ role: "user", content: batch.join("\n") }]
      }
    }));
    classifyAnswers = await runBatch(requests, { label: "classify" }).catch((error) => {
      console.log(`batch classify: could not start (${error}); falling back to sync`);
      return new Map<string, { message?: any; error?: string }>();
    });
  }

  for (const [i, batch] of groups.entries()) {
    try {
      const outcome = classifyAnswers.get(`g${i}`);
      const reply = outcome?.message
        ? textOf(outcome.message)
        : await anthropic("claude-sonnet-5", CLASSIFY_SYSTEM, batch.join("\n"), 8000);
      const parsed = parseJsonSalvaging(reply);
      for (const domain of batch) {
        const cls = parsed[domain];
        if (valid.has(cls)) {
          setClass.run(cls, domain);
          classified++;
        }
      }
    } catch (error) {
      console.error(`classify batch failed: ${String(error).slice(0, 160)}`);
    }
  }
  console.log(`domains: ${classified}/${newDomains.length} newly classified`);
} else {
  console.log("domains: none new");
}
