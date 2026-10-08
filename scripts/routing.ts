// Routing diagnostic (make routing): for each theme, does the AEO work belong
// on-page or off-page? The Profound validation-x-discovery method:
//
//   validation score  mention rate on the theme's type:validation questions -
//                     "does the engine know this fact about the brand when
//                     asked directly?"
//   discovery score   mention rate on the theme's non-branded DISCOVERY
//                     questions (no type: tag) - "does the engine bring the
//                     brand up unprompted?"
//
// High validation + low discovery = the engines know the fact but do not
// surface it: a trust gap, fixed off-page. Low validation = they never learned
// it: a comprehension gap, fixed on-page. Verdict thresholds live in
// lib/routing-verdict.ts with the unit tests.
//
// Until a theme has any type:validation questions, this emits "no validation
// coverage" rather than guessing.
//
// 14 days, latest row per question x model x day, mention-trustworthy rows
// only (Google surfaces count only when serp_state = 'answer').
// Writes data/routing.json.

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { routingVerdict, DISCOVERY_GOAL_PCT, VALIDATION_TRUST_PCT } from "./lib/routing-verdict";
import { themeOf, typeOf, isBranded } from "./lib/tags";
import { BRAND_NAME } from "./brand.ts";

const DB_PATH = join(import.meta.dir, "..", "data", "geo.db");
const OUT_PATH = join(import.meta.dir, "..", "data", "routing.json");
const db = new Database(DB_PATH, { readonly: true });
// Wait on a locked database instead of throwing SQLITE_BUSY: a review run,
// extract and a tracker pass can overlap on the same file.
db.run("PRAGMA busy_timeout = 30000");

interface Row { question_id: number; mentioned: number; tags: string }

const rows = db.query(`
  SELECT r.question_id, m.mentioned, q.tags
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
`).all({ $brand: BRAND_NAME.toLowerCase() }) as Row[];

const questions = db.query("SELECT id, tags FROM questions WHERE active = 1")
  .all() as { id: number; tags: string }[];

const themes = [...new Set(questions.map((q) => themeOf(q.tags)).filter((t): t is string => !!t))].sort();

const rate = (sel: Row[]) => ({
  n: sel.length,
  pct: sel.length === 0 ? 0 : Number(((100 * sel.filter((r) => r.mentioned).length) / sel.length).toFixed(1))
});

const perTheme = themes.map((theme) => {
  const validationQ = new Set(
    questions.filter((q) => themeOf(q.tags) === theme && typeOf(q.tags) === "validation").map((q) => q.id)
  );
  const discoveryQ = new Set(
    questions
      .filter((q) => themeOf(q.tags) === theme && typeOf(q.tags) === null && !isBranded(q.tags))
      .map((q) => q.id)
  );
  const discovery = rate(rows.filter((r) => discoveryQ.has(r.question_id)));

  if (validationQ.size === 0) {
    return {
      theme,
      validation: null,
      discovery,
      verdict: "no validation coverage" as string
    };
  }
  const validation = rate(rows.filter((r) => validationQ.has(r.question_id)));
  // Enrolled but unmeasured validation questions must not read as 0%: a
  // verdict off an empty numerator would route real work on a guess. Goal
  // state needs no validation data; the two gap verdicts do.
  const verdict =
    discovery.pct >= DISCOVERY_GOAL_PCT ? routingVerdict(discovery.pct, validation.pct)
    : validation.n === 0 ? "no validation data yet (questions enrolled, no clean runs)"
    : routingVerdict(discovery.pct, validation.pct);
  return { theme, validation, discovery, verdict };
});

const out = {
  generatedAt: new Date().toISOString(),
  windowDays: 14,
  thresholds: { discoveryGoalPct: DISCOVERY_GOAL_PCT, validationTrustPct: VALIDATION_TRUST_PCT },
  note: "validation = mention rate on type:validation questions; discovery = mention rate on non-branded no-type questions; clean latest rows, Google surfaces only when serp_state='answer'.",
  themes: perTheme
};
await Bun.write(OUT_PATH, JSON.stringify(out, null, 2));

for (const t of perTheme) {
  const v = t.validation ? `${t.validation.pct}% (${t.validation.n})` : "—";
  console.log(
    `${t.theme.padEnd(14)} validation ${v.padEnd(12)} discovery ${`${t.discovery.pct}% (${t.discovery.n})`.padEnd(12)} ${t.verdict}`
  );
}
console.log(`-> ${OUT_PATH}`);
