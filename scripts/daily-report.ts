// Daily report (make daily-report) -> one print-ready HTML page: today's run
// health per surface, today's non-branded mention rate against the trailing
// 7-day average, new citation domains first seen today, and any surface that
// produced zero clean rows (that day is unmeasured, not zero).
//
// Reads data/geo.db directly - the daily numbers are cheap enough that no
// side-output is worth staling on. Emits data/daily-report.html; print it to
// PDF with any browser if you want a file to circulate.

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { BRAND_NAME } from "./brand.ts";

const DB_PATH = join(import.meta.dir, "..", "data", "geo.db");
const OUT = join(import.meta.dir, "..", "data", "daily-report.html");
const db = new Database(DB_PATH, { readonly: true });

const esc = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const p1 = (v: number) => `${v.toFixed(1)}%`;

const SURFACE_LABEL: Record<string, string> = {
  gpt: "ChatGPT", claude: "Claude", perplexity: "Perplexity", gemini: "Gemini",
  "google-aio": "Google AIO", "google-ai-mode": "AI Mode",
  "chatgpt-app": "ChatGPT app", "chatgpt-app-search": "ChatGPT app (search)",
  "claude-app": "Claude app", "perplexity-app": "Perplexity app"
};

// Latest row per question x model for today (retries append rows).
const LATEST_TODAY = `
  JOIN (
    SELECT question_id, model, date(run_ts) d, MAX(id) mid
    FROM runs GROUP BY question_id, model, date(run_ts)
  ) k ON k.mid = r.id`;

const health = db.query(`
  SELECT r.model,
         COUNT(*) attempts,
         SUM(CASE WHEN r.error IS NULL AND (r.serp_state IS NULL OR r.serp_state != 'shell') THEN 1 ELSE 0 END) ok
  FROM runs r ${LATEST_TODAY}
  WHERE date(r.run_ts) = date('now')
  GROUP BY r.model ORDER BY r.model
`).all() as { model: string; attempts: number; ok: number }[];

const deadSurfaces = health.filter((h) => h.ok === 0).map((h) => h.model);

// Non-branded mention rate, mention-trustworthy rows (matches summary.ts):
// Google surfaces only count when serp_state = 'answer'.
const mentionRate = (whereDay: string) => {
  const r = db.query(`
    SELECT COUNT(*) n, SUM(CASE WHEN m.mentioned = 1 THEN 1 ELSE 0 END) hits
    FROM runs r ${LATEST_TODAY}
    JOIN questions q ON q.id = r.question_id
    LEFT JOIN mentions m ON m.run_id = r.id AND m.brand = $brand
    WHERE r.error IS NULL
      AND ${whereDay}
      AND q.tags NOT LIKE '%cat:company%'
      AND (r.model NOT IN ('google-aio','google-ai-mode') OR r.serp_state = 'answer')
  `).get({ $brand: BRAND_NAME.toLowerCase() }) as { n: number; hits: number | null };
  return { n: r.n, pct: r.n === 0 ? null : (100 * (r.hits ?? 0)) / r.n };
};
const todayRate = mentionRate(`date(r.run_ts) = date('now')`);
const weekRate = mentionRate(`date(r.run_ts) > date('now','-7 day') AND date(r.run_ts) < date('now')`);

const newDomains = db.query(`
  SELECT domain, classification, citation_count FROM domains
  WHERE date(first_seen) = date('now') ORDER BY citation_count DESC
`).all() as { domain: string; classification: string; citation_count: number }[];

const today = new Date().toISOString().slice(0, 10);

const deltaTag = () => {
  if (todayRate.pct === null || weekRate.pct === null) return `<span class="d flat">no baseline</span>`;
  const d = todayRate.pct - weekRate.pct;
  if (Math.abs(d) < 0.05) return `<span class="d flat">flat vs 7d avg</span>`;
  return `<span class="d ${d > 0 ? "up" : "dn"}">${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(1)}pt vs 7d avg</span>`;
};

const healthRows = health.map((h) => `<tr>
  <td>${esc(SURFACE_LABEL[h.model] ?? h.model)}</td>
  <td class="n">${h.ok}</td><td class="n">${h.attempts}</td>
  <td>${h.ok === 0 ? `<span class="bad">ZERO CLEAN ROWS</span>` : h.ok < h.attempts ? `<span class="warn">${h.attempts - h.ok} failed</span>` : `<span class="ok">clean</span>`}</td></tr>`).join("");

const domainRows = newDomains.length === 0
  ? `<p class="lead">No new citation domains today.</p>`
  : `<table class="t sm"><thead><tr><th>Domain</th><th>Class</th><th class="n">Citations</th></tr></thead><tbody>
     ${newDomains.map((d) => `<tr><td>${esc(d.domain)}</td><td>${esc(d.classification)}</td><td class="n">${d.citation_count}</td></tr>`).join("")}
     </tbody></table>`;

