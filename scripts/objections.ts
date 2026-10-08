// Objection mining (make objections): what do the engines hold against your
// brand, in their own words? Pulls the last 14 days of negative and
// inaccurate latest-row mentions (plus up to 40 neutral BRANDED rows so the
// model sees what an ordinary answer sounds like), and asks Sonnet - the same
// model and call pattern as extract.ts's classify step - to cluster them into
// named recurring objection themes with a verbatim quote and a one-sentence
// reframe each. Factual inaccuracies always come back as their own entries.
//
// Zero negative/inaccurate rows writes an empty list; this script never
// invents objections. Uses ANTHROPIC_API_KEY from .env.
// Writes data/objections.json.

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { BRAND_NAME, BRAND_DOMAIN } from "./brand.ts";

const DB_PATH = join(import.meta.dir, "..", "data", "geo.db");
const OUT_PATH = join(import.meta.dir, "..", "data", "objections.json");
const ANSWER_MAX_CHARS = 1500;
const NEUTRAL_CAP = 40;

const db = new Database(DB_PATH, { readonly: true });
// Wait on a locked database instead of throwing SQLITE_BUSY: a review run,
// extract and a tracker pass can overlap on the same file.
db.run("PRAGMA busy_timeout = 30000");

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY) {
  console.error("ANTHROPIC_API_KEY not set; see .env.example");
  process.exit(1);
}

// Same single-call helper extract.ts uses for its classify fallback.
async function anthropic(model: string, system: string, user: string, maxTokens = 4000): Promise<string> {
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

function parseJson(text: string): any {
  const cleaned = text.replace(/```(?:json)?/g, "");
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`no JSON in reply: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

interface Row {
  question_id: number;
  question: string;
  model: string;
  sentiment: string;
  answer: string;
}

const LATEST = `
  JOIN (
    SELECT question_id, model, date(run_ts) d, MAX(id) mid
    FROM runs GROUP BY question_id, model, date(run_ts)
  ) k ON k.mid = r.id`;

const negatives = db.query(`
  SELECT r.question_id, q.text question, r.model, m.sentiment,
         substr(r.raw_answer, 1, ${ANSWER_MAX_CHARS}) answer
  FROM runs r ${LATEST}
  JOIN mentions m ON m.run_id = r.id AND m.brand = $brand
  JOIN questions q ON q.id = r.question_id
  WHERE r.error IS NULL AND m.sentiment IN ('negative','inaccurate')
    AND date(r.run_ts) > date('now', '-14 day')
  ORDER BY r.id DESC
`).all({ $brand: BRAND_NAME.toLowerCase() }) as Row[];

const neutrals = db.query(`
  SELECT r.question_id, q.text question, r.model, m.sentiment,
         substr(r.raw_answer, 1, ${ANSWER_MAX_CHARS}) answer
  FROM runs r ${LATEST}
  JOIN mentions m ON m.run_id = r.id AND m.brand = $brand
  JOIN questions q ON q.id = r.question_id
  WHERE r.error IS NULL AND m.sentiment = 'neutral'
    AND q.tags LIKE '%cat:company%'
    AND date(r.run_ts) > date('now', '-14 day')
  ORDER BY r.id DESC LIMIT ${NEUTRAL_CAP}
`).all({ $brand: BRAND_NAME.toLowerCase() }) as Row[];

console.log(`objections: ${negatives.length} negative/inaccurate rows, ${neutrals.length} neutral branded rows for balance (14d)`);

interface Objection {
  name: string;
  count: number;
  example_quote: string;
  source_questions: number[];
  suggested_reframe: string;
}

let objections: Objection[] = [];

if (negatives.length > 0) {
  const SYSTEM = `You analyze answer-engine output for brand monitoring. The brand is "${BRAND_NAME}" (${BRAND_DOMAIN}). You receive answers where the extraction pass marked ${BRAND_NAME}'s treatment negative or inaccurate, plus neutral branded answers for contrast (so you can tell an actual objection from ordinary hedged language).

Cluster the NEGATIVE and INACCURATE answers into named recurring objection themes. Rules:
- Objections come only from the negative/inaccurate answers. The neutral answers are context; never mine them for objections.
- Every factual inaccuracy about ${BRAND_NAME} is its own entry (name it "Inaccuracy: <the false claim>"), never merged into a broader theme.
- example_quote must be VERBATIM text from an answer, at most 200 characters.
- source_questions lists the question ids the theme appeared on.
- suggested_reframe is one sentence: how ${BRAND_NAME} should answer or reposition against the objection.
- Do not invent objections that are not in the text.

Reply with ONLY a JSON object:
{"objections": [{"name": "...", "count": <int>, "example_quote": "...", "source_questions": [<int>], "suggested_reframe": "..."}]}`;

  const block = (r: Row, i: number) =>
    `--- ${r.sentiment.toUpperCase()} #${i + 1} (question ${r.question_id}, surface ${r.model})\nQ: ${r.question}\nA: ${r.answer}`;
  const user =
    `NEGATIVE / INACCURATE ANSWERS (${negatives.length}):\n\n` +
    negatives.map(block).join("\n\n") +
    (neutrals.length > 0
      ? `\n\nNEUTRAL BRANDED ANSWERS FOR CONTRAST (${neutrals.length}):\n\n` + neutrals.map(block).join("\n\n")
      : "");

  const reply = await anthropic("claude-sonnet-5", SYSTEM, user);
  const parsed = parseJson(reply);
  objections = (Array.isArray(parsed.objections) ? parsed.objections : []).map((o: any) => ({
    name: String(o.name ?? ""),
    count: Number(o.count ?? 0),
    example_quote: String(o.example_quote ?? "").slice(0, 200),
    source_questions: Array.isArray(o.source_questions) ? o.source_questions.map(Number) : [],
    suggested_reframe: String(o.suggested_reframe ?? "")
  }));
} else {
  console.log("objections: no negative/inaccurate rows in the window - writing an empty list");
}

const out = {
  generatedAt: new Date().toISOString(),
  windowDays: 14,
  negativeRows: negatives.length,
  neutralSample: neutrals.length,
  objections
};
await Bun.write(OUT_PATH, JSON.stringify(out, null, 2));

for (const o of objections) {
  console.log(`  [${o.count}x] ${o.name} - "${o.example_quote.slice(0, 80)}"`);
}
console.log(`-> ${OUT_PATH} (${objections.length} objection themes)`);
