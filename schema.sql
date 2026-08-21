-- geo-tracker storage schema. SQLite via bun:sqlite.
-- The brand column is the company being measured. It exists so one database
-- can track more than one brand; seed.ts fills it from BRAND_NAME.

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('shortlist', 'howto', 'comparison')),
  persona TEXT NOT NULL DEFAULT 'none',
  brand TEXT NOT NULL,
  -- Comma-separated tags, e.g. "claim-probe:C1" (claims register, 2.1).
  tags TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

-- One row per question x model x run. Failed generations are logged as rows
-- with error set (failures visible, never hidden).
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  model TEXT NOT NULL, -- gpt | claude | perplexity | gemini | google-aio | google-ai-mode
  run_ts TEXT NOT NULL, -- ISO 8601 UTC
  raw_answer TEXT, -- full answer text (JSON for SERP parses)
  citations TEXT, -- JSON array of cited URLs
  error TEXT, -- null on success
  -- Which concrete provider model answered, e.g. 'gemini-3.5-flash'. `model`
  -- above stays the surface name so trend lines survive a model swap; this
  -- column makes the swap visible. Null on rows written before Aug 19 2026.
  model_id TEXT,
  -- Google SERP rows only: 'answer' | 'unavailable' | 'shell', written by the
  -- extraction pass when it parses the stored SERP JSON. Null elsewhere.
  serp_state TEXT
);

CREATE INDEX IF NOT EXISTS runs_question_model_ts ON runs (question_id, model, run_ts);

-- Extraction pass output (Haiku): one row per run per brand checked.
CREATE TABLE IF NOT EXISTS mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  brand TEXT NOT NULL,
  mentioned INTEGER NOT NULL, -- 0/1
  position INTEGER, -- 1st/2nd/3rd in a shortlist; null when absent or n/a
  sentiment TEXT CHECK (sentiment IN ('positive', 'neutral', 'negative', 'inaccurate')),
  competitors TEXT -- JSON array of competitor names that appear
);

CREATE INDEX IF NOT EXISTS mentions_run ON mentions (run_id);

-- Citation ledger (5.4, Sonnet classifies NEW domains only, cached forever).
CREATE TABLE IF NOT EXISTS domains (
  domain TEXT PRIMARY KEY,
  classification TEXT CHECK (classification IN (
    'legit-publisher', 'affiliate-benchmark', 'astroturf',
    'competitor-owned', 'forum', 'docs', 'unclassified'
  )) DEFAULT 'unclassified',
  first_seen TEXT NOT NULL, -- ISO 8601 UTC
  citation_count INTEGER NOT NULL DEFAULT 0
);
