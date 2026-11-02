// Pins the rules that decide the competitor-post ranking: which
// cited URLs are the same page, who owns a page, which pages answer the same
// intent, when one of your slugs already answers it, and the either-list priority.
import { describe, expect, test } from "bun:test";
import {
  intentKey, isNearIntent, normalizeUrl, ownerIn, pageTypeOf, rankEitherList, slugAnswersIntent, stem, templateOf,
  AI_MODE_COUNTS_FROM, countsInRanking, rankedSurfaces
} from "../scripts/lib/competitor-posts.ts";

describe("normalizeUrl", () => {
  test("strips www, query, hash and trailing slash", () => {
    expect(normalizeUrl("https://www.brightdata.com/blog/web-data/best-web-scraping-apis/?utm=x#top").key)
      .toBe("brightdata.com/blog/web-data/best-web-scraping-apis");
  });
  test("rejects non-http and garbage", () => {
    expect(normalizeUrl("mailto:a@b.c")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });
});

describe("ownerIn", () => {
  const names = ["Bright Data", "Scrape.do", "Nimble", "Zyte", "Apify", "Exa"];
  test("matches spaced and dotted brand names", () => {
    expect(ownerIn("brightdata.com", names)).toBe("Bright Data");
    expect(ownerIn("scrape.do", names)).toBe("Scrape.do");
  });
  test("matches a longer domain label by prefix only for 5+ character names", () => {
    expect(ownerIn("nimbleway.com", names)).toBe("Nimble");
    expect(ownerIn("exampleco.com", names)).toBeNull(); // "exa" is too short to prefix-match
    expect(ownerIn("exa.ai", names)).toBe("Exa");
  });
  test("returns null for an owner the extractor does not track", () => {
    expect(ownerIn("olostep.com", names)).toBeNull();
  });
});

describe("pageTypeOf", () => {
  test("classifies the pages that are never content briefs", () => {
    expect(pageTypeOf("scrapingbee.com", "")).toBe("home");
    expect(pageTypeOf("docs.zenrows.com", "/first-steps/pricing")).toBe("pricing");
    expect(pageTypeOf("oxylabs.io", "/products/scraper-api/web/pricings")).toBe("pricing");
    expect(pageTypeOf("app.example.com", "/login")).toBe("account");
  });
  test("separates comparisons from articles", () => {
    expect(pageTypeOf("firecrawl.dev", "/blog/bright-data-alternatives")).toBe("comparison");
    expect(pageTypeOf("firecrawl.dev", "/blog/best-web-scraping-api")).toBe("article");
  });
});

describe("intentKey", () => {
  test("rewordings of one listicle collapse to one intent", () => {
    const k = intentKey("/blog/best-web-scraping-apis");
    expect(intentKey("/blog/best-web-scraping-api")).toBe(k);
    expect(intentKey("/blog/best-web-scraping-apis-2026")).toBe(k);
    expect(intentKey("/blog/the-7-best-web-scraping-apis-in-2026-ranked-tested")).toBe(k);
  });
  test("word order does not split a vs page", () => {
    expect(intentKey("/blog/bright-data-vs-firecrawl")).toBe(intentKey("/alternatives/firecrawl-vs-bright-data"));
  });
  test("a different subject stays a different intent", () => {
    expect(intentKey("/blog/best-web-scraping-tools")).not.toBe(intentKey("/blog/best-web-scraping-apis"));
  });
});

describe("slugAnswersIntent", () => {
  const listicle = intentKey("/blog/best-web-scraping-apis").split(" ");
  test("our listicle slug answers the listicle intent", () => {
    expect(slugAnswersIntent("best-web-scraping-apis", listicle)).toBe(true);
  });
  test("a pricing page does not answer the listicle intent", () => {
    expect(slugAnswersIntent("web-scraping-api-pricing", listicle)).toBe(false);
  });
  test("a narrower how-to slug answers a wordier competitor title", () => {
    expect(slugAnswersIntent("bypass-cloudflare", intentKey("/blog/how-to-bypass-cloudflare-scraping").split(" "))).toBe(true);
  });
  test("one shared word is not enough", () => {
    expect(slugAnswersIntent("scraping", listicle)).toBe(false);
  });
  test("word forms match: bypass answers bypassing", () => {
    const intent = intentKey("/blog/bypassing-cloudflare-anti-bot-protection-for-ai-web-scraping-at-scale").split(" ");
    expect(slugAnswersIntent("bypass-cloudflare", intent)).toBe(true);
  });
  test("word forms match: scrape-without-getting-blocked answers web-scraping-without-getting-blocked", () => {
    const intent = intentKey("/blog/web-data/web-scraping-without-getting-blocked").split(" ");
    expect(slugAnswersIntent("scrape-without-getting-blocked", intent)).toBe(true);
  });
  test("a how-to page does not answer a product listicle", () => {
    expect(slugAnswersIntent("how-to-scrape-zillow", intentKey("/blog/web-data/best-zillow-scrapers").split(" "))).toBe(false);
  });
  test("stemming does not let a pricing page answer the listicle", () => {
    expect(slugAnswersIntent("web-scraping-api-pricing", listicle)).toBe(false);
  });
});

describe("rankEitherList", () => {
  test("a page near the top of EITHER list leads", () => {
    const ranked = rankEitherList([
      { id: "cited", citations: 300, mentions: 10 },
      { id: "mentioned", citations: 100, mentions: 95 },
      { id: "neither", citations: 200, mentions: 20 }
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["cited", "mentioned", "neither"]);
    expect(ranked[1].mentionRank).toBe(1);
  });
  test("an untracked owner competes on citations and is not demoted", () => {
    const ranked = rankEitherList([
      { id: "untracked", citations: 250, mentions: null },
      { id: "tracked", citations: 240, mentions: 5 }
    ]);
    expect(ranked[0].id).toBe("untracked");
    expect(ranked[0].mentionRank).toBeNull();
  });
});

describe("isNearIntent", () => {
  test("a sibling listicle is flagged for a principle 1 call", () => {
    expect(isNearIntent("best-web-scraping-apis", "/blog/best-web-scraping-tools")).toBe(true);
  });
  test("shared generic words across templates are not", () => {
    expect(isNearIntent("is-web-scraping-legal", "/blog/best-web-scraping-tools")).toBe(false);
    expect(isNearIntent("web-scraping-benchmark-problem", "/blog/best-web-scraping-tools")).toBe(false);
    expect(templateOf("acme-vs-bright-data")).toBe("vs");
    expect(isNearIntent("acme-vs-bright-data", "/blog/bright-data-alternatives")).toBe(false);
  });
});

describe("stem", () => {
  test("collapses common word forms", () => {
    expect(["scrape", "scraping"].map(stem)).toEqual(["scrap", "scrap"]);
    expect(stem("scraper")).toBe("scraper");
    expect(["getting", "get"].map(stem)).toEqual(["get", "get"]);
    expect(["bypassing", "bypass"].map(stem)).toEqual(["bypass", "bypass"]);
    expect(stem("blocked")).toBe("block");
  });
});

// AI Mode rows count from the search-endpoint era once the window reaches
// AI_MODE_COUNTS_FROM (default 2026-10-19; the defaults are pinned here).
describe("countsInRanking", () => {
  const row = (surface, day, serpState = "answer") => ({ surface, day, serpState });
  test("AI Mode counts only from the endpoint era, once the window reaches the cutover", () => {
    expect(AI_MODE_COUNTS_FROM).toBe("2026-10-19");
    expect(countsInRanking(row("google-ai-mode", "2026-10-19"), "2026-10-19")).toBe(true);
    expect(countsInRanking(row("google-ai-mode", "2026-09-28"), "2026-10-19")).toBe(false);
    expect(countsInRanking(row("google-ai-mode", "2026-10-18"), "2026-10-18")).toBe(false);
  });
  test("Google surfaces need a rendered answer; API surfaces always count", () => {
    expect(countsInRanking(row("google-aio", "2026-10-19", "shell"), "2026-10-19")).toBe(false);
    expect(countsInRanking(row("google-aio", "2026-10-19"), "2026-10-19")).toBe(true);
    expect(countsInRanking(row("gpt", "2026-10-19", null), "2026-10-19")).toBe(true);
  });
  test("rankedSurfaces adds google-ai-mode from the cutover", () => {
    expect(rankedSurfaces("2026-10-18")).not.toContain("google-ai-mode");
    expect(rankedSurfaces("2026-10-19")).toContain("google-ai-mode");
  });
});
