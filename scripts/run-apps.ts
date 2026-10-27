// Consumer-app surfaces (the consumer-app work): what a buyer actually sees in the
// ChatGPT and Perplexity apps, as opposed to what the APIs return.
//
// All six existing surfaces measure API or SERP output. The apps can differ:
// different search stack, different system prompts, personalization. This runner
// exists to quantify that gap rather than assume it, and the comparison lands on
// the dashboard as the app-vs-API divergence table.
//
// Writes into the same `runs` table as the daily pass, with model values
// 'chatgpt-app' and 'perplexity-app'. No schema change: model is free text.
//
//   bun scripts/run-apps.ts                 both surfaces, tier-1 questions
//   bun scripts/run-apps.ts --only=perplexity-app
//   bun scripts/run-apps.ts --limit=2 --headed
//   bun scripts/run-apps.ts --dry-run
//
// A re-run resumes rather than starting over: see the resume block below.
//
// Cadence and terms of service
// ----------------------------
// perplexity-app runs logged out, so it carries no account risk and can run
// freely. chatgpt-app drives a logged-in consumer session, which is against
// OpenAI's terms; the controls are volume and blast radius. This script refuses
// to run chatgpt-app more than once in MIN_CHATGPT_GAP_DAYS unless forced, uses
// a dedicated measurement account rather than anyone's personal one, and runs
// every query in a temporary chat. Treat the account as disposable.
//
// Failure handling
// ----------------
// A dead session or a moved selector writes an error row and prints an ALERT
// line. It never writes an answer. Recording a logged-out session as "String not
// mentioned" would be a fabricated measurement, and it would be indistinguishable
// from a real absence in every downstream number.

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { TIER1_QUESTION_IDS } from "./app-questions.ts";
import * as chatgptApp from "./surfaces/chatgpt-app.mjs";
import * as claudeApp from "./surfaces/claude-app.mjs";
import * as perplexityApp from "./surfaces/perplexity-app.mjs";
import * as googleAiMode from "./surfaces/google-ai-mode.mjs";
import * as googleAio from "./surfaces/google-aio.mjs";
import { searchSurface } from "./surfaces/google-search.mjs";

// Both Google surfaces read String's /v1/search since Sep 29 2026, not the
// hosted browser (see surfaces/google-search.mjs). GOOGLE_VIA_BROWSER=1 puts
// the browser path back for a side-by-side check.
const VIA_BROWSER = process.env.GOOGLE_VIA_BROWSER === "1";
const aiModeSearch = searchSurface("google_ai_mode");
const aioSearch = searchSurface("google");

const DB_PATH = join(import.meta.dir, "..", "data", "geo.db");

const argOf = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const DRY_RUN = process.argv.includes("--dry-run");
const HEADED = process.argv.includes("--headed");
const FORCE = process.argv.includes("--force");
// --core: for allQuestions surfaces (google-ai-mode), run the daily-core subset
// (tags tier:daily, ~50) instead of the full 200. Daily uses --core, the weekly
// pass omits it. Tier-1 (app) surfaces are unaffected; they always use their
// own 15-id list.
const CORE_ONLY = process.argv.includes("--core");
const ONLY = argOf("only");
const LIMIT = Number(argOf("limit")) || 0;

// Every browser call below is a bare `await` on a promise the page controls. A
// page that stops answering never rejects, so the surrounding try/catch cannot
// see it: the pass just stops, mid-surface, with no error row, no FAIL line and
// no ALERT. On 2026-08-21 that cost a Friday run three hours - claude-app hung
// before its first question and sat at 0.0% CPU until it was killed by hand,
// while the routine's own alert path waited on a throw that never came.
//
// Turning the hang into a rejection is the whole fix. The error row, the
// surface-level catch and the ALERT marker downstream all already do the right
// thing once something is actually thrown.
class TimeoutError extends Error {
  code = "TIMEOUT";
  constructor(label: string, ms: number) {
    super(`timed out after ${Math.round(ms / 1000)}s waiting for ${label}`);
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    }),
  ]).finally(() => clearTimeout(timer!));
}

