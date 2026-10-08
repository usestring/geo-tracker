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
// SERPs through a hosted browser with rotating residential egress (see
// scripts/surfaces/cdp-session.mjs and the README). A plain fetch reads the
// page before the answer exists - never swap this path for a direct crawler.
//
// Scheduling is not in this repo. Run it from cron or a scheduled task;
// `make dry-run` lists what a run would do without spending anything.

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runBatch, type BatchRequest } from "./anthropic-batch";

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
// --force: ask every question again even if it already has a clean answer today.
// Without it a re-run RESUMES, which is what the runbook always claimed this
// script did and what run-apps.ts has done since Aug 10. It did not: a resume
// after a failed pass re-asked every question, so Aug 19 spent 479 engine calls
// on a 200-call day. Resuming is the default; --force is the escape hatch.
const FORCE = process.argv.includes("--force");
// --batch-claude: send the Anthropic surface through the Message Batches API
// at half price. OFF by default, deliberately.
//
// The discount is real and web search is batchable, but a 2-request batch of
// grounded sonnet-4.5 was still processing after 28 minutes on Aug 19 2026,
// against 80 seconds for the same batch size without tools. Batched web search
// is slow enough that the daily pass would routinely sit on the fallback path,
// which costs full price AND the wait. The extract pass has no such problem -
// nothing reads it until the next morning - so that one batches by default.
//
// Turn this on once we have timing data across a few days. The collection code
// below is written and the fallback is proven; only the wall-clock is unknown.
const BATCH_CLAUDE = process.argv.includes("--batch-claude");
// --limit=N: ask only the first N questions. For exercising a code path against
// the real APIs without paying for a whole pass.
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 0);

interface ProviderAnswer {
  answerText: string;
  citations: string[];
  // Which concrete provider model answered. Stored per row so a model swap
  // leaves a visible boundary in the data instead of a silent one.
  modelId?: string;
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

// One definition of the Anthropic request, used by both the sync adapter and
// the batch path. They must not drift: a batched answer and a sync answer have
// to be the same measurement, or the surface stops being comparable with itself.
const ANTHROPIC_MODEL = "claude-sonnet-4-5";
const anthropicParams = (question: string) => ({
  model: ANTHROPIC_MODEL,
  max_tokens: 2048,
  tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
  messages: [{ role: "user", content: question }]
});

// Pull answer text and citations out of an Anthropic message body. Shared for
// the same reason the request shape is.
const readAnthropic = (body: any): ProviderAnswer => {
  const textBlocks = (body.content ?? []).filter((b: any) => b.type === "text");
  const answerText = textBlocks.map((b: any) => b.text).join("\n");
  const citations = textBlocks
    .flatMap((b: any) => b.citations ?? [])
    .filter((c: any) => c.url)
    .map((c: any) => c.url);
  return { answerText, citations: [...new Set(citations)] as string[], modelId: ANTHROPIC_MODEL };
};

const anthropicAdapter: Adapter = async (question) => {
  const res = await fetchRetrying("anthropic", "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify(anthropicParams(question))
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  return readAnthropic(await res.json());
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

// --- gemini model chain -----------------------------------------------------
// `gemini-flash-latest` is an ALIAS, and on Aug 19 2026 it answered 503
// "model is currently experiencing high demand" on 5 of 5 probe calls while
// gemini-3.5-flash answered 3 of 3 on the same key, same second, same grounded
// request. That day's pass lost 21 of 50 questions to the alias, and Aug 17
// and Aug 18 lost 27 and 37.
//
// The alias is two faults at once. It sheds load harder than the pinned models
// behind it, AND Google re-points it without notice - so the surface we measure
// can change with no boundary in the data. That is the google-aio mistake in a
// different costume: a number that keeps flowing while its meaning moves.
//
// So: pin the model, keep an ordered fallback for the demand spikes, and record
// which model actually answered (runs.model_id). `model` stays 'gemini' so the
// dashboard and every trend line keep working.
//
// A fallback candidate MUST ground. gemini-3.1-flash-lite returns HTTP 200 with
// zero groundingChunks, which would land in the DB as "Gemini cited nothing" -
// a false zero, not an outage. Verified grounded on Aug 19 2026:
//   gemini-3.5-flash          3/3 available, 25/16/0 chunks
//   gemini-flash-lite-latest  3/3 available, 10/6/8 chunks
// Override with GEMINI_MODELS=a,b,c to re-test without editing this file.
const GEMINI_MODELS = (process.env.GEMINI_MODELS ?? "gemini-3.5-flash,gemini-flash-lite-latest")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

const geminiAdapter: Adapter = async (question) => {
  let lastRes: Response | null = null;
  for (const modelId of GEMINI_MODELS) {
    const res = await fetchRetrying(
      `gemini(${modelId})`,
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${process.env.GOOGLE_AI_API_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: question }] }],
          tools: [{ google_search: {} }]
        })
      }
    );
    // A hard error (400/401/403/404) is our bug or our key - fail loudly on the
    // first model rather than masking it by walking the chain.
    if (!res.ok && !RETRY_STATUSES.has(res.status)) {
      throw new Error(`gemini ${res.status}: ${await res.text()}`);
    }
    if (!res.ok) {
      lastRes = res;
      if (modelId !== GEMINI_MODELS[GEMINI_MODELS.length - 1]) {
        console.log(`  gemini ${modelId} shed load (${res.status}); falling back`);
      }
      continue;
    }
    const body = (await res.json()) as any;
    const candidate = body.candidates?.[0];
    const answerText = (candidate?.content?.parts ?? []).map((p: any) => p.text ?? "").join("\n");
    const citations = (candidate?.groundingMetadata?.groundingChunks ?? [])
      .map((c: any) => c.web?.uri)
      .filter(Boolean);
    return { answerText, citations: [...new Set(citations)] as string[], modelId };
  }
  throw new Error(`gemini ${lastRes?.status ?? "unknown"}: ${lastRes ? await lastRes.text() : "all models in GEMINI_MODELS shed load"}`);
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
// Wait on a locked database instead of throwing SQLITE_BUSY: a review run,
// extract and a tracker pass can overlap on the same file.
db.run("PRAGMA busy_timeout = 30000");

