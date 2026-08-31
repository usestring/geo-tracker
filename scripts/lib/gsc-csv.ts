// Shared plumbing for the GSC CSV pulls (written by gsc.ts, read by
// opportunity.ts and edit-measure.ts).
//
// One URL normalizer and one row parser on purpose: when two scripts key the
// same page differently, their numbers silently disagree, and the join between
// a before-snapshot and a later pull is only as good as the weakest copy.
//
// The parser understands gsc.ts's own quoting (csvCell wraps any field holding
// a comma, quote or newline, with "" escaping) - search queries contain commas
// routinely, and a plain split() shifts every column after one.
//
// Every pull is assumed to be a trailing-28d window (the `make gsc` default).
// The filename carries the pull date, not the window length, so a hand-run
// --days=7 pull would skew every consumer here.

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

export const normUrl = (u: string): string =>
  u.replace("://www.", "://").replace(/\/$/, "");

export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"' && cur === "") {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export interface PerfRow {
  key: string;
  clicks: number;
  impressions: number;
  // Weighted by impressions when normalization folds www/apex variants of one
  // page into one row.
  position: number;
}

/**
 * Read a queries-*.csv or pages-*.csv into rows keyed by the first column.
 * `normalizeKeys` is for page URLs only - query text goes through untouched.
 * Key collisions (www vs apex variants of one page) SUM rather than overwrite,
 * so neither variant's clicks vanish from a ranking.
 *
 * CTR is derived from clicks/impressions rather than read from the file, so a
 * percent-formatted export can never poison a lever with NaN.
 */
export function readPerfCsv(file: string, { normalizeKeys = false } = {}): Map<string, PerfRow> {
  const rows = new Map<string, PerfRow>();
  for (const line of readFileSync(file, "utf8").split("\n").slice(1)) {
    if (!line.trim()) continue;
    const cols = splitCsvLine(line);
    if (cols.length < 5) continue;
    const key = normalizeKeys ? normUrl(cols[0]) : cols[0];
    const clicks = Number(cols[1] || 0);
    const impressions = Number(cols[2] || 0);
    const position = Number(cols[4] || 0);
    if (!Number.isFinite(clicks) || !Number.isFinite(impressions)) continue;
    const prev = rows.get(key);
    if (prev) {
      const imp = prev.impressions + impressions;
      rows.set(key, {
        key,
        clicks: prev.clicks + clicks,
        impressions: imp,
        position: imp > 0 ? (prev.position * prev.impressions + position * impressions) / imp : 0,
      });
    } else {
      rows.set(key, { key, clicks, impressions, position });
    }
  }
  return rows;
}

export interface Pull {
  file: string;
  date: string; // YYYY-MM-DD
  ts: number;
}

/** Dated pulls for one export kind, oldest first. Strict on the filename so a
 *  stray `pages-latest.csv` or editor backup can never become "the newest". */
export function listPulls(dataDir: string, prefix: "pages" | "queries"): Pull[] {
  let files: string[] = [];
  try {
    files = readdirSync(join(dataDir, "gsc"));
  } catch {
    return [];
  }
  const re = new RegExp(`^${prefix}-(\\d{4})(\\d{2})(\\d{2})\\.csv$`);
  return files
    .map((f) => {
      const m = f.match(re);
      if (!m) return null;
      const date = `${m[1]}-${m[2]}-${m[3]}`;
      return { file: join(dataDir, "gsc", f), date, ts: Date.parse(date) };
    })
    .filter((p): p is Pull => p !== null && Number.isFinite(p.ts))
    .sort((a, b) => a.ts - b.ts);
}