// Ceilings, not targets: every one sits above the slowest LEGITIMATE path, so a
// trip means something is wrong rather than slow. The slowest legitimate ask is
// google-ai-mode's question retried to its third attempt: ~160s per attempt
// (10s warm-up + 60s goto + 90s answer poll), reconnects with backoff between,
// ~520s total. The app surfaces' own internal deadlines are 150-180s and return
// gracefully with partial text. An outer ceiling below any of those converts
// working questions into TIMEOUT rows and can kill a healthy pass through the
// consecutive-timeout breaker.
const LAUNCH_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 90_000;
const ASK_TIMEOUT_MS = 600_000;
// A page that times out three times running is dead, not slow. Stopping the
// surface there keeps a 200-question bank from spending 10 hours proving it.
const MAX_CONSECUTIVE_TIMEOUTS = 3;
// A surface can also grind without ever tripping the timeout breaker: sessions
// that open cleanly and die on first use fail fast with uncoded errors, one
// reconnect per question. Any-error streaks are bounded too.
const MAX_CONSECUTIVE_FAILURES = 8;
// Google traffic challenges are NOT grinding, and counting them here stops a
// healthy pass. The two Google surfaces open a pass by getting blocked and then
// recover on their own, because every block already forces a new exit IP.
// Measured on the Aug 21 google-ai-mode full pass, in order:
//   q1-q8    blocked (8)   -> q9-q12   answered
//   q13-q26  blocked (14)  -> q27-q61  answered, 35 in a row
// So an 8-failure bound kills that pass before its first usable row, and a
// 14-failure bound kills it before the 35-row run. On Aug 24 it did exactly
// that: q1-q8 blocked, breaker fired, zero Google rows for the day.
// Blocks get their own, higher bound. It still stops a genuine all-day block.
//
// CORRECTED Sep 1 2026. The Aug 31 version read "scale to the bank" as 12.5%
// with a floor of 15, which made the breaker MORE aggressive on a core day,
// not less: 12.5% of 58 is 8, so the floor governed and the bound fell from
// 25 to 15. It fired the same day - google-ai-mode stopped at 45 of 58 after
// a 15-block run, leaving 13 questions unmeasured.
//
// The bound must clear the longest recovery run we have measured. Aug 21 saw
// 14 consecutive blocks followed by 35 clean answers in a row, so anything at
// or under ~14 kills passes that would have finished. The floor is therefore
// 25 (the long-standing safe value), and the percentage only ever raises it
// for a bigger bank: 12.5% of the 295-question Friday pass is 37.
const maxConsecutiveBlocks = (bankSize: number) =>
  Math.max(25, Math.ceil(bankSize * 0.125));

// WAVES (Sep 11 2026). Blocks arrive in waves that last minutes, not hours.
// On Sep 10 google-ai-mode took 25 blocks in a row between 14:18 and 14:23 UTC
// and the breaker killed it; google-aio started on the same pool at 14:28 and
// answered 40 of 58. Since Sep 1 every blocked run has lasted 0.4-25 minutes
// and every clean run 7-12 minutes (the life of Google's DV cookie), so the
// cheapest recovery is to wait, not to stop. After this many blocks in a row
// the surface closes its browser (nothing bills while it waits), sleeps, and
// relaunches. Three pauses, doubling; the absolute breaker above still ends a
// pass that stays blocked through all of them.
const BLOCK_WAVE_TRIGGER = 8;
const BLOCK_WAVE_PAUSES_MS = [3, 6, 12].map((m) => m * 60_000);

// One ChatGPT pass a week. Six days rather than seven so a weekly cron that
// drifts an hour earlier is not silently skipped.
const MIN_CHATGPT_GAP_DAYS = 6;
// Consumer apps stream their answers; pacing keeps the traffic shaped like a
// person reading results rather than a scraper.
const DELAY_MS = { "chatgpt-app": 12_000, "chatgpt-app-search": 12_000, "claude-app": 12_000, "perplexity-app": 6_000 } as const;