// Which concrete provider model answered each row. Added Aug 19 2026 with the
// Gemini model chain: `model` stays the surface name ('gemini') so every trend
// line and the dashboard keep working, while `model_id` makes a model swap
// visible instead of silent. Nullable, so every row written before today keeps
// its meaning: "whatever the alias pointed at that day, unrecorded".
const hasModelId = (db.query("PRAGMA table_info(runs)").all() as { name: string }[]).some(
  (c) => c.name === "model_id"
);
if (!hasModelId) {
  db.run("ALTER TABLE runs ADD COLUMN model_id TEXT");
  console.log("schema: added runs.model_id");
}

const questions = db
  .query(
    `SELECT id, text FROM questions WHERE active = 1${CORE_ONLY ? " AND tags LIKE '%tier:daily%'" : ""} ORDER BY id`
  )
  .all() as { id: number; text: string }[];

if (LIMIT > 0) questions.length = Math.min(questions.length, LIMIT);

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
  "INSERT INTO runs (question_id, model, run_ts, raw_answer, citations, error, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
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

// Pairs already answered cleanly today. A plain re-run skips these, so a resume
// after a partial pass costs only the questions that are actually missing.
// --failed-today has its own, narrower filter and ignores this one.
const doneToday = new Set<string>(
  !FAILED_TODAY && !FORCE
    ? (
        db
          .query(
            `SELECT DISTINCT question_id, model FROM runs
             WHERE date(run_ts) = date('now') AND error IS NULL`
          )
          .all() as { question_id: number; model: string }[]
      ).map((p) => `${p.question_id}|${p.model}`)
    : []
);
if (doneToday.size > 0) console.log(`resume: ${doneToday.size} pairs already answered today, skipping them`);

// A demand spike is a wave, not a wall: it lasts minutes, and the in-pass retry
// budget (4 attempts, ~25s) is far shorter than that. Pairs that lose every
// attempt to a TRANSIENT status get one more try after the pass, by which time
// the pass itself has spent 20+ minutes elsewhere. Hard errors are not deferred.
// --- Anthropic batch (half price) --------------------------------------------
// The batch is submitted BEFORE the sync loop and collected after it, so it
// processes while gpt, perplexity and gemini are being asked. On a core day the
// sync half takes ~30 minutes, which is longer than most batches need, so the
// discount usually costs no wall-clock at all.
const batchingClaude =
  BATCH_CLAUDE && configured.some((p) => p.model === "claude") && !!process.env.ANTHROPIC_API_KEY;

const batchQuestions = batchingClaude
  ? questions.filter(
      (q) =>
        !doneToday.has(`${q.id}|claude`) &&
        (!FAILED_TODAY || failedPairs.has(`${q.id}|claude`))
    )
  : [];

