// The AI Mode citation extractor must separate answer sources from SERP chrome.
//
// Page-wide anchor extraction is a ceiling, not a floor: it counts nav, tabs
// and account links alongside real sources. AI_MODE_SCOPE_CITATIONS=1 narrows
// it to anchors after the query echo in document order. That flag defaults off
// because this is the highest-yield surface we run and a wrong boundary
// silently zeroes it, so these tests exist to prove the boundary works before
// anyone flips it.
//
// Runs the real exported extractor against a synthetic DOM in headless
// Chromium. No network, no Google, no browser credits.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { chromium } from "playwright";
import { collectGoogleSources, resolveGoogleSources } from "../scripts/surfaces/cdp-session.mjs";

// Both surfaces evaluate the collector as a string, so drive it the same way.
const extractCitationsInPage = (head, on = page) =>
  on.evaluate(`(${collectGoogleSources})(document, ${JSON.stringify(head)})`);

const QUESTION = "What's the best web scraping API in 2026?";
const HEAD = QUESTION.slice(0, 40);

// A udm=50 page in miniature: Google chrome first, then the query echo, then
// the answer with its sources.
const PAGE = `<!doctype html><html><body>
  <header>
    <a href="https://www.google.com/preferences">Settings</a>
    <a href="https://accounts.google.com/signin">Sign in</a>
    <a href="https://mail.example-chrome.com/nav">Chrome nav link</a>
  </header>
  <div id="echo"><span>${QUESTION}</span></div>
  <main>
    <p>The leading options are these.</p>
    <a href="https://brightdata.com/blog/best-web-scraping-apis">Bright Data</a>
    <a href="https://www.firecrawl.dev/blog/best-web-scraping-api">Firecrawl</a>
    <a href="https://www.google.com/url?q=https%3A%2F%2Fscrape.do%2Fblog%2F">Scrape.do</a>
    <a href="https://policies.google.com/terms">Terms</a>
  </main>
  <!-- Source chips as Google has rendered them since Aug 26 2026: an opaque
       /goto href, the destination in a sibling comment payload, and a label
       that sometimes leads with the bare hostname. -->
  <section id="chips">
    <span><!--TgQPHd|||[[&quot;6f4a3ff1&quot;,null,null,0,&quot;https://encrypted-tbn2.gstatic.com/faviconV2?url\u003dhttps://www.gumloop.com\u0026client\u003dAIM&quot;,&quot;Gumloop&quot;,2,&quot;https://www.gumloop.com/blog/firecrawl-alternatives&quot;,null,null,null,1,null,0]]--></span>
    <a aria-label="Gumloop (+1) - Firecrawl alternatives. Related results" href="/goto?url=CAEScgHrOzAV">Gumloop</a>
    <a aria-label="www.nimbleway.com (+3) - 7 Firecrawl Alternatives - Nimble Way" href="/goto?url=CAESewHrOzAV">Nimble</a>
    <!-- A folded "(+N)" source card: site root and /goto token only. -->
    <span><!--TgQPHd|||[[&quot;546f&quot;,[&quot;If you are looking at Firecrawl alternatives&quot;,&quot;snippet&quot;,&quot;https://encrypted-tbn2.gstatic.com/faviconV2?url\u003dhttps://www.reddit.com&quot;,&quot;https://www.reddit.com&quot;,[&quot;Reddit&quot;,&quot;r/apyhub&quot;],&quot;/goto?url\u003dCAESmwEBfolded&quot;]]]--></span>
    <span><!--TgQPHd|||[[&quot;9a1b&quot;,null,null,0,&quot;https://encrypted-tbn1.gstatic.com/faviconV2?url\u003dhttps://www.youtube.com&quot;,&quot;YouTube&quot;,2,&quot;https://www.youtube.com/watch?v\u003dabc123\u0026t\u003d5s&quot;,null,null,null,1,null,0]]--></span>
  </section>
</body></html>`;

let browser;
let page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent(PAGE, { waitUntil: "load" });
});

afterAll(async () => {
  await browser?.close();
});

test("finds the query echo and reports the boundary", async () => {
  const out = await extractCitationsInPage(HEAD);
  expect(out.boundaryFound).toBe(true);
});

test("scoping drops the SERP chrome link and keeps every answer source", async () => {
  const out = await extractCitationsInPage(HEAD);
  const scoped = out.scoped.map((c) => c.url);
  const pageWide = out.pageWide.map((c) => c.url);

  // The chrome link sits before the echo, so only the page-wide read sees it.
  expect(pageWide).toContain("https://mail.example-chrome.com/nav");
  expect(scoped).not.toContain("https://mail.example-chrome.com/nav");

  // Every real source survives scoping. This is the assertion that matters:
  // a boundary that eats sources is worse than no boundary at all.
  expect(scoped).toContain("https://brightdata.com/blog/best-web-scraping-apis");
  expect(scoped).toContain("https://www.firecrawl.dev/blog/best-web-scraping-api");
  expect(scoped.length).toBe(7);
  expect(scoped.length).toBeLessThan(pageWide.length);
});