interface AppAnswer {
  text: string;
  citations: { url: string; title?: string }[];
  /** Per-question SERP state, when the surface can tell one question from
   *  another. google-aio returns 'answer' or 'unavailable' per question; a fixed
   *  Surface.serpState cannot express that. Overrides Surface.serpState. */
  serpState?: string;
}

interface Surface {
  model: string;
  /** Whether a run of this surface risks an account. Drives the cadence guard. */
  loggedIn: boolean;
  /** Known-broken: skipped by the weekly pass unless --include-benched. */
  benched?: boolean;
  /** Run the full active bank instead of the tier-1 sample (daily SERP surfaces). */
  allQuestions?: boolean;
  /** Written into runs.serp_state on success so extract.ts skips the envelope parse. */
  serpState?: string;
  launch(opts: { headless: boolean }): Promise<any>;
  assertReady?(page: any): Promise<void>;
  ask(page: any, question: string): Promise<AppAnswer>;
}

const SURFACES: Surface[] = [
  {
    model: "chatgpt-app",
    loggedIn: true,
    launch: (opts) => chatgptApp.launch(opts),
    assertReady: (page) => chatgptApp.assertLoggedIn(page),
    ask: (page, q) => chatgptApp.ask(page, q),
  },
  {
    // Same profile and session as chatgpt-app, but search is forced per query.
    // Separate model value on purpose: the default condition and the forced
    // condition are different measurements and must never share rows.
    //
    // BENCHED (Aug 7): every arming path tried so far - ?hints=search, the
    // composer "+" menu item, a raw mouse click that verifiably shows the
    // "Web search" chip - still produced answers with zero sources in
    // temporary chats. The guard refused to store them (correctly), so the
    // surface currently yields only failure rows. Excluded from the weekly
    // pass until arming demonstrably works; run by hand with
    //   --only=chatgpt-app-search --include-benched
    // while iterating on it.
    model: "chatgpt-app-search",
    loggedIn: true,
    benched: true,
    launch: (opts) => chatgptApp.launch(opts),
    assertReady: (page) => chatgptApp.assertLoggedIn(page),
    ask: (page, q) => chatgptApp.askSearch(page, q),
  },
  {
    model: "claude-app",
    loggedIn: true,
    launch: (opts) => claudeApp.launch(opts),
    assertReady: (page) => claudeApp.assertLoggedIn(page),
    ask: (page, q) => claudeApp.ask(page, q),
  },
  {
    model: "perplexity-app",
    loggedIn: false,
    launch: (opts) => perplexityApp.launch(opts),
    ask: (page, q) => perplexityApp.ask(page, q),
  },
  {
    // Not an app: this is the daily google-ai-mode SERP measurement, moved here
    // from run-daily.ts because the fetch path snapshots before the answer
    // streams in (97% shells) and the API's `actions` wait hangs on google.com.
    // Same model value on purpose — the trend line continues. Runs the full
    // bank daily via `--only=google-ai-mode`, not the Sunday tier-1 pass.
    model: "google-ai-mode",
    loggedIn: false,
    allQuestions: true,
    serpState: "answer",
    launch: (opts) => (VIA_BROWSER ? googleAiMode.launch(opts) : aiModeSearch.launch()),
    ask: (page, q) => (VIA_BROWSER ? googleAiMode.ask(page, q) : aiModeSearch.ask(page, q)),
  },
  {
    // Also not an app: the daily AI Overviews measurement, moved here from
    // run-daily.ts on Aug 12 for the same reason AI Mode moved on Aug 10. The
    // fetch snapshot read the page before the overview streamed in and scored
    // the early read as a real absence — 6 of 6 spot-checked questions were
    // false negatives. See surfaces/google-aio.mjs for the measurements.
    //
    // No fixed serpState: this surface decides 'answer' or 'unavailable' per
    // question and returns it on the answer.
    model: "google-aio",
    loggedIn: false,
    allQuestions: true,
    launch: (opts) => (VIA_BROWSER ? googleAio.launch(opts) : aioSearch.launch()),
    ask: (page, q) => (VIA_BROWSER ? googleAio.ask(page, q) : aioSearch.ask(page, q)),
  },
];

