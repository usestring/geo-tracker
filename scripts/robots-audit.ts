// Robots audit (make robots-audit): are the AI crawlers that MATTER allowed
// in? A blocked answer-retrieval or search-index crawler silently zeroes a
// surface's ability to cite us - that is a FAULT. A blocked training crawler
// is a policy choice - noted, never flagged.
//
// Fetches robots.txt from every audited host, evaluates the crawler list
// against properly-parsed user-agent groups (most-specific group wins;
// per-group Allow/Disallow, longest match; see lib/robots.ts and its tests),
// reports any Content-Signal line, and checks llms.txt reachability.
//
// Diffs against the previous data/robots-audit.json (kept as .prev before
// overwrite) and prints CHANGED lines, so a deploy that flips a rule shows up
// the next morning.

import { join } from "node:path";
import { existsSync, readFileSync, copyFileSync } from "node:fs";
import { parseRobotsTxt, governingGroup, isPathAllowed } from "./lib/robots";
import { BRAND_SITE } from "./brand.ts";

const OUT_PATH = join(import.meta.dir, "..", "data", "robots-audit.json");
const PREV_PATH = OUT_PATH + ".prev";

// Which hosts to audit, each at the path that matters for AI visibility on
// it. Defaults to your BRAND_DOMAIN at "/". ROBOTS_AUDIT_HOSTS in .env adds
// or replaces hosts, comma-separated, each as url=path. Audit a host at a
// deeper path when its root is robots-blocked by design - e.g. a docs portal
// whose sign-in shell blocks "/" on purpose would otherwise flag every
// deliberate block as a fault. We run it as:
//   ROBOTS_AUDIT_HOSTS=https://usestring.ai=/,https://portal.usestring.ai=/docs
const HOSTS: [string, string][] = (process.env.ROBOTS_AUDIT_HOSTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry): [string, string] => {
    const i = entry.indexOf("=", entry.indexOf("://") + 3);
    return i === -1 ? [entry.replace(/\/$/, ""), "/"] : [entry.slice(0, i).replace(/\/$/, ""), entry.slice(i + 1) || "/"];
  });
if (HOSTS.length === 0) HOSTS.push([BRAND_SITE, "/"]);
const LLMS_TXT = `${BRAND_SITE}/llms.txt`;

type Role = "answer-retrieval" | "training" | "search-index";
const CRAWLERS: [string, Role][] = [
  ["GPTBot", "training"],
  ["OAI-SearchBot", "search-index"],
  ["ChatGPT-User", "answer-retrieval"],
  ["ClaudeBot", "training"],
  ["Claude-SearchBot", "search-index"],
  ["Claude-User", "answer-retrieval"],
  ["PerplexityBot", "search-index"],
  ["Perplexity-User", "answer-retrieval"],
  ["CCBot", "training"],
  ["Google-Extended", "training"],
  ["Googlebot", "search-index"],
  ["Bytespider", "training"],
  ["Amazonbot", "search-index"],
  ["meta-externalagent", "training"],
  ["Applebot-Extended", "training"]
];

interface CrawlerVerdict {
  crawler: string;
  role: Role;
  group: string; // the user-agent token(s) of the governing group, or "(none)"
  rootAllowed: boolean;
  fault: boolean; // answer-retrieval / search-index crawler blocked
  policyNote: boolean; // training crawler blocked - deliberate, not a fault
}

interface HostAudit {
  host: string;
  fetched: boolean;
  status: number | null;
  contentSignals: string[];
  crawlers: CrawlerVerdict[];
}

async function auditHost(host: string, auditPath: string): Promise<HostAudit> {
  let status: number | null = null;
  let text = "";
  try {
    const res = await fetch(`${host}/robots.txt`, { signal: AbortSignal.timeout(15000) });
    status = res.status;
    if (res.ok) text = await res.text();
  } catch {
    // unreachable - fetched stays false
  }
  const fetched = status !== null && status >= 200 && status < 300;
  // No robots.txt (or an unreachable one) means nothing is blocked.
  const parsed = parseRobotsTxt(fetched ? text : "");
  const crawlers = CRAWLERS.map(([crawler, role]) => {
    const group = governingGroup(parsed, crawler);
    const rootAllowed = isPathAllowed(group, auditPath);
    const blocked = !rootAllowed;
    return {
      crawler,
      role,
      group: group ? group.agents.join(", ") : "(none)",
      rootAllowed,
      fault: blocked && role !== "training",
      policyNote: blocked && role === "training"
    };
  });
  return { host, fetched, status, contentSignals: parsed.contentSignals, crawlers };
}

