// Internal-link finder: which of our own pages should link to the pages that
// sit just off Google's page one, and in which paragraph.
//
// The weekly review used to propose "add internal links" as a vague line. This
// makes it a list an agent can apply: for each target page averaging position
// 10.5-20.5 on real impressions, every live sibling page that already talks
// about the target's subject but does not link to it, with the paragraph where
// the link would go. The agent (or a person) writes the anchor text per
// sentence; nothing here edits a page.
//
// It also lists sitemap URLs Google has not indexed together with how many
// content pages link to them, because an unlinked page is the usual reason
// Google leaves it at "Discovered - currently not indexed".
//
// Reads:  data/gsc/pages-*.csv (latest pull), data/gsc/coverage-*.csv (latest),
//         your site's markdown content at CONTENT_REF (default origin/main) via
//         git, so a dirty checkout on another branch does not matter.
// Writes: data/internal-links.json and data/internal-links.md.
//
// Configure in .env:
//   LANDING_DIR   local git clone of your site's source (required)
//   CONTENT_DIRS  comma-separated dir:route pairs, markdown with front matter
//                 (default src/content/comparisons:/comparisons,src/content/answers:/answers)
//   CONTENT_REF   the git ref to read (default origin/main; fetched first when
//                 it names an origin/ branch)
//   SITE_URL      the public origin those routes live on (default https://BRAND_DOMAIN)
//
// A page's subject (the term a sibling must mention) comes from its slug:
// "<x>-alternatives" -> the first `competitors:` front-matter entry, else x;
// "<brand>-vs-<x>" -> the first `competitors:` entry that is not your brand.

import { execFileSync } from "child_process";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { listPulls, normUrl, readPerfCsv, splitCsvLine } from "./lib/gsc-csv";
import { BRAND_NAME, BRAND_SITE } from "./brand.ts";

const DATA = join(import.meta.dir, "..", "data");
const LANDING = process.env.LANDING_DIR ?? "";
if (!LANDING) {
  console.error("internal-links: set LANDING_DIR in .env to a local git clone of your site's source");
  process.exit(1);
}
const SITE = (process.env.SITE_URL ?? BRAND_SITE).replace(/\/$/, "");
const REF = process.env.CONTENT_REF ?? "origin/main";
const BRAND_SLUG = BRAND_NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Page two, where a few good links can plausibly move a page onto page one.
const POS_MIN = 10.5;
const POS_MAX = 20.5;
const MIN_IMPRESSIONS = Number(process.env.MIN_IMPRESSIONS ?? 50);
const MAX_CANDIDATES_PER_TARGET = 8;

const CONTENT_DIRS = (process.env.CONTENT_DIRS ?? "src/content/comparisons:/comparisons,src/content/answers:/answers")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [dir, route] = s.split(":");
    return { dir: dir.replace(/\/$/, ""), route: "/" + (route ?? "").replace(/^\/|\/$/g, "") };
  });

interface Page {
  path: string; // route, e.g. /comparisons/zyte-alternatives
  file: string;
  title: string;
  subject: string | null; // the term a sibling paragraph must mention
  draft: boolean;
  body: string;
  bodyLine: number; // file line where the body starts, so reported lines match the file
}

const git = (...args: string[]) =>
  execFileSync("git", ["-C", LANDING, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });

function loadPages(): Page[] {
  const remote = REF.match(/^origin\/(.+)$/);
  if (remote) {
    try {
      git("fetch", "--quiet", "origin", remote[1]);
    } catch {
      console.log(`internal-links: git fetch failed, reading the last fetched ${REF}`);
    }
  }
  const pages: Page[] = [];
  for (const { dir, route } of CONTENT_DIRS) {
    let files: string[] = [];
    try {
      files = git("ls-tree", "--name-only", `${REF}:${dir}`).split("\n").filter((f) => f.endsWith(".md") && !f.startsWith("_"));
    } catch {
      continue;
    }
    for (const f of files) {
      const raw = git("show", `${REF}:${dir}/${f}`);
      const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
      const front = fm ? fm[1] : "";
      const field = (k: string) => front.match(new RegExp(`^${k}:\\s*(.*)$`, "m"))?.[1]?.replace(/^"|"$/g, "").trim() ?? "";
      const slug = f.replace(/\.md$/, "");
      const title = field("title");
      // The subject of "X alternatives" is X; of a vs page, its first named
      // competitor. Category pages (best-web-scraping-tools) have no single
      // vendor, so they fall back to the title's key phrase.
      const alt = slug.match(/^(.*)-alternatives$/);
      const competitors = field("competitors").replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
      let subject: string | null = null;
      if (alt) subject = competitors[0] ?? alt[1].replace(/-/g, " ");
      else if (BRAND_SLUG && slug.startsWith(`${BRAND_SLUG}-vs-`)) subject = competitors.find((c) => c !== BRAND_NAME) ?? null;
      pages.push({
        path: `${route}/${slug}`,
        file: `${dir}/${f}`,
        title,
        subject,
        draft: /^true$/.test(field("draft")),
        body: fm ? raw.slice(fm[0].length) : raw,
        bodyLine: fm ? fm[0].split("\n").length : 1
      });
    }
  }
  return pages;
}