const db = new Database(DB_PATH);
// Wait on a locked database instead of throwing SQLITE_BUSY: a review run,
// extract and a tracker pass can overlap on the same file.
db.run("PRAGMA busy_timeout = 30000");

const placeholders = TIER1_QUESTION_IDS.map(() => "?").join(",");
let questions = db
  .query(
    `SELECT id, text FROM questions WHERE active = 1 AND id IN (${placeholders}) ORDER BY id`
  )
  .all(...TIER1_QUESTION_IDS) as { id: number; text: string }[];
if (LIMIT) questions = questions.slice(0, LIMIT);

// Bank for surfaces with allQuestions (the daily SERP measurement). --core
// narrows it to the daily-core subset; without it, the full active bank.
let bankQuestions = db
  .query(
    `SELECT id, text FROM questions WHERE active = 1${CORE_ONLY ? " AND tags LIKE '%tier:daily%'" : ""} ORDER BY id`
  )
  .all() as { id: number; text: string }[];
if (LIMIT) bankQuestions = bankQuestions.slice(0, LIMIT);

const missing = TIER1_QUESTION_IDS.filter((id) => !questions.some((q) => q.id === id));
if (missing.length && !LIMIT) {
  // The tier-1 list is hand-curated against question ids. If the bank is edited
  // and an id goes inactive, say so rather than quietly measuring less.
  console.log(`note: tier-1 ids not active in the bank, skipped: ${missing.join(", ")}`);
}

const INCLUDE_BENCHED = process.argv.includes("--include-benched");
const selected = SURFACES.filter(
  (s) => (!ONLY || s.model === ONLY) && (!s.benched || INCLUDE_BENCHED)
);
for (const s of SURFACES) {
  if (s.benched && !INCLUDE_BENCHED && (!ONLY || ONLY === s.model)) {
    console.log(`benched: ${s.model} (known-broken, --include-benched to run anyway)`);
  }
}
if (selected.length === 0) {
  console.error(`--only=${ONLY} matched no surface (have: ${SURFACES.map((s) => s.model).join(", ")})`);
  process.exit(1);
}

// Resume: never ask a question this surface already answered cleanly today.
// A pass that dies partway gets re-run by hand, and until Aug 11 that re-run
// started from question 1 again: recovering 11 blocked google-ai-mode questions
// re-asked all 50 and left the day with 100 rows for 50 questions. The
// dashboard takes the latest row per question x model x day so it survived
// that, but the raw-row consumers (weekly-insights, content-coverage, the
// domains citation ledger) count every row, and each duplicate is also a
// browser-tier page nobody needed to buy.
//
// Error rows deliberately do NOT count as answered - a re-run exists to clear
// failures, and this is the same eligibility rule run-daily.ts uses for
// --failed-today, so the two runners agree on what "already done" means.
// No bypass flag: run-daily.ts has none, and --force here is the ChatGPT
// cadence override, which is a different question from what work is owed.
const answeredToday = new Set<string>(
  (
    db
      .query(
        `SELECT DISTINCT question_id, model FROM runs
         WHERE date(run_ts) = date('now') AND error IS NULL`
      )
      .all() as { question_id: number; model: string }[]
  ).map((r) => `${r.question_id}|${r.model}`)
);

// The bank a surface draws from, and the part of it still owed today.
const bankFor = (s: Surface) => (s.allQuestions ? bankQuestions : questions);
const pendingFor = (s: Surface) =>
  bankFor(s).filter((q) => !answeredToday.has(`${q.id}|${s.model}`));