const hosts: HostAudit[] = [];
for (const [host, path] of HOSTS) hosts.push(await auditHost(host, path));

let llmsTxtStatus: number | null = null;
try {
  const res = await fetch(LLMS_TXT, { signal: AbortSignal.timeout(15000) });
  llmsTxtStatus = res.status;
} catch {}
const llmsTxtOk = llmsTxtStatus === 200;

const faults: string[] = [];
for (const h of hosts) {
  if (!h.fetched) faults.push(`${h.host}/robots.txt unreachable (status ${h.status ?? "network error"})`);
  for (const c of h.crawlers) {
    if (c.fault) faults.push(`${h.host}: ${c.crawler} (${c.role}) blocked from / by group [${c.group}]`);
  }
}
if (!llmsTxtOk) faults.push(`llms.txt not reachable (status ${llmsTxtStatus ?? "network error"}) - expected 200`);

const out = {
  generatedAt: new Date().toISOString(),
  hosts,
  llmsTxt: { url: LLMS_TXT, status: llmsTxtStatus, ok: llmsTxtOk },
  faults,
  policyNotes: hosts.flatMap((h) =>
    h.crawlers.filter((c) => c.policyNote).map((c) => `${h.host}: ${c.crawler} (training) blocked - policy, not a fault`)
  )
};

// --- diff against the previous audit ------------------------------------------

const lineOf = (h: HostAudit, c: CrawlerVerdict) =>
  `${h.host} ${c.crawler}: ${c.rootAllowed ? "allowed" : "BLOCKED"} (group [${c.group}])`;
const linesOf = (audit: typeof out): Map<string, string> => {
  const m = new Map<string, string>();
  for (const h of audit.hosts ?? []) for (const c of h.crawlers ?? []) m.set(`${h.host}|${c.crawler}`, lineOf(h, c));
  m.set("llms.txt", `llms.txt: status ${audit.llmsTxt?.status ?? "?"}`);
  for (const h of audit.hosts ?? []) m.set(`${h.host}|content-signal`, `${h.host} Content-Signal: ${(h.contentSignals ?? []).join(" | ") || "(none)"}`);
  return m;
};

if (existsSync(OUT_PATH)) {
  try {
    const prev = JSON.parse(readFileSync(OUT_PATH, "utf8"));
    const before = linesOf(prev);
    const after = linesOf(out);
    let changes = 0;
    for (const [key, line] of after) {
      const old = before.get(key);
      if (old !== undefined && old !== line) {
        console.log(`CHANGED: ${old}  ->  ${line}`);
        changes++;
      }
    }
    if (changes === 0) console.log("no changes since the previous audit");
  } catch {
    console.log("previous audit unreadable - skipping the diff");
  }
  copyFileSync(OUT_PATH, PREV_PATH);
}

await Bun.write(OUT_PATH, JSON.stringify(out, null, 2));

for (const h of hosts) {
  console.log(`${h.host}/robots.txt: ${h.fetched ? `fetched (${h.status})` : `UNREACHABLE (${h.status ?? "network error"})`}`);
  if (h.contentSignals.length > 0) console.log(`  Content-Signal: ${h.contentSignals.join(" | ")}`);
  for (const c of h.crawlers) {
    const mark = c.fault ? "FAULT " : c.policyNote ? "policy" : "ok    ";
    console.log(`  ${mark} ${c.crawler.padEnd(20)} ${c.role.padEnd(16)} / ${c.rootAllowed ? "allowed" : "blocked"}  group [${c.group}]`);
  }
}
console.log(`llms.txt: ${llmsTxtOk ? "reachable (200)" : `NOT OK (${llmsTxtStatus ?? "network error"})`}`);
console.log(faults.length === 0 ? "no faults" : `${faults.length} FAULT(S):\n  ${faults.join("\n  ")}`);
console.log(`-> ${OUT_PATH}`);