const BODY = `
<header>
  <div class="eb">${esc(BRAND_NAME)} · answer-engine visibility</div>
  <h1>Daily report — ${esc(today)}</h1>
</header>

<section>
  <div class="score">
    <div class="sc"><div class="k">Mentioned today, non-branded</div><div class="v">${todayRate.pct === null ? "—" : p1(todayRate.pct)}</div>${deltaTag()}</div>
    <div class="sc"><div class="k">7-day average</div><div class="v">${weekRate.pct === null ? "—" : p1(weekRate.pct)}</div><span class="d flat">${weekRate.n} clean answers</span></div>
    <div class="sc"><div class="k">Clean rows today</div><div class="v">${health.reduce((a, h) => a + h.ok, 0)}<span class="vs">/${health.reduce((a, h) => a + h.attempts, 0)}</span></div><span class="d flat">${health.length} surface${health.length === 1 ? "" : "s"} ran</span></div>
    <div class="sc"><div class="k">New domains today</div><div class="v">${newDomains.length}</div><span class="d flat">first seen in citations</span></div>
  </div>
  ${deadSurfaces.length > 0 ? `<div class="alert">Unmeasured today: <b>${esc(deadSurfaces.map((m) => SURFACE_LABEL[m] ?? m).join(", "))}</b> produced zero clean rows — that surface's day is missing, not zero.</div>` : ""}
</section>

<section>
  <h2>Run health per surface — today, latest row per question</h2>
  <table class="t"><thead><tr><th>Surface</th><th class="n">Clean</th><th class="n">Attempted</th><th>State</th></tr></thead>
  <tbody>${healthRows || `<tr><td colspan="4">no runs recorded today</td></tr>`}</tbody></table>
  <p class="lead">Mention rate counts Google rows only when Google showed an AI answer; unrendered SERP shells are excluded everywhere.</p>
</section>

<section>
  <h2>New citation domains — first seen today</h2>
  ${domainRows}
</section>

<footer>Generated ${esc(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC · make daily-report</footer>`;

const CSS = `
@page{size:letter;margin:13mm 15mm 15mm}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font-family:-apple-system,"Segoe UI",system-ui,sans-serif;color:#141824;font-size:10px;line-height:1.5}
header{border-bottom:2px solid #0647D4;padding-bottom:11px;margin-bottom:14px}
.eb{font-family:ui-monospace,Menlo,monospace;font-size:8.5px;letter-spacing:.13em;text-transform:uppercase;color:#0647D4;font-weight:700}
h1{font-size:25px;letter-spacing:-.02em;margin:5px 0 4px;font-weight:800}
section{margin:0 0 12px}
h2{font-size:13.5px;font-weight:800;letter-spacing:-.01em;margin:15px 0 5px;padding-top:9px;border-top:1px solid #E4E8F2}
.lead{color:#48506A;margin:5px 0 7px;font-size:9.5px}
.score{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin:4px 0 3px}
.sc{border:1px solid #E4E8F2;border-radius:7px;padding:9px 11px}
.sc .k{font-size:8px;text-transform:uppercase;letter-spacing:.05em;color:#7B84A0;font-family:ui-monospace,Menlo,monospace}
.sc .v{font-size:24px;font-weight:800;letter-spacing:-.02em;margin:2px 0;font-variant-numeric:tabular-nums}
.sc .vs{font-size:13px;color:#9098B2;font-weight:600}
.d{font-family:ui-monospace,Menlo,monospace;font-size:8px;font-weight:700}
.d.up{color:#0C7A41} .d.dn{color:#A5361F} .d.flat{color:#7B84A0}
.alert{background:#FBE6E1;border:1px solid #F0C4BA;border-radius:6px;padding:8px 10px;font-size:9.5px;color:#A5361F;margin:9px 0}
table.t{width:100%;border-collapse:collapse;margin-top:3px}
.t.sm{font-size:9px}
.t th{text-align:left;font-family:ui-monospace,Menlo,monospace;font-size:7.5px;text-transform:uppercase;letter-spacing:.05em;color:#7B84A0;border-bottom:1.5px solid #D8DEEC;padding:4px 6px;font-weight:600}
.t td{padding:5px 6px;border-bottom:.5px solid #EDF0F7;vertical-align:top}
.n{text-align:right;font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}
.ok{color:#0C7A41;font-weight:700}.warn{color:#8A5A08;font-weight:700}.bad{color:#A5361F;font-weight:800}
footer{margin-top:14px;padding-top:10px;border-top:1px solid #E4E8F2;color:#9098B2;font-size:8px;font-family:ui-monospace,Menlo,monospace}
`;

await Bun.write(OUT, `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${CSS}</style></head><body>${BODY}</body></html>`);
console.log(`daily report html: ${OUT}`);
if (deadSurfaces.length > 0) console.log(`warning: zero clean rows today on ${deadSurfaces.join(", ")}`);
