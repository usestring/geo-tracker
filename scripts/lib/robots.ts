// robots.txt group parsing and evaluation (robots-audit.ts). Follows the
// RFC 9309 rules that matter for an audit:
//   - consecutive User-agent lines share one rule group
//   - a crawler obeys the MOST SPECIFIC matching group only (longest
//     user-agent token that is a substring of the crawler name), falling back
//     to the * group; it never merges groups
//   - within the governing group, the longest matching path rule wins; on an
//     allow/disallow tie of equal length, allow wins
//   - no matching rule, or no governing group at all, means allowed
// Pure text-in / verdict-out so it can be unit tested without the network.

export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsGroup {
  agents: string[]; // lowercased user-agent tokens
  rules: RobotsRule[];
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  contentSignals: string[]; // raw Content-Signal: lines, if any
  sitemaps: string[];
}

export function parseRobotsTxt(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const contentSignals: string[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let agentsOpen = false; // consecutive User-agent lines extend the same group

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();

    if (field === "user-agent") {
      if (!agentsOpen || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
        agentsOpen = true;
      }
      current.agents.push(value.toLowerCase());
    } else if (field === "allow" || field === "disallow") {
      agentsOpen = false;
      if (!current) continue; // rule before any User-agent line: ignored
      // An empty Disallow means "allow everything" - representable as an
      // allow rule of length 0 that any longer rule outranks.
      if (value === "" && field === "disallow") {
        current.rules.push({ allow: true, path: "" });
      } else if (value !== "") {
        current.rules.push({ allow: field === "allow", path: value });
      }
    } else if (field === "content-signal") {
      contentSignals.push(`${m[1]}: ${value}`);
    } else if (field === "sitemap") {
      sitemaps.push(value);
    } else {
      agentsOpen = false; // any other field closes the User-agent run
    }
  }
  return { groups, contentSignals, sitemaps };
}

/** The group governing this crawler: most specific user-agent match wins,
 *  then the * group, then null (= no rules apply, everything allowed). */
export function governingGroup(parsed: ParsedRobots, crawler: string): RobotsGroup | null {
  const name = crawler.toLowerCase();
  let best: RobotsGroup | null = null;
  let bestLen = -1;
  for (const g of parsed.groups) {
    for (const agent of g.agents) {
      if (agent === "*") continue;
      if (name.includes(agent) && agent.length > bestLen) {
        best = g;
        bestLen = agent.length;
      }
    }
  }
  if (best) return best;
  return parsed.groups.find((g) => g.agents.includes("*")) ?? null;
}

// Path rules may carry * wildcards and a $ end anchor.
function ruleMatches(rulePath: string, path: string): boolean {
  if (rulePath === "") return true;
  if (!rulePath.includes("*") && !rulePath.endsWith("$")) return path.startsWith(rulePath);
  const rx = new RegExp(
    "^" +
      rulePath
        .replace(/[.+?^{}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\\?\$$/, "$")
  );
  return rx.test(path);
}

/** Is `path` allowed for the crawler this group governs? */
export function isPathAllowed(group: RobotsGroup | null, path: string): boolean {
  if (!group) return true;
  let verdict = true;
  let bestLen = -1;
  for (const r of group.rules) {
    if (!ruleMatches(r.path, path)) continue;
    const len = r.path.length;
    // Longest match wins; on a tie, allow wins (r.allow beats an equal-length
    // disallow because we only overwrite on strictly-longer disallows).
    if (len > bestLen || (len === bestLen && r.allow)) {
      verdict = r.allow;
      bestLen = len;
    }
  }
  return verdict;
}