// Cadence guard: how long since this surface last ran a real PASS.
// Two deliberate exclusions:
//   - failed rows: a pass that died on a logged-out session measured nothing,
//     and counting it would lock the surface out for MIN_CHATGPT_GAP_DAYS
//     right after re-auth - exactly when a re-run is wanted.
//   - single-question days: `--limit=1` verification runs (post-login checks,
//     selector debugging) are not weekly passes, and counting one would make
//     the next real pass silently skip the surface. A day counts only if it
//     produced 3+ successful rows.
const lastRunDays = (model: string): number | null => {
  const row = db
    .query(
      `SELECT julianday('now') - julianday(MAX(d)) AS days FROM (
         SELECT date(run_ts) AS d FROM runs
         WHERE model = ? AND error IS NULL
         GROUP BY date(run_ts)
         HAVING COUNT(*) >= 3
       )`
    )
    .get(model) as { days: number | null } | null;
  return row?.days ?? null;
};

// Name each surface with the bank it actually asks. The old line reported
// `questions.length` ("15 tier-1 questions") for every surface, including the
// allQuestions ones that ask all 200 - so a correct weekly SERP pass announced
// itself as a 15-question sample. On 2026-08-21 that nearly caused a healthy
// 200-question run to be killed as misconfigured. The count is load-bearing:
// it is the first thing anyone checks to confirm the right pass is running.
console.log(
  `${selected.length} app surfaces: ${selected
    .map((s) => `${s.model} (${bankFor(s).length} q${s.allQuestions ? `, full bank${CORE_ONLY ? ", core" : ""}` : ", tier-1"})`)
    .join(", ")}`
);

if (DRY_RUN) {
  for (const s of selected) {
    const since = lastRunDays(s.model);
    console.log(
      `  ${s.model}: last run ${since === null ? "never" : `${since.toFixed(1)}d ago`}` +
        (s.loggedIn ? `, min gap ${MIN_CHATGPT_GAP_DAYS}d` : ", no cadence limit")
    );
    const total = bankFor(s).length;
    const todo = pendingFor(s);
    // Name the pending ids only on a partial day - that is the recovery case
    // worth eyeballing before spending browser credits. A full bank is just the
    // question list printed below.
    const ids =
      todo.length && todo.length < total
        ? ` (q${todo.slice(0, 12).map((q) => q.id).join(", q")}${todo.length > 12 ? `, +${todo.length - 12} more` : ""})`
        : "";
    console.log(`  ${s.model}: resume - ${total - todo.length}/${total} answered today, ${todo.length} would run${ids}`);
  }
  for (const q of questions) console.log(`  q${q.id} ${q.text}`);
  console.log("dry run - no browser launched, nothing stored");
  process.exit(0);
}

const insertRun = db.prepare(
  "INSERT INTO runs (question_id, model, run_ts, raw_answer, citations, error) VALUES (?, ?, ?, ?, ?, ?)"
);
const insertSerpRun = db.prepare(
  "INSERT INTO runs (question_id, model, run_ts, raw_answer, citations, error, serp_state) VALUES (?, ?, ?, ?, ?, ?, ?)"
);
const bumpDomain = db.prepare(`
  INSERT INTO domains (domain, first_seen, citation_count) VALUES (?, ?, 1)
  ON CONFLICT(domain) DO UPDATE SET citation_count = citation_count + 1
`);

let failures = 0;
const alerts: string[] = [];

