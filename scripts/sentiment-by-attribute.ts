// Sentiment by attribute (make sentiment): when an engine talks ABOUT your
// brand, what does it say per attribute? Scope is the questions that
// interrogate the brand directly - branded (cat:company) plus type:sentiment
// questions - and the attribute is the theme:* tag each carries (the tag spec
// says sentiment questions name the attribute they diagnose). With no
// type:sentiment tags in the bank, this reads the branded set alone.
//
// Per theme, over 14 days of latest-row extracted mentions where the brand was
// mentioned: positive/neutral/negative/inaccurate counts, and the net-positive
// share ((positive - negative - inaccurate) / total) this week vs last week.
// Writes data/sentiment-by-attribute.json.

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { themeOf, typeOf, isBranded } from "./lib/tags";
import { BRAND_NAME } from "./brand.ts";

const DB_PATH = join(import.meta.dir, "..", "data", "geo.db");
const OUT_PATH = join(import.meta.dir, "..", "data", "sentiment-by-attribute.json");
const db = new Database(DB_PATH, { readonly: true });

interface Row { question_id: number; d: string; sentiment: string | null; tags: string }

const rows = db.query(`
  SELECT r.question_id, date(r.run_ts) d, m.sentiment, q.tags
  FROM runs r
  JOIN (
    SELECT question_id, model, date(run_ts) d, MAX(id) mid
    FROM runs GROUP BY question_id, model, date(run_ts)
  ) k ON k.mid = r.id
  JOIN mentions m ON m.run_id = r.id AND m.brand = $brand
  JOIN questions q ON q.id = r.question_id
  WHERE r.error IS NULL AND m.mentioned = 1
    AND date(r.run_ts) > date('now', '-14 day')
    AND (r.model NOT IN ('google-aio','google-ai-mode') OR r.serp_state = 'answer')
`).all({ $brand: BRAND_NAME.toLowerCase() }) as Row[];

const inScope = (tags: string) => isBranded(tags) || typeOf(tags) === "sentiment";
const scoped = rows.filter((r) => inScope(r.tags));

const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
const SENTIMENTS = ["positive", "neutral", "negative", "inaccurate"] as const;

function tally(sel: Row[]) {
  const counts: Record<string, number> = { positive: 0, neutral: 0, negative: 0, inaccurate: 0 };
  for (const r of sel) if (r.sentiment && r.sentiment in counts) counts[r.sentiment]++;
  const total = SENTIMENTS.reduce((a, s) => a + counts[s], 0);
  const netPositive = total === 0 ? null
    : Number((((counts.positive - counts.negative - counts.inaccurate) / total) * 100).toFixed(1));
  return { counts, total, netPositive };
}

const themes = [...new Set(scoped.map((r) => themeOf(r.tags)).filter((t): t is string => !!t))].sort();
const byTheme = themes.map((theme) => {
  const sel = scoped.filter((r) => themeOf(r.tags) === theme);
  const all14 = tally(sel);
  const cur = tally(sel.filter((r) => r.d > weekAgo));
  const prv = tally(sel.filter((r) => r.d <= weekAgo));
  return {
    theme,
    counts: all14.counts,
    total: all14.total,
    netPositive: all14.netPositive,
    netPositive7d: cur.netPositive,
    netPositivePrev7d: prv.netPositive,
    deltaPts: cur.netPositive !== null && prv.netPositive !== null
      ? Number((cur.netPositive - prv.netPositive).toFixed(1))
      : null
  };
});

const hasSentimentTags = (db.query("SELECT COUNT(*) c FROM questions WHERE active=1 AND tags LIKE '%type:sentiment%'").get() as any).c > 0;

const out = {
  generatedAt: new Date().toISOString(),
  windowDays: 14,
  scope: hasSentimentTags ? "branded (cat:company) + type:sentiment questions" : "branded (cat:company) questions only - no type:sentiment tags in the bank yet",
  note: `counts are 14d latest-row mentions where ${BRAND_NAME} is named; netPositive = (positive - negative - inaccurate) / total, in %, week over week.`,
  byTheme
};
await Bun.write(OUT_PATH, JSON.stringify(out, null, 2));

for (const t of byTheme) {
  const c = t.counts;
  const wow = t.deltaPts === null ? "" : ` (${t.deltaPts > 0 ? "+" : ""}${t.deltaPts}pt WoW)`;
  console.log(
    `${t.theme.padEnd(14)} +${c.positive} ·${c.neutral} -${c.negative} !${c.inaccurate}  net ${t.netPositive ?? "—"}%${wow}`
  );
}
if (byTheme.length === 0) console.log("no in-scope mention rows in the window");
console.log(`-> ${OUT_PATH}`);
