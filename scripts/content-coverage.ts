// Content coverage: which tracked questions does your own site actually
// answer on-site, and which does it leave to competitors?
//
// The daily tracker measures whether engines mention String. It never asks the
// prior question: is there anything on our own site for an engine to lift? A
// question we lose every day with no on-site answer is a content gap. A
// question we lose while answering it well is a distribution problem. Those
// need opposite fixes, and the Monday review could not tell them apart until
// this ran.
//
// Corpus is the agent-facing surface, not the rendered site: /llms.txt (key
// facts + index) plus the .md rendition of every page it lists. That is what a
// crawler that does not run JavaScript actually gets.
//
// Writes data/content-coverage.json and prints a summary. Read-only against
// the site; the only writes are that file. Uses ANTHROPIC_API_KEY from .env.
import { Database } from "bun:sqlite";

const SITE = process.env.COVERAGE_SITE ?? BRAND_SITE;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY) {
  console.error("ANTHROPIC_API_KEY not set; see .env.example");
  process.exit(1);
}

const db = new Database("data/geo.db", { readonly: true });
// Wait on a locked database instead of throwing SQLITE_BUSY: a review run,
// extract and a tracker pass can overlap on the same file.
db.run("PRAGMA busy_timeout = 30000");

// Judge stability is load-bearing here: the Monday review reports week-over-week
// movement in these verdicts, so judge noise reads as a content change that
// never happened. Measured Aug 10: two back-to-back runs over an identical
// corpus returned 25/10/5 and then 17/19/4.
//
// `temperature` is not the lever - it is removed on this model and returns a
// 400, and it never guaranteed identical output on the models that did take it.
// Three things do the work instead:
//   1. a json_schema output format, so the reply shape never varies and there
//      is no prose-around-the-JSON to salvage;
//   2. thinking off at low effort, since a three-way verdict against a fixed
//      corpus is a mechanical call, not a reasoning task;
//   3. the corpus-hash cache below, which is what actually makes the weekly
//      number comparable - see judgeAll().
const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "verdict", "evidence", "gap"],
        properties: {
          id: { type: "integer" },
          verdict: { type: "string", enum: ["answered", "partial", "missing"] },
          evidence: { type: "string" },
          gap: { type: "string" }
        }
      }
    }
  }
} as const;

async function judge(system: string, user: string): Promise<any> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 4000,
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema", schema: VERDICT_SCHEMA } },
      system,
      messages: [{ role: "user", content: user }]
    })
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as any;
  if (body.stop_reason === "refusal") throw new Error("judge refused");
  const text = (body.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  return JSON.parse(text);
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { accept: "text/markdown,text/plain,*/*" } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
}

// llms.txt promises Markdown for the homepage, the product pages, the blog
// index and every post - not for legal or lead-capture pages. Only a missing
// rendition inside that promise is a defect; flagging /terms and /book-demo
// would cry wolf every week and train the reader to skip the line.
const MARKDOWN_PROMISED = /^\/(web-access|pricing|products|composer|managed-services|about|blog)(\/|$)/;