// Paragraphs that can carry a contextual link: prose and bullets, never
// headings, tables, the FAQ (its answers mirror FAQPage schema) or Sources.
function linkableParagraphs(body: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let section = "";
  body.split("\n").forEach((text, i) => {
    if (/^#{1,6}\s/.test(text)) {
      if (/^##\s/.test(text)) section = text.toLowerCase();
      return;
    }
    if (!text.trim() || text.startsWith("|") || text.startsWith("_Last updated")) return;
    if (/^##\s+(faq|sources)/.test(section)) return;
    out.push({ line: i + 1, text });
  });
  return out;
}

function inboundCount(pages: Page[], path: string): number {
  return pages.filter((p) => !p.draft && p.path !== path && p.body.includes(`](${path}`)).length;
}

function latestCoverage(): { url: string; state: string }[] {
  const files = readdirSync(join(DATA, "gsc")).filter((f) => /^coverage-\d{8}\.csv$/.test(f)).sort();
  if (!files.length) return [];
  const lines = readFileSync(join(DATA, "gsc", files[files.length - 1]), "utf8").trim().split("\n").slice(1);
  return lines.map((l) => {
    const c = splitCsvLine(l);
    return { url: normUrl(c[0]), state: c[2] ?? "" };
  });
}

const pulls = listPulls(DATA, "pages");
if (!pulls.length) {
  console.error("internal-links: no data/gsc/pages-*.csv - run `make gsc` first");
  process.exit(1);
}
const perf = [...readPerfCsv(pulls[pulls.length - 1].file, { normalizeKeys: true }).values()];
const pages = loadPages();
const live = pages.filter((p) => !p.draft);
const byUrl = new Map(live.map((p) => [normUrl(SITE + p.path), p]));

const targets = perf
  .filter((r) => r.position >= POS_MIN && r.position <= POS_MAX && r.impressions >= MIN_IMPRESSIONS && byUrl.has(r.key))
  .sort((a, b) => b.impressions - a.impressions)
  .map((r) => {
    const page = byUrl.get(r.key)!;
    const candidates: { source: string; file: string; line: number; paragraph: string }[] = [];
    if (page.subject) {
      const term = new RegExp(`\\b${page.subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      for (const src of live) {
        if (src.path === page.path || src.body.includes(`](${page.path}`)) continue;
        // Mentions inside an existing link's text are not free prose.
        const hit = linkableParagraphs(src.body).find((p) => term.test(p.text.replace(/\[[^\]]*\]\([^)]*\)/g, "")));
        if (hit) candidates.push({ source: src.path, file: src.file, line: hit.line + src.bodyLine - 1, paragraph: hit.text.slice(0, 400) });
        if (candidates.length >= MAX_CANDIDATES_PER_TARGET) break;
      }
    }
    return {
      target: page.path,
      title: page.title,
      subject: page.subject,
      impressions: r.impressions,
      clicks: r.clicks,
      position: Math.round(r.position * 10) / 10,
      inboundFromContent: inboundCount(pages, page.path),
      candidates
    };
  });

const unindexed = latestCoverage()
  .filter((c) => c.url.startsWith(SITE) && /not indexed|unknown to Google/i.test(c.state))
  .map((c) => {
    const path = c.url.slice(SITE.length) || "/";
    return { url: c.url, state: c.state, inboundFromContent: inboundCount(pages, path) };
  });

const generatedAt = new Date().toISOString();
writeFileSync(
  join(DATA, "internal-links.json"),
  JSON.stringify({ generatedAt, gscPull: pulls[pulls.length - 1].date, window: { POS_MIN, POS_MAX, MIN_IMPRESSIONS }, targets, unindexed }, null, 2)
);

const md: string[] = [
  `# Internal-link candidates — ${generatedAt.slice(0, 10)}`,
  "",
  `Targets: live ${CONTENT_DIRS.map((c) => c.route).join(" and ")} pages averaging position ${POS_MIN}-${POS_MAX} on ${MIN_IMPRESSIONS}+ impressions (GSC pull ${pulls[pulls.length - 1].date}).`,
  "Each candidate is a live sibling page that mentions the target's subject but does not link to it. Write the anchor text for the sentence; never reuse one anchor across pages; do not bump `updated`.",
  ""
];
for (const t of targets) {
  md.push(`## ${t.target} — pos ${t.position}, ${t.impressions} impr, ${t.clicks} clicks, ${t.inboundFromContent} inbound`);
  if (!t.subject) md.push("_No single subject (category page): pick sources by hand._");
  for (const c of t.candidates) md.push(`- ${c.source} (${c.file}:${c.line}): ${c.paragraph.slice(0, 220)}`);
  if (t.subject && !t.candidates.length) md.push("_Every sibling that mentions the subject already links here._");
  md.push("");
}
md.push("## Not indexed", "");
for (const u of unindexed) md.push(`- ${u.url} — ${u.state}, ${u.inboundFromContent} inbound from content pages`);
writeFileSync(join(DATA, "internal-links.md"), md.join("\n") + "\n");

console.log(`internal-links: ${targets.length} page-two targets, ${targets.reduce((n, t) => n + t.candidates.length, 0)} candidate links, ${unindexed.length} unindexed URLs -> data/internal-links.{json,md}`);
for (const t of targets) console.log(`  ${t.target}  pos ${t.position}  ${t.impressions} impr  inbound ${t.inboundFromContent}  candidates ${t.candidates.length}`);