test("post-Aug-26 chips: the comment payload URL and the hostname label are read, the /goto href is not", async () => {
  const out = await extractCitationsInPage(HEAD);
  const urls = out.scoped.map((c) => c.url);
  expect(urls).toContain("https://www.gumloop.com/blog/firecrawl-alternatives");
  expect(urls).toContain("https://nimbleway.com/");
  // The favicon lookup's echo of the site root is not a second gumloop citation,
  // and no /goto or gstatic URL leaks through.
  expect(urls.filter((u) => u.includes("gumloop")).length).toBe(1);
  expect(urls.some((u) => u.includes("/goto") || u.includes("gstatic"))).toBe(false);
  // Payload escapes are decoded, so a video URL keeps its query string.
  expect(urls).toContain("https://www.youtube.com/watch?v=abc123&t=5s");
});

test("google's /url?q= redirects are unwrapped to the real domain", async () => {
  const out = await extractCitationsInPage(HEAD);
  expect(out.scoped.map((c) => c.url)).toContain("https://scrape.do/blog/");
});

test("google's own domains are excluded from both reads", async () => {
  const out = await extractCitationsInPage(HEAD);
  for (const list of [out.pageWide, out.scoped]) {
    const hosts = list.map((c) => new URL(c.url).hostname);
    expect(hosts).not.toContain("policies.google.com");
    expect(hosts).not.toContain("accounts.google.com");
    expect(hosts).not.toContain("www.google.com");
  }
});

test("a page with no query echo reports no boundary, so the caller falls back", async () => {
  const other = await browser.newPage();
  await other.setContent(
    `<!doctype html><html><body><a href="https://example.com/a">A</a></body></html>`,
    { waitUntil: "load" }
  );
  const out = await extractCitationsInPage(HEAD, other);
  // boundaryFound false is the signal ask() uses to keep the page-wide list.
  expect(out.boundaryFound).toBe(false);
  expect(out.pageWide.length).toBe(1);
  await other.close();
});

test("folded source cards hand back their /goto tokens, from anchors and payloads", async () => {
  const out = await extractCitationsInPage(HEAD);
  expect(out.gotos.scoped).toContain("/goto?url=CAEScgHrOzAV");
  expect(out.gotos.scoped).toContain("/goto?url=CAESmwEBfolded");
  // The folded card's root alone is a citation until the token resolves.
  expect(out.scoped.map((c) => c.url)).toContain("https://www.reddit.com/");
});

test("resolved tokens replace a site root with the page URL; failures keep the root", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("CAESmwEBfolded"))
      return new Response(null, { status: 302, headers: { location: "https://www.reddit.com/r/apyhub/comments/1whs19s/x/" } });
    if (String(url).endsWith("CAEScgHrOzAV"))
      return new Response(null, { status: 302, headers: { location: "https://www.google.com/sorry/index" } });
    throw new Error("timeout");
  };
  try {
    const list = [
      { url: "https://www.reddit.com/", title: "" },
      { url: "https://www.gumloop.com/blog/firecrawl-alternatives", title: "" },
      { url: "https://nimbleway.com/", title: "" },
    ];
    const { citations, stats } = await resolveGoogleSources(list, ["/goto?url=CAESmwEBfolded", "/goto?url=CAEScgHrOzAV", "/goto?url=CAESewHrOzAV"]);
    const urls = citations.map((c) => c.url);
    expect(urls).toContain("https://www.reddit.com/r/apyhub/comments/1whs19s/x/");
    expect(urls).not.toContain("https://www.reddit.com/");
    // A token that fails or points back at Google leaves the list as it was.
    expect(urls).toContain("https://nimbleway.com/");
    expect(urls.some((u) => u.includes("google.com"))).toBe(false);
    expect(stats).toEqual({ tokens: 3, resolved: 1, failed: 2 });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("GOOGLE_RESOLVE_GOTO=0 skips the network", async () => {
  process.env.GOOGLE_RESOLVE_GOTO = "0";
  try {
    const list = [{ url: "https://www.reddit.com/", title: "" }];
    const { citations } = await resolveGoogleSources(list, ["/goto?url=X"]);
    expect(citations).toEqual(list);
  } finally {
    delete process.env.GOOGLE_RESOLVE_GOTO;
  }
});
