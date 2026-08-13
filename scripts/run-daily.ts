// Daily runner: every active question through each
// configured provider, once per day, raw answers + citations stored as runs
// rows. Providers with no key are skipped and reported - the script is
// runnable before any key exists (`--dry-run` lists what it would do).
//
// Bias protocol (project description): stateless API calls only, from a
// dedicated org. No account memory, no personalization. Personas, when they
// arrive, are prompt prefixes - never account state.
//
// Google AI Overviews / AI Mode have no API; both are fetched as logged-out
// SERPs through String's own Web Access API (rotating residential IPs, fresh
// session, US). That fetch path is also the "we run AEO on our own product"
// story - never swap it for a direct crawler.
//
// Not scheduled anywhere yet. Cron comes later (GitHub Actions or feeds
// infra); until then a human runs `make run` or `make dry-run`.

import { Database } from "bun:sqlite";
import { join } from "node:path";

const DB_PATH = join(import.meta.dir, "..", "data", "geo.db");
const DRY_RUN = process.argv.includes("--dry-run");
// --failed-today: re-run only (question, model) pairs whose attempts today ALL
// failed. Old failure rows stay (failures visible); the dashboard reads the
// latest row per pair per day.
const FAILED_TODAY = process.argv.includes("--failed-today");
// --core: run only the daily-core subset (tags tier:daily, ~50 questions). The
// full bank runs weekly. Same tiering idea the app surfaces already use, moved
// up to the API pass so daily engine cost stays ~5x lower at a 200-question bank.
const CORE_ONLY = process.argv.includes("--core");

interface ProviderAnswer {
  answerText: string;
  citations: string[];
}

type Adapter = (question: string) => Promise<ProviderAnswer>;

// --- transient-failure retry ------------------------------------------------
// Providers shed load under burst: Gemini answers 503 UNAVAILABLE on model
// demand spikes and 429 on per-minute caps (the paid tier still has RPM
// limits), and the String SERP path returns intermittent 502s. One attempt per
// pass logged all of those as failures that only a manual `make retry` could
// clear, so retry the transient statuses in-pass instead. Anything else - 400,
// 401, 403, 404 - is a real error and still throws on the first response.
//
// Retries are per-request and additive to the per-provider pacing below; a
// pass that exhausts them still writes an error row (failures stay visible).

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 3000;
const MAX_BACKOFF_MS = 30000;

// Returns the final Response - including a failed one once attempts run out,
// so each adapter keeps throwing its own `${provider} ${status}: ${body}`
// message and the error strings already in the DB stay parseable.
async function fetchRetrying(label: string, url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null;
    let networkError: unknown = null;
    try {
      res = await fetch(url, init);
    } catch (error) {
      networkError = error; // DNS/TLS/socket drops are transient too
    }

    if (res && (res.ok || !RETRY_STATUSES.has(res.status))) return res;
    if (attempt >= MAX_ATTEMPTS) {
      if (res) return res;
      throw new Error(`${label} network error after ${attempt} attempts: ${networkError}`);
    }

    // Honour Retry-After when the provider sends one, else exponential with
    // jitter so parallel-ish retries do not resynchronise into a new burst.
    const retryAfter = res ? Number(res.headers.get("retry-after")) : NaN;
    const wait =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, MAX_BACKOFF_MS)
        : Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS) + Math.random() * 1000;
    const because = res ? `${res.status}` : "network error";
    console.log(
      `  retry ${label} ${attempt + 1}/${MAX_ATTEMPTS} after ${because}, waiting ${Math.round(wait / 1000)}s`
    );
    await Bun.sleep(wait);
  }
}

// --- provider adapters ------------------------------------------------------
// Each returns {answerText, citations[]}. Endpoints and shapes verified
// against provider docs as of Jul 2026; expect drift, keep adapters thin.

const openaiAdapter: Adapter = async (question) => {
  const res = await fetchRetrying("openai", "https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.2",
      tools: [{ type: "web_search" }],
      input: question
    })
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as any;
  const messages = (body.output ?? []).filter((o: any) => o.type === "message");
  const texts = messages.flatMap((m: any) => m.content ?? []).filter((c: any) => c.type === "output_text");
  const answerText = texts.map((t: any) => t.text).join("\n");
  const citations = texts
    .flatMap((t: any) => t.annotations ?? [])
    .filter((a: any) => a.type === "url_citation")
    .map((a: any) => a.url);
  return { answerText, citations: [...new Set(citations)] as string[] };
};

const anthropicAdapter: Adapter = async (question) => {
  const res = await fetchRetrying("anthropic", "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 2048,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      messages: [{ role: "user", content: question }]
    })
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as any;
  const textBlocks = (body.content ?? []).filter((b: any) => b.type === "text");
  const answerText = textBlocks.map((b: any) => b.text).join("\n");
  const citations = textBlocks
    .flatMap((b: any) => b.citations ?? [])
    .filter((c: any) => c.url)
    .map((c: any) => c.url);
  return { answerText, citations: [...new Set(citations)] as string[] };
};

