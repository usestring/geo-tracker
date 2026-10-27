// Pure helpers for the competitor-post ranking (scripts/competitor-posts.ts).
// Kept free of the database so tests/competitor-posts.test.mjs can pin the
// rules that decide the ranking order: URL identity, owner attribution, intent
// grouping, and the either-list priority.

/** Canonical identity of a cited page: host without www, path without trailing slash, no query or hash. */
export function normalizeUrl(raw: string): { key: string; host: string; registrable: string; path: string } | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  const registrable = host.split(".").slice(-2).join(".");
  return { key: host + path, host, registrable, path };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The competitor named in an answer that owns this domain, or null.
 * Names come from mentions.competitors ("Bright Data", "Scrape.do", "Nimble").
 * A domain matches a name when its label or its dot-free registrable domain
 * equals the name's slug, or starts with it for slugs of five characters or
 * more (nimbleway.com is Nimble; scrape.do is Scrape.do).
 */
export function ownerIn(registrable: string, names: string[]): string | null {
  const label = registrable.split(".")[0];
  const cands = [label, slug(registrable)];
  for (const name of names) {
    const s = slug(name);
    if (!s) continue;
    if (cands.some((c) => c === s || (s.length >= 5 && c.startsWith(s)))) return name;
  }
  return null;
}

export type PageType = "home" | "pricing" | "account" | "docs" | "comparison" | "article";

export function pageTypeOf(host: string, path: string): PageType {
  const p = path.toLowerCase();
  if (p === "") return "home";
  const last = p.split("/").filter(Boolean).pop() ?? "";
  if (/^(pricings?|plans)(\.html?)?$/.test(last) || /^\/(pricing|plans)(\/|$)/.test(p)) return "pricing";
  if (/^\/(login|signin|sign-in|signup|sign-up|register|app|dashboard)(\/|$)/.test(p)) return "account";
  if (host.startsWith("docs.") || /^\/(docs|documentation|api-reference|reference)(\/|$)/.test(p)) return "docs";
  if (/(alternative|-vs-|\/vs\/|compare|comparison)/.test(p)) return "comparison";
  return "article";
}

// Words that change the wording of a title without changing what it answers.
const STOP = new Set([
  "a", "an", "and", "are", "best", "blog", "can", "complete", "do", "does", "for", "guide", "how", "i", "in",
  "is", "it", "much", "of", "on", "our", "post", "posts", "ranked", "should", "tested", "the", "to", "top",
  "ultimate", "we", "what", "when", "which", "why", "with", "you", "your"
]);

/**
 * Tokens of the page's own slug, the unit a search intent is keyed on.
 * "best-web-scraping-apis-2026" and "the-7-best-web-scraping-apis-in-2026-ranked-tested"
 * both reduce to {api, scraping, web}. "bright-data-vs-firecrawl" and
 * "firecrawl-vs-bright-data" reduce to the same set.
 */
export function slugTokens(slugOrPath: string): string[] {
  const last = slugOrPath.split("/").filter(Boolean).pop() ?? "";
  const words = last.toLowerCase().replace(/\.(html?|md|php)$/, "").split(/[^a-z0-9]+/);
  const out = new Set<string>();
  for (let w of words) {
    if (!w || /^\d+$/.test(w) || STOP.has(w)) continue;
    if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    out.add(w);
  }
  return [...out].sort();
}

export const intentKey = (path: string) => slugTokens(path).join(" ");

/**
 * Does one of your slugs answer this intent? Your slug is the narrower label,
 * so its tokens must all appear in the intent (bypass-cloudflare answers
 * "how to bypass cloudflare scraping"), and it needs two tokens unless the sets
 * are equal. web-scraping-api-pricing does NOT answer "best web scraping apis".
 */
export function slugAnswersIntent(ownSlug: string, intentTokens: string[]): boolean {
  const s = slugTokens(ownSlug);
  if (s.length === 0 || intentTokens.length === 0) return false;
  const set = new Set(intentTokens);
  if (!s.every((t) => set.has(t))) return false;
  return s.length >= 2 || s.length === intentTokens.length;
}

/**
 * Either-list priority: a page leads when it is near the
 * top of the citation ranking OR the mention ranking. Priority is the better of
 * its two ranks; ties go to more citations. An owner the mention extractor does
 * not track has no mention rank and competes on citations alone, so it is never
 * pushed down for a gap in our extraction.
 */
export function rankEitherList<T extends { citations: number; mentions: number | null }>(items: T[]) {
  const byCites = [...items].sort((a, b) => b.citations - a.citations);
  const citeRank = new Map<T, number>();
  byCites.forEach((it, i) => citeRank.set(it, i + 1));
  const byMent = items.filter((it) => it.mentions !== null && it.mentions > 0)
    .sort((a, b) => (b.mentions as number) - (a.mentions as number) || b.citations - a.citations);
  const mentRank = new Map<T, number>();
  byMent.forEach((it, i) => mentRank.set(it, i + 1));
  return items
    .map((it) => {
      const c = citeRank.get(it)!;
      const m = mentRank.get(it) ?? null;
      return { ...it, citationRank: c, mentionRank: m, priorityRank: m === null ? c : Math.min(c, m) };
    })
    .sort((a, b) => a.priorityRank - b.priorityRank || b.citations - a.citations)
    .map((it, i) => ({ ...it, priority: i + 1 }));
}

/** The page template a slug follows, read from its raw words (stop words included). */
export function templateOf(slugOrPath: string): "listicle" | "alternatives" | "vs" | "howto" | "other" {
  const w = (slugOrPath.split("/").filter(Boolean).pop() ?? "").toLowerCase().split(/[^a-z0-9]+/);
  if (w.includes("vs") || w.includes("versus")) return "vs";
  if (w.some((x) => x.startsWith("alternative"))) return "alternatives";
  if (w.includes("best") || w.includes("top")) return "listicle";
  if (w.includes("how") || w.includes("bypass") || w.includes("guide")) return "howto";
  return "other";
}

/**
 * One of your slugs that may own the same search intent without matching it word
 * for word: same template and at least half the words shared. "best web scraping
 * tools" is near a "best-web-scraping-apis" slug; "is-web-scraping-legal" is not.
 */
export function isNearIntent(ownSlug: string, competitorPath: string): boolean {
  const t = templateOf(ownSlug);
  if (t !== templateOf(competitorPath)) return false;
  const a = new Set(slugTokens(ownSlug));
  const b = new Set(slugTokens(competitorPath));
  const shared = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  if (union === 0) return false;
  return shared / union >= (t === "other" ? 0.75 : 0.5);
}
