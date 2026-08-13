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
    launch: (opts) => googleAiMode.launch(opts),
    ask: (page, q) => googleAiMode.ask(page, q),
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
    launch: (opts) => googleAio.launch(opts),
    ask: (page, q) => googleAio.ask(page, q),
  },
];

const db = new Database(DB_PATH);

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

console.log(
  `${questions.length} tier-1 questions x ${selected.length} app surfaces (${selected
    .map((s) => s.model)
    .join(", ")})`
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

  let ctx: any = null;
  try {
    ctx = await surface.launch({ headless: !HEADED });
    const page = ctx.pages()[0] ?? (await ctx.newPage());

    if (surface.assertReady) {
      // Check the session once, before spending a whole pass discovering it is dead.
      await surface.assertReady(page);
    }

    for (const question of pending) {
      const ts = new Date().toISOString();
      try {
        const { text, citations, serpState } = await surface.ask(page, question.text);
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
        if (error?.code === "SESSION_DEAD") {
          alerts.push(`${surface.model}: session is logged out, weekly pass did not run. Re-auth with \`make setup-${surface.model.replace("-app", "")}\`.`);
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

// The scheduled task watches for this marker and posts one line to #bruceinbox.
// Printing it rather than posting from here keeps Slack credentials out of the
// runner and keeps all outbound messaging in one place.
for (const alert of alerts) console.log(`ALERT: ${alert}`);
if (alerts.length) process.exit(2);