const perplexityAdapter: Adapter = async (question) => {
  const res = await fetchRetrying("perplexity", "https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "sonar",
      messages: [{ role: "user", content: question }]
    })
  });
  if (!res.ok) throw new Error(`perplexity ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as any;
  return {
    answerText: body.choices?.[0]?.message?.content ?? "",
    citations: body.citations ?? []
  };
};

const geminiAdapter: Adapter = async (question) => {
  const res = await fetchRetrying(
    "gemini",
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${process.env.GOOGLE_AI_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: question }] }],
        tools: [{ google_search: {} }]
      })
    }
  );
  if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as any;
  const candidate = body.candidates?.[0];
  const answerText = (candidate?.content?.parts ?? []).map((p: any) => p.text ?? "").join("\n");
  const citations = (candidate?.groundingMetadata?.groundingChunks ?? [])
    .map((c: any) => c.web?.uri)
    .filter(Boolean);
  return { answerText, citations: [...new Set(citations)] as string[] };
};

// The Google SERP adapter that used to live here is gone as of
// Aug 12, 2026. It fetched a logged-out SERP through the Web Access API with
// executeJS and stored the raw HTML for scripts/serp.ts to parse. Both surfaces
// it served now run on the hosted CDP browser instead, because a single snapshot
// cannot see an answer that streams in after load:
//   google-ai-mode  moved Aug 10 (97% shells)
//   google-aio      moved Aug 12 (6 of 6 spot-checked questions false-negative)
// Both live in scripts/surfaces/ and run from scripts/run-apps.ts.

const PROVIDERS: { model: string; keyEnv: string; adapter: Adapter }[] = [
  { model: "gpt", keyEnv: "OPENAI_API_KEY", adapter: openaiAdapter },
  { model: "claude", keyEnv: "ANTHROPIC_API_KEY", adapter: anthropicAdapter },
  { model: "perplexity", keyEnv: "PERPLEXITY_API_KEY", adapter: perplexityAdapter },
  { model: "gemini", keyEnv: "GOOGLE_AI_API_KEY", adapter: geminiAdapter }
  // google-aio retired from this runner Aug 12, for the same reason AI Mode was
  // retired on Aug 10: AI Overviews stream in after load, so the fetch snapshot
  // read the page before the answer existed and scored the early read as a real
  // absence. Six of six spot-checked questions were false negatives, and the
  // surface had reported a 0.0 mean citation count every day for a week.
  // It now runs on the hosted CDP browser:
  //   bun scripts/run-apps.ts --only=google-aio [--core]
  // Measurements and the parser post-mortem are in surfaces/google-aio.mjs.
  // google-ai-mode retired from this runner Aug 10: AI Mode streams its answer
  // in after page load, so the fetch snapshot caught a shell 97% of the time
  // (median 546 chars of text out of 435KB of HTML, zero provider names). The
  // API's `actions` wait path hangs on google.com URLs specifically — reported
  // to eng. The measurement now runs as a Playwright surface:
  //   bun scripts/run-apps.ts --only=google-ai-mode
  // daily, from the scheduled routine, writing the same model value.
];

// --- run --------------------------------------------------------------------

const db = new Database(DB_PATH);
const questions = db
  .query(
    `SELECT id, text FROM questions WHERE active = 1${CORE_ONLY ? " AND tags LIKE '%tier:daily%'" : ""} ORDER BY id`
  )
  .all() as { id: number; text: string }[];

const configured = PROVIDERS.filter((p) => process.env[p.keyEnv]);
const skipped = PROVIDERS.filter((p) => !process.env[p.keyEnv]);

console.log(
  `${questions.length} active questions x ${configured.length} providers` +
    (skipped.length > 0 ? ` (skipping ${skipped.map((p) => `${p.model}: no ${p.keyEnv}`).join(", ")})` : "")
);

if (DRY_RUN) {
  console.log("dry run - no calls made, nothing stored");
  process.exit(0);
}
if (configured.length === 0) {
  console.error("no provider keys configured; see .env.example");
  process.exit(1);
}

const insertRun = db.prepare(
  "INSERT INTO runs (question_id, model, run_ts, raw_answer, citations, error) VALUES (?, ?, ?, ?, ?, ?)"
);
const bumpDomain = db.prepare(`
  INSERT INTO domains (domain, first_seen, citation_count) VALUES (?, ?, 1)
  ON CONFLICT(domain) DO UPDATE SET citation_count = citation_count + 1
`);

// Pairs eligible for --failed-today: every attempt today errored.
const failedPairs = new Set<string>(
  FAILED_TODAY
    ? (
        db
          .query(
            `SELECT DISTINCT question_id, model FROM runs r1
             WHERE date(run_ts) = date('now') AND error IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM runs r2
                 WHERE r2.question_id = r1.question_id AND r2.model = r1.model
                   AND date(r2.run_ts) = date('now') AND r2.error IS NULL
               )`
          )
          .all() as { question_id: number; model: string }[]
      ).map((p) => `${p.question_id}|${p.model}`)
    : []
);
if (FAILED_TODAY) console.log(`retrying ${failedPairs.size} failed pairs from today`);

let failures = 0;
for (const question of questions) {
  for (const { model, adapter } of configured) {
    if (FAILED_TODAY && !failedPairs.has(`${question.id}|${model}`)) continue;
    const ts = new Date().toISOString();
    try {
      const { answerText, citations } = await adapter(question.text);
      insertRun.run(question.id, model, ts, answerText, JSON.stringify(citations), null);
      for (const url of citations) {
        try {
          bumpDomain.run(new URL(url).hostname.replace(/^www\./, ""), ts);
        } catch {
          // unparseable citation URL - keep the run, skip the ledger bump
        }
      }
      console.log(`ok   q${question.id} ${model} (${citations.length} citations)`);
    } catch (error) {
      failures++;
      insertRun.run(question.id, model, ts, null, null, String(error));
      console.log(`FAIL q${question.id} ${model}: ${error}`);
    }
    // Gemini paid tier still rate-limits; pace it win or lose so a pass never
    // 429-storms. Applied once here rather than in both branches.
    await Bun.sleep(model === "gemini" ? 7000 : 500);
  }
}

console.log(`done. failures logged as rows: ${failures}`);
