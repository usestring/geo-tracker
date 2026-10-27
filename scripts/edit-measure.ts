// Per-edit measurement: does one shipped change actually move its page?
//
// Site-wide numbers cannot answer that - Google may have lifted (or sunk)
// everything the same week. So every enrolled edit stores a before-snapshot
// of its page AND the rest of the site over the same window, then re-reads
// both at +28 and +56 days. The number that matters is the control-adjusted
// lift:
//
//   lift = page clicks change %  -  rest-of-site clicks change %
//
// The control excludes the measured page itself; a page that carries a third
// of the site would otherwise partially control for its own success. A +20%
// page on a +20% site is a zero. A flat page on a -30% site is a win.
//
// GSC CSVs are weekly pulls of the trailing 28 days. A "+28d reading" is only
// honest from a pull near that date: an early pull's window overlaps the
// before-period, a late pull's window misses the +28 point entirely. Readings
// outside the tolerance are recorded as missed, never silently taken from the
// wrong window.
//
//   enroll <url> [--note "..."] [--date YYYY-MM-DD]   the day the edit ships
//   read                                              take any due readings
//   report                                            print every edit's state
//
// Reads data/gsc/pages-*.csv; writes the `edits` table in data/geo.db.

import { Database } from "bun:sqlite";
import { join } from "path";
import { listPulls, normUrl, readPerfCsv, type Pull } from "./lib/gsc-csv";

const DATA = join(import.meta.dir, "..", "data");
const DB_PATH = join(DATA, "geo.db");
// How far a pull's date may sit from the reading it feeds. Early beyond this
// and the trailing window is mostly "before"; late beyond this and the window
// no longer contains the target point at all.
const EARLY_TOLERANCE_DAYS = 4;
const LATE_TOLERANCE_DAYS = 14;
// Below this many before-clicks a percent lift is noise wearing three
// significant figures; it is still reported, labeled as a low base.
const LOW_BASE_CLICKS = 10;

const db = new Database(DB_PATH);
// Wait on a locked database instead of throwing SQLITE_BUSY: a review run,
// extract and a tracker pass can overlap on the same file.
db.run("PRAGMA busy_timeout = 30000");
db.run(`CREATE TABLE IF NOT EXISTS edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  note TEXT,
  edit_date TEXT NOT NULL,      -- YYYY-MM-DD the edit shipped
  before_json TEXT NOT NULL,    -- page + rest-of-site numbers at enrollment
  read28_json TEXT,             -- reading at edit_date + 28d (or a missed marker)
  read56_json TEXT,             -- reading at edit_date + 56d (or a missed marker)
  created_ts TEXT NOT NULL
)`);

const dayMs = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

interface Snapshot {
  csvDate: string;
  offsetDays: number; // csv date minus the date it stands in for; negative = early
  page: { clicks: number; impressions: number; position: number; found: boolean };
  site: { clicks: number; impressions: number }; // rest of site, page excluded
}

// One parse per pull per process: `read` takes snapshots for every due edit
// and most of them hit the same file.
const pullCache = new Map<string, Map<string, ReturnType<typeof rowOf>>>();
const rowOf = (m: ReturnType<typeof readPerfCsv>, key: string) => m.get(key);
const loadPull = (p: Pull) => {
  let rows = pullCache.get(p.file);
  if (!rows) {
    rows = readPerfCsv(p.file, { normalizeKeys: true });
    pullCache.set(p.file, rows);
  }
  return rows;
};

function snapshotFrom(pull: Pull, url: string, targetTs: number): Snapshot {
  const rows = loadPull(pull);
  const key = normUrl(url);
  const row = rows.get(key);
  let site = { clicks: 0, impressions: 0 };
  for (const r of rows.values()) {
    if (r.key === key) continue;
    site.clicks += r.clicks;
    site.impressions += r.impressions;
  }
  return {
    csvDate: pull.date,
    offsetDays: Math.round((pull.ts - targetTs) / dayMs),
    page: row
      ? { clicks: row.clicks, impressions: row.impressions, position: Number(row.position.toFixed(1)), found: true }
      : { clicks: 0, impressions: 0, position: 0, found: false },
    site,
  };
}