// The agent-facing corpus: llms.txt, then the .md rendition of every on-site
// page it links. A .md that 404s is reported rather than silently skipped -
// llms.txt promising a rendition that doesn't exist is itself a finding.
async function buildCorpus(): Promise<{ text: string; sources: string[]; missing: string[] }> {
  const llms = await fetchText(`${SITE}/llms.txt`);
  const parts = [`=== /llms.txt ===\n${llms}`];
  const sources = ["/llms.txt"];
  const missing: string[] = [];

  const paths = [...new Set([...llms.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map((m) => m[1]))]
    .filter((u) => u.startsWith(SITE))
    .map((u) => new URL(u).pathname)
    .filter((p) => p !== "/" && !p.endsWith(".xml") && !p.endsWith(".txt"));

  for (const path of paths) {
    try {
      const md = await fetchText(`${SITE}${path}.md`);
      parts.push(`=== ${path} ===\n${md}`);
      sources.push(path);
    } catch {
      if (MARKDOWN_PROMISED.test(path)) missing.push(path);
    }
  }
  return { text: parts.join("\n\n"), sources, missing };
}

interface Question {
  id: number;
  text: string;
  intent: string;
  tags: string;
}

const questions = db.query("SELECT id, text, intent, tags FROM questions WHERE active = 1 ORDER BY id").all() as Question[];

// Who wins each question when we don't. Domains cited on that question's rows
// over the last 14 days, ours excluded, so a gap ships with its competition.
function winnersFor(questionId: number): string[] {
  const rows = db
    .query(
      `SELECT citations FROM runs
        WHERE question_id = ? AND date(run_ts) >= date('now','-14 days')
          AND citations IS NOT NULL AND citations != '[]'`
    )
    .all(questionId) as { citations: string }[];

  const counts = new Map<string, number>();
  for (const row of rows) {
    let urls: string[] = [];
    try {
      urls = JSON.parse(row.citations);
    } catch {
      continue;
    }
    for (const url of urls) {
      let host: string;
      try {
        host = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        continue;
      }
      if (isOwnDomain(host) || host.includes("vertexaisearch")) continue;
      counts.set(host, (counts.get(host) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h, n]) => `${h} (${n})`);
}

function mentionRate(questionId: number): number | null {
  const row = db
    .query(
      `SELECT AVG(m.mentioned) rate FROM mentions m JOIN runs r ON r.id = m.run_id
        WHERE r.question_id = ? AND date(r.run_ts) >= date('now','-14 days')`
    )
    .get(questionId) as { rate: number | null };
  return row?.rate == null ? null : Math.round(row.rate * 100);
}

const SYSTEM = `You audit whether a company's own published content answers a question.

You get a CORPUS (everything ${SITE} exposes to an AI crawler) and a list of QUESTIONS.

For each question decide how well the corpus answers it, from the corpus alone. Do not use outside knowledge about the company.

verdict:
- "answered": a reader of the corpus could answer the question directly, with specifics.
- "partial": the corpus touches the topic but a reader would still be guessing on the main point.
- "missing": nothing in the corpus addresses it.

Also return "evidence": the single most relevant sentence from the corpus, verbatim, or "" when missing.
And "gap": for partial/missing only, one short sentence naming the specific fact that is absent. "" when answered.`;

// A verdict is a function of exactly two things: the corpus text and the
// question text. Neither changes on most days, so re-judging every Monday buys
// nothing but a fresh roll of the judge's dice - which is precisely the noise
// that made week-over-week movement meaningless. Cache on the hash of both and
// only spend a call on questions whose inputs actually moved.
//
// This is what makes the review's "movement" line real: a verdict that changes
// now means the site changed or the question changed, never that the judge
// happened to land differently.
const CACHE_PATH = "data/coverage-cache.json";

async function loadCache(): Promise<Record<string, any>> {
  try {
    return JSON.parse(await Bun.file(CACHE_PATH).text());
  } catch {
    return {};
  }
}

async function judgeAll(corpusText: string) {
  const corpusHash = new Bun.CryptoHasher("sha256").update(corpusText).digest("hex").slice(0, 16);
  const cache = await loadCache();
  const key = (q: Question) =>
    `${corpusHash}:${new Bun.CryptoHasher("sha256").update(q.text).digest("hex").slice(0, 12)}`;

  const cached = questions.filter((q) => cache[key(q)]);
  const stale = questions.filter((q) => !cache[key(q)]);
  console.log(`judge: ${cached.length} cached, ${stale.length} to judge (corpus ${corpusHash})`);

  const BATCH = 10;
  for (let i = 0; i < stale.length; i += BATCH) {
    const batch = stale.slice(i, i + BATCH);
    const user = `CORPUS:\n${corpusText}\n\nQUESTIONS:\n${batch.map((q) => `${q.id}. ${q.text}`).join("\n")}`;
    const reply = await judge(SYSTEM, user);
    const byId = new Map(reply.results.map((r: any) => [r.id, r]));
    for (const q of batch) {
      const r = byId.get(q.id);
      if (r) cache[key(q)] = r;
    }
    console.log(`judged ${Math.min(i + BATCH, stale.length)}/${stale.length}`);
  }

  await Bun.write(CACHE_PATH, JSON.stringify(cache, null, 2));
  return new Map(questions.map((q) => [q.id, cache[key(q)]]).filter(([, r]) => r) as [number, any][]);
}

async function main() {
  console.log(`corpus: fetching ${SITE}/llms.txt and linked .md renditions`);
  const corpus = await buildCorpus();
  console.log(`corpus: ${corpus.sources.length} documents, ${corpus.text.length.toLocaleString()} chars`);
  if (corpus.missing.length) console.log(`corpus: no .md rendition for ${corpus.missing.join(", ")}`);

  const byId = await judgeAll(corpus.text);
  const report = questions.map((q) => {
    const r = byId.get(q.id) ?? { verdict: "missing", evidence: "", gap: "no verdict returned" };
    return {
      id: q.id,
      question: q.text,
      intent: q.intent,
      tags: q.tags,
      verdict: r.verdict,
      gap: r.gap ?? "",
      evidence: r.evidence ?? "",
      mentionRate14d: mentionRate(q.id),
      winners: winnersFor(q.id)
    };
  });

  const out = {
    generatedAt: new Date().toISOString(),
    site: SITE,
    corpusSources: corpus.sources,
    corpusMissingMarkdown: corpus.missing,
    questions: report
  };
  await Bun.write("data/content-coverage.json", JSON.stringify(out, null, 2));

  const count = (v: string) => report.filter((r) => r.verdict === v).length;
  console.log(`\ncoverage: ${count("answered")} answered · ${count("partial")} partial · ${count("missing")} missing`);

  // The action list: questions we lose that we also don't answer. Ranked by how
  // badly we lose them, because a 0% question with no on-site answer is the one
  // where writing something can actually change the number.
  const priority = report
    .filter((r) => r.verdict !== "answered")
    .sort((a, b) => (a.mentionRate14d ?? 0) - (b.mentionRate14d ?? 0));

  console.log(`\nfix first (no on-site answer, lowest mention rate):`);
  for (const r of priority.slice(0, 10)) {
    console.log(`  q${r.id} [${r.verdict}] ${r.mentionRate14d ?? "-"}% mentioned · ${r.question}`);
    console.log(`      gap: ${r.gap}`);
    if (r.winners.length) console.log(`      cited instead: ${r.winners.join(", ")}`);
  }
  console.log(`\nwrote data/content-coverage.json`);
}

main();