for (const surface of selected) {
  if (surface.loggedIn && !FORCE) {
    const since = lastRunDays(surface.model);
    if (since !== null && since < MIN_CHATGPT_GAP_DAYS) {
      console.log(
        `skip ${surface.model}: last run ${since.toFixed(1)}d ago, minimum gap is ${MIN_CHATGPT_GAP_DAYS}d (--force to override)`
      );
      continue;
    }
  }

  const total = bankFor(surface).length;
  const pending = pendingFor(surface);
  if (pending.length < total) {
    console.log(
      `resume ${surface.model}: ${total - pending.length}/${total} already answered today, asking the remaining ${pending.length}`
    );
  }
  if (pending.length === 0) {
    // Launching the browser to ask nothing still costs a page load per surface,
    // and on a scheduled re-run it would be pure waste. Stop before launch.
    console.log(`skip ${surface.model}: every question already answered today`);
    continue;
  }

  // `withTimeout` abandons the losing promise but cannot cancel it: a launch
  // that completes after its deadline hands back a live browser (and for the
  // Google surfaces, assigns the module-level session) that nothing references.
  // Keep the raw promise so the late arrival is closed instead of billing until
  // the hosted 30-minute kill.
  const launchSurface = async (label: string) => {
    const launching = surface.launch({ headless: !HEADED });
    try {
      return await withTimeout(launching, LAUNCH_TIMEOUT_MS, label);
    } catch (e) {
      launching.then((c: any) => c?.close?.()).catch(() => {});
      throw e;
    }
  };

  let ctx: any = null;
  try {
    ctx = await launchSurface(`${surface.model} launch`);
    let page = ctx.pages()[0] ?? (await ctx.newPage());

    if (surface.assertReady) {
      // Check the session once, before spending a whole pass discovering it is dead.
      await withTimeout(
        surface.assertReady(page),
        READY_TIMEOUT_MS,
        `${surface.model} session check`
      );
    }

    let consecutiveTimeouts = 0;
    let consecutiveFailures = 0;
    let consecutiveBlocks = 0;
    let wavePauses = 0;
    for (const question of pending) {
      const ts = new Date().toISOString();
      try {
        const { text, citations, serpState } = await withTimeout(
          surface.ask(page, question.text),
          ASK_TIMEOUT_MS,
          `${surface.model} q${question.id}`
        );
        consecutiveTimeouts = 0;
        consecutiveFailures = 0;
        consecutiveBlocks = 0;
        // Store citations as a URL array, the same shape the API surfaces use, so
        // extract.ts and dashboard.ts need no special case for app rows.
        const urls = citations.map((c) => c.url).filter(Boolean);
        // Per-answer state wins over the surface default: google-aio varies by
        // question, google-ai-mode is always 'answer'.
        const state = serpState ?? surface.serpState;
        if (state) {
          insertSerpRun.run(question.id, surface.model, ts, text, JSON.stringify(urls), null, state);
        } else {
          insertRun.run(question.id, surface.model, ts, text, JSON.stringify(urls), null);
        }
        for (const url of urls) {
          try {
            bumpDomain.run(new URL(url).hostname.replace(/^www\./, ""), ts);
          } catch {
            // unparseable citation URL - keep the run, skip the ledger bump
          }
        }
        // Name the state when the surface reports one per question. "0 citations"
        // alone reads like a broken parse; "no AI Overview" reads like the
        // measurement it is.
        const note =
          serpState === "unavailable" ? "no AI Overview" : `${urls.length} citations`;
        console.log(`ok   q${question.id} ${surface.model} (${note})`);
      } catch (error: any) {
        failures++;
        insertRun.run(question.id, surface.model, ts, null, null, String(error));
        console.log(`FAIL q${question.id} ${surface.model}: ${error}`);

        // A dead session or a lost incognito entry point poisons every remaining
        // question in the pass, so stop this surface rather than writing 14 more
        // identical failures.
        // A block is a measurement condition, not a health condition: the surface
        // is working and Google is refusing. Keep it out of the grinding count.
        if (error?.code === "BLOCKED") {
          consecutiveBlocks++;
        } else {
          consecutiveBlocks = 0;
          consecutiveFailures++;
        }
        if (error?.code === "TIMEOUT") {
          consecutiveTimeouts++;
          if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
            alerts.push(
              `${surface.model}: ${consecutiveTimeouts} questions in a row timed out - page stopped responding, pass stopped early, remaining questions unmeasured.`
            );
            break;
          }
          // The timed-out ask was abandoned, not cancelled - it is still holding
          // the surface's page, and letting the next question share that page is
          // how one slow answer becomes a wrong-answer row under the wrong id.
          // Recycle the whole context so the orphan dies with its connection.
          try {
            await ctx?.close().catch(() => {});
            ctx = await launchSurface(`${surface.model} relaunch after timeout`);
            page = ctx.pages()[0] ?? (await ctx.newPage());
            if (surface.assertReady) {
              await withTimeout(surface.assertReady(page), READY_TIMEOUT_MS, `${surface.model} session re-check`);
            }
          } catch (relaunchError: any) {
            alerts.push(
              `${surface.model}: relaunch after a timeout failed (${String(relaunchError).slice(0, 120)}) - pass stopped early, remaining questions unmeasured.`
            );
            break;
          }
        } else {
          consecutiveTimeouts = 0;
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          alerts.push(
            `${surface.model}: ${consecutiveFailures} questions in a row failed - surface is grinding, pass stopped early, remaining questions unmeasured.`
          );
          break;
        }
        if (consecutiveBlocks >= maxConsecutiveBlocks(pending.length)) {
          alerts.push(
            `${surface.model}: ${consecutiveBlocks} questions in a row blocked by Google (${wavePauses} wave pauses) - pass stopped early, remaining questions unmeasured.`
          );
          break;
        }
        if (
          error?.code === "BLOCKED" &&
          consecutiveBlocks % BLOCK_WAVE_TRIGGER === 0 &&
          wavePauses < BLOCK_WAVE_PAUSES_MS.length
        ) {
          const pauseMs = BLOCK_WAVE_PAUSES_MS[wavePauses++];
          console.log(
            `  ${consecutiveBlocks} blocks in a row - closing the browser and pausing ${pauseMs / 60_000} min for the wave to pass`
          );
          await ctx?.close().catch(() => {});
          ctx = null;
          await Bun.sleep(pauseMs);
          try {
            ctx = await launchSurface(`${surface.model} relaunch after block pause`);
            page = ctx.pages()[0] ?? (await ctx.newPage());
          } catch (relaunchError: any) {
            alerts.push(
              `${surface.model}: relaunch after a block pause failed (${String(relaunchError).slice(0, 120)}) - pass stopped early, remaining questions unmeasured.`
            );
            break;
          }
        }
        if (error?.code === "SESSION_DEAD") {
          alerts.push(`${surface.model}: session is logged out, weekly pass did not run. Re-auth with \`make setup-${surface.model.replace("-app", "")}\`.`);
          break;
        }
        if (error?.code === "SESSION_POOL_DEAD") {
          alerts.push(`${surface.model}: hosted CDP browser (request.usestring.ai) stopped answering after 3 reconnects - pass stopped early, remaining questions unmeasured.`);
          break;
        }
        if (error?.code === "INCOGNITO_UNAVAILABLE") {
          alerts.push(`${surface.model}: incognito chat entry point not found - refusing to measure in normal chats. Selectors in the surface file need updating.`);
          break;
        }
        if (error?.code === "SEARCH_UNAVAILABLE") {
          alerts.push(`${surface.model}: could not force web search (hints=search hook may have changed) - refusing to store unsearched answers under the search-forced surface.`);
          break;
        }
      }
      await Bun.sleep(DELAY_MS[surface.model as keyof typeof DELAY_MS] ?? 5000);
    }
  } catch (error: any) {
    failures++;
    const ts = new Date().toISOString();
    // Launch or session-check failure: one error row against the first question so
    // the failure is visible in the data, not only in a log nobody reads. It goes
    // against the first PENDING question - an error row on a question that already
    // answered cleanly today would be noise, and resume ignores it anyway.
    insertRun.run(pending[0]?.id ?? null, surface.model, ts, null, null, String(error));
    console.log(`FAIL ${surface.model} (surface-level): ${error}`);
    alerts.push(
      error?.code === "SESSION_DEAD"
        ? `${surface.model}: session is logged out, weekly pass did not run. Re-auth with \`make setup-${surface.model.replace("-app", "")}\`.`
        : `${surface.model}: surface failed to start (${String(error).slice(0, 120)}).`
    );
  } finally {
    await ctx?.close().catch(() => {});
  }
}

console.log(`done. failures logged as rows: ${failures}`);

// Whatever schedules this run can watch for this marker and alert however it
// likes. Printing it rather than posting from here keeps messaging credentials
// out of the runner and keeps all outbound alerting in one place.
for (const alert of alerts) console.log(`ALERT: ${alert}`);
if (alerts.length) process.exit(2);