/** The newest pull at or before the date, so a before-snapshot can never be
 *  contaminated by post-edit performance. Null when no such pull exists. */
const pullAtOrBefore = (pulls: Pull[], ts: number): Pull | null =>
  [...pulls].reverse().find((p) => p.ts <= ts) ?? null;

/** The pull nearest the target within the reading tolerance. */
const pullNear = (pulls: Pull[], ts: number): Pull | null => {
  const inWindow = pulls.filter(
    (p) => p.ts >= ts - EARLY_TOLERANCE_DAYS * dayMs && p.ts <= ts + LATE_TOLERANCE_DAYS * dayMs,
  );
  if (inWindow.length === 0) return null;
  return inWindow.reduce((a, b) => (Math.abs(b.ts - ts) < Math.abs(a.ts - ts) ? b : a));
};

const pct = (before: number, after: number) => ((after - before) / Math.max(before, 1)) * 100;

const argOf = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > -1 ? process.argv[i + 1] : undefined;
  return v !== undefined && !v.startsWith("--") ? v : null;
};

const cmd = process.argv[2];

if (cmd === "enroll") {
  const url = process.argv[3];
  if (!url || url.startsWith("--")) {
    console.error('usage: edit-measure.ts enroll <url> [--note "..."] [--date YYYY-MM-DD]');
    process.exit(1);
  }
  const editDate = argOf("date") ?? iso(Date.now());
  const editTs = Date.parse(editDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(editDate) || !Number.isFinite(editTs)) {
    console.error(`--date must be YYYY-MM-DD, got "${editDate}"`);
    process.exit(1);
  }
  const pulls = listPulls(DATA, "pages");
  const before = pullAtOrBefore(pulls, editTs);
  if (!before) {
    console.error(
      pulls.length === 0
        ? "no data/gsc/pages-*.csv - run `make gsc` before enrolling"
        : `no pull at or before ${editDate} - a later pull would contaminate the baseline with post-edit days`,
    );
    process.exit(1);
  }
  const snap = snapshotFrom(before, url, editTs);
  const dupe = db.query(
    `SELECT id, edit_date FROM edits WHERE url = ? AND edit_date >= date(?, '-28 day')`,
  ).get(normUrl(url), editDate) as { id: number; edit_date: string } | null;
  if (dupe) console.log(`note: edit #${dupe.id} for this URL enrolled ${dupe.edit_date} - windows overlap`);
  if (!snap.page.found) console.log("note: page not in the GSC pull yet - before-numbers recorded as zero");
  if (snap.offsetDays < -10) console.log(`note: newest pull before the edit is ${snap.csvDate}, ${-snap.offsetDays}d earlier`);

  db.run(
    `INSERT INTO edits (url, note, edit_date, before_json, created_ts) VALUES (?, ?, ?, ?, ?)`,
    [normUrl(url), argOf("note"), editDate, JSON.stringify(snap), new Date().toISOString()],
  );
  console.log(
    `enrolled ${normUrl(url)} (edit ${editDate}, before: ${snap.page.clicks} clicks / ${snap.page.impressions} impressions, readings due ${iso(editTs + 28 * dayMs)} and ${iso(editTs + 56 * dayMs)})`,
  );
} else if (cmd === "read") {
  const due = db.query(`SELECT * FROM edits WHERE read28_json IS NULL OR read56_json IS NULL`).all() as any[];
  const pulls = listPulls(DATA, "pages");
  const newest = pulls[pulls.length - 1];
  let taken = 0;
  let stillMeasuring = 0;
  for (const e of due) {
    const before = JSON.parse(e.before_json) as Snapshot;
    const editTs = Date.parse(e.edit_date);
    if (!Number.isFinite(editTs)) {
      console.log(`edit #${e.id} has an unreadable edit_date "${e.edit_date}" - skipping`);
      continue;
    }
    let unfilled = 0;
    for (const [days, col] of [[28, "read28_json"], [56, "read56_json"]] as const) {
      if (e[col]) continue;
      const targetTs = editTs + days * dayMs;
      if (targetTs > Date.now()) {
        unfilled++;
        continue;
      }
      const pull = pullNear(pulls, targetTs);
      if (!pull) {
        // Pulls only ever get later; once the newest one is past the late
        // tolerance the window can never be filled, and recording that beats
        // leaving an eternally-pending reading.
        if (newest && newest.ts > targetTs + LATE_TOLERANCE_DAYS * dayMs) {
          db.run(`UPDATE edits SET ${col} = ? WHERE id = ?`, [
            JSON.stringify({ missed: true, targetDate: iso(targetTs), reason: "no GSC pull within tolerance of the reading date" }),
            e.id,
          ]);
          console.log(`edit #${e.id} +${days}d: window missed - no pull within -${EARLY_TOLERANCE_DAYS}/+${LATE_TOLERANCE_DAYS}d of ${iso(targetTs)}`);
          taken++;
        } else {
          console.log(`edit #${e.id} +${days}d due but no pull near ${iso(targetTs)} yet - run \`make gsc\``);
          unfilled++;
        }
        continue;
      }
      const now = snapshotFrom(pull, e.url, targetTs);
      const pageDelta = pct(before.page.clicks, now.page.clicks);
      const siteDelta = pct(before.site.clicks, now.site.clicks);
      const reading = {
        ...now,
        targetDate: iso(targetTs),
        pageClicksDeltaPct: Number(pageDelta.toFixed(1)),
        siteClicksDeltaPct: Number(siteDelta.toFixed(1)),
        liftPct: Number((pageDelta - siteDelta).toFixed(1)),
        lowBase: before.page.clicks < LOW_BASE_CLICKS,
      };
      db.run(`UPDATE edits SET ${col} = ? WHERE id = ?`, [JSON.stringify(reading), e.id]);
      console.log(
        `edit #${e.id} +${days}d: page ${reading.pageClicksDeltaPct}% vs site ${reading.siteClicksDeltaPct}% -> lift ${reading.liftPct}%${reading.lowBase ? " (low base)" : ""}  ${e.url}`,
      );
      taken++;
    }
    if (unfilled > 0) stillMeasuring++;
  }
  console.log(`${taken} reading(s) taken, ${stillMeasuring} edit(s) still measuring`);
} else if (cmd === "report") {
  const all = db.query(`SELECT * FROM edits ORDER BY edit_date DESC`).all() as any[];
  if (all.length === 0) console.log("no enrolled edits - `make edit-enroll URL=... NOTE=...` when a change ships");
  for (const e of all) {
    const before = JSON.parse(e.before_json) as Snapshot;
    const fmt = (json: string | null, label: string) => {
      if (!json) return `${label}: pending`;
      const r = JSON.parse(json);
      if (r.missed) return `${label}: window missed (${r.reason})`;
      const base = r.lowBase ? `, low base` : "";
      return `${label}: lift ${r.liftPct > 0 ? "+" : ""}${r.liftPct}% (page ${r.pageClicksDeltaPct}%, site ${r.siteClicksDeltaPct}%${base})`;
    };
    console.log(`#${e.id} ${e.edit_date} ${e.url}`);
    if (e.note) console.log(`   ${e.note}`);
    console.log(`   before ${before.page.clicks} clicks | ${fmt(e.read28_json, "+28d")} | ${fmt(e.read56_json, "+56d")}`);
  }
} else {
  console.error("usage: edit-measure.ts enroll|read|report");
  process.exit(1);
}
