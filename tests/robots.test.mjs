// robots-audit.ts stands or falls on the parser: RFC 9309 group selection is
// "most specific match wins, groups never merge", and getting that wrong
// reports a crawler as governed by * when a dedicated group blocks it (or the
// reverse). These pin the rules the audit relies on. No network.
import { test, expect } from "bun:test";
import { parseRobotsTxt, governingGroup, isPathAllowed } from "../scripts/lib/robots.ts";

const ROBOTS = `
# comment
User-agent: *
Disallow: /admin

User-agent: GPTBot
User-agent: CCBot
Disallow: /

User-agent: PerplexityBot
Disallow: /private
Allow: /private/ok

Content-Signal: ai-train=no, search=yes
Sitemap: https://example.com/sitemap.xml
`;

const parsed = parseRobotsTxt(ROBOTS);

test("consecutive User-agent lines share one group; other groups stay separate", () => {
  expect(parsed.groups.length).toBe(3);
  expect(parsed.groups[1].agents).toEqual(["gptbot", "ccbot"]);
});

test("most specific group wins over *; unlisted crawlers fall back to *", () => {
  expect(governingGroup(parsed, "GPTBot").agents).toContain("gptbot");
  expect(governingGroup(parsed, "ClaudeBot").agents).toEqual(["*"]);
});

test("Disallow: / blocks root; the * group leaves root open", () => {
  expect(isPathAllowed(governingGroup(parsed, "GPTBot"), "/")).toBe(false);
  expect(isPathAllowed(governingGroup(parsed, "ClaudeBot"), "/")).toBe(true);
});

test("longest matching path rule wins within a group", () => {
  const g = governingGroup(parsed, "PerplexityBot");
  expect(isPathAllowed(g, "/")).toBe(true);
  expect(isPathAllowed(g, "/private/x")).toBe(false);
  expect(isPathAllowed(g, "/private/ok/page")).toBe(true);
});

test("empty robots.txt (or none) allows everything", () => {
  const empty = parseRobotsTxt("");
  expect(governingGroup(empty, "GPTBot")).toBeNull();
  expect(isPathAllowed(null, "/")).toBe(true);
});

test("empty Disallow means allow-all and cannot outrank a longer disallow", () => {
  const p = parseRobotsTxt("User-agent: X\nDisallow:\nDisallow: /blocked");
  const g = governingGroup(p, "X");
  expect(isPathAllowed(g, "/")).toBe(true);
  expect(isPathAllowed(g, "/blocked/page")).toBe(false);
});

test("Content-Signal and wildcard paths are picked up", () => {
  expect(parsed.contentSignals[0]).toContain("ai-train=no");
  const p = parseRobotsTxt("User-agent: X\nDisallow: /*.pdf$");
  const g = governingGroup(p, "X");
  expect(isPathAllowed(g, "/a/b.pdf")).toBe(false);
  expect(isPathAllowed(g, "/a/b.pdfx")).toBe(true);
});