let batchPromise: Promise<Map<string, { message?: any; error?: string }>> | null = null;
if (batchQuestions.length > 0) {
  const requests: BatchRequest[] = batchQuestions.map((q) => ({
    custom_id: `q${q.id}`,
    params: anthropicParams(q.text)
  }));
  batchPromise = runBatch(requests, { label: "claude surface" }).catch((error) => {
    // A batch that will not even start is not worth failing the pass over -
    // return nothing and let every question fall through to a sync call.
    console.log(`batch claude surface: could not start (${error}); falling back to sync`);
    return new Map<string, { message?: any; error?: string }>();
  });
}

const TRANSIENT_ERROR = /\b(408|429|500|502|503|504)\b|network error/;
const DEFER_WAIT_MS = Number(process.env.DEFER_WAIT_MS ?? 120000);
const deferred: { question: { id: number; text: string }; model: string; adapter: Adapter }[] = [];

let failures = 0;
let recovered = 0;

async function attempt(
  question: { id: number; text: string },
  model: string,
  adapter: Adapter,
  canDefer: boolean
): Promise<boolean> {
  const ts = new Date().toISOString();
  try {
    const { answerText, citations, modelId } = await adapter(question.text);
    insertRun.run(question.id, model, ts, answerText, JSON.stringify(citations), null, modelId ?? null);
    for (const url of citations) {
      try {
        bumpDomain.run(new URL(url).hostname.replace(/^www\./, ""), ts);
      } catch {
        // unparseable citation URL - keep the run, skip the ledger bump
      }
    }
    console.log(`ok   q${question.id} ${model}${modelId ? ` [${modelId}]` : ""} (${citations.length} citations)`);
    return true;
  } catch (error) {
    insertRun.run(question.id, model, ts, null, null, String(error), null);
    console.log(`FAIL q${question.id} ${model}: ${error}`);
    if (canDefer && TRANSIENT_ERROR.test(String(error))) {
      deferred.push({ question, model, adapter });
    } else {
      failures++;
    }
    return false;
  }
}

for (const question of questions) {
  for (const { model, adapter } of configured) {
    if (FAILED_TODAY && !failedPairs.has(`${question.id}|${model}`)) continue;
    if (doneToday.has(`${question.id}|${model}`)) continue;
    // The Anthropic surface goes through the batch submitted above; only fall
    // through to a live call when batching is off or the batch left it behind.
    if (model === "claude" && batchingClaude) continue;
    await attempt(question, model, adapter, true);
    // Gemini paid tier still rate-limits; pace it win or lose so a pass never
    // 429-storms. Applied once here rather than in both branches.
    await Bun.sleep(model === "gemini" ? 7000 : 500);
  }
}

// Collect the batch, write what came back, and ask anything it left behind the
// normal way. An expired or canceled request is absent from the map, so the
// fallback covers expiry, cancellation and a batch that never started alike.
if (batchPromise) {
  const answers = await batchPromise;
  const claudeProvider = configured.find((p) => p.model === "claude")!;
  let missing = 0;
  for (const question of batchQuestions) {
    const outcome = answers.get(`q${question.id}`);
    const ts = new Date().toISOString();
    if (outcome?.message) {
      const { answerText, citations, modelId } = readAnthropic(outcome.message);
      insertRun.run(question.id, "claude", ts, answerText, JSON.stringify(citations), null, modelId ?? null);
      for (const url of citations) {
        try {
          bumpDomain.run(new URL(url).hostname.replace(/^www\./, ""), ts);
        } catch {
          // unparseable citation URL - keep the run, skip the ledger bump
        }
      }
      console.log(`ok   q${question.id} claude [batch] (${citations.length} citations)`);
    } else {
      missing++;
      await attempt(question, "claude", claudeProvider.adapter, true);
    }
  }
  if (missing > 0) console.log(`batch claude surface: ${missing} fell back to sync`);
}

if (deferred.length > 0) {
  console.log(
    `deferred sweep: ${deferred.length} pairs lost every attempt to a transient status; ` +
      `waiting ${Math.round(DEFER_WAIT_MS / 1000)}s, then one more try each`
  );
  await Bun.sleep(DEFER_WAIT_MS);
  const queue = deferred.splice(0, deferred.length);
  for (const { question, model, adapter } of queue) {
    const ok = await attempt(question, model, adapter, false);
    if (ok) recovered++;
    await Bun.sleep(model === "gemini" ? 7000 : 500);
  }
}

console.log(
  `done. failures logged as rows: ${failures}` +
    (recovered > 0 ? ` (deferred sweep recovered ${recovered})` : "")
);
