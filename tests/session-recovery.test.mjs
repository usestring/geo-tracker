// google-ai-mode against a fake hosted browser: the warm-up path and frame loss.
//
// One file on purpose. Bun keeps a single mock registry for the whole run and
// evaluates every test file's top level before running any test, so two files
// that both `mock.module("puppeteer-core")` end up sharing whichever fake was
// registered last. Every google-ai-mode behaviour that needs the fake browser
// therefore lives here.
//
// WARM-UP (Sep 11 2026). Fresh premium sessions: direct udm=50 served 0 of 6,
// udm=50 after a served plain SERP 4 of 4. The served SERP sets DV (10 min).
// The surface must load a SERP first unless DV is live, and a block must flip
// the proxy tier on the reconnect. See the WARM-UP note in the surface.
//
// FRAME LOSS (Aug 21 2026). q61 answered, one frame detached, and every
// question after it failed on the same frame id. The fake reproduces both
// halves of what kept it dead — the page never heals, and a reconnect hands
// the same dead target back.
//
// Runs ~60s. The surface polls until the answer text stops growing, and that
// wait is the real code path rather than a stub.
import { test, expect, mock } from "bun:test";

process.env.STRING_API_KEY = "test-key"; // force the remote path
delete process.env.AI_MODE_LOCAL;
delete process.env.AI_MODE_PROXY;

const DETACH_AFTER = 2;
const QUESTION = "What is the best web scraping API for large scale collection today?";
const ANSWER = `${QUESTION} ${"x".repeat(1200)}`;
const SORRY = "About this page Our systems have detected unusual traffic from your computer network.";

let seq = 0;
let dead = null;
// Warm-up controls: what google.com cookies the context holds, which URLs the
// fake refuses, and what the surface asked for.
let dvCookies = [];
let refused = () => false;
const gotos = [];
const connects = [];

function makePage() {
  const id = `F${++seq}`;
  let closed = false;
  let current = "";
  const p = {
    _id: id,
    isClosed: () => closed,
    close: async () => { closed = true; },
    setViewport: async () => {},
    setRequestInterception: async () => {},
    cookies: async () => dvCookies,
    on: () => {},
    goto: async (url) => {
      if (p === dead) throw new Error(`Attempted to use detached Frame '${id}'.`);
      gotos.push(url);
      current = url;
    },
    // Dispatch on the evaluated function's source, so each of the surface's
    // evaluate call sites gets the shape it expects.
    evaluate: async (fn) => {
      if (p === dead) throw new Error(`Attempted to use detached Frame '${id}'.`);
      const src = String(fn);
      if (src.includes("accept all")) return false;                       // consent
      if (src.includes("innerText")) return refused(current) ? SORRY : ANSWER; // page text
      // Citation extractor: returns both reads plus the boundary flag, the same
      // shape extractCitationsInPage produces (see ai-mode-citations.test.mjs).
      if (src.includes("a[href]"))
        return {
          pageWide: [{ url: "https://ex.com/a", title: "a" }],
          scoped: [{ url: "https://ex.com/a", title: "a" }],
          boundaryFound: true
        };
      return 1;                                                           // liveness probe
    },
  };
  return p;
}

const first = makePage();
const fakeBrowser = {
  pages: async () => [first],
  newPage: async () => makePage(),
  disconnect: () => {},
};
mock.module("puppeteer-core", () => ({
  default: {
    connect: async ({ browserWSEndpoint }) => {
      connects.push(browserWSEndpoint);
      return fakeBrowser;
    },
  },
}));

const surface = await import("../scripts/surfaces/google-ai-mode.mjs");
const isSerp = (u) => u.includes("/search?") && !u.includes("udm=50");
const isAim = (u) => u.includes("udm=50");

test("no DV cookie: a plain SERP is loaded before udm=50", async () => {
  gotos.length = 0;
  dvCookies = [];
  const r = await surface.ask(null, QUESTION, { timeoutMs: 20_000 });
  expect(r.text.length).toBeGreaterThan(300);
  expect(gotos.length).toBe(2);
  expect(isSerp(gotos[0])).toBe(true);
  expect(isAim(gotos[1])).toBe(true);
}, 60_000);

test("live DV cookie: udm=50 is opened directly", async () => {
  gotos.length = 0;
  dvCookies = [{ name: "DV", expires: Date.now() / 1000 + 540 }];
  await surface.ask(null, QUESTION, { timeoutMs: 20_000 });
  expect(gotos.length).toBe(1);
  expect(isAim(gotos[0])).toBe(true);
}, 60_000);

test("DV cookie about to expire counts as absent", async () => {
  gotos.length = 0;
  dvCookies = [{ name: "DV", expires: Date.now() / 1000 + 20 }];
  await surface.ask(null, QUESTION, { timeoutMs: 20_000 });
  expect(gotos.length).toBe(2);
  expect(isSerp(gotos[0])).toBe(true);
}, 60_000);

test("a blocked warm-up retries on the other proxy tier", async () => {
  gotos.length = 0;
  connects.length = 0;
  dvCookies = [];
  // First SERP attempt is refused, every later one is served.
  let serps = 0;
  refused = (u) => isSerp(u) && ++serps === 1;
  const r = await surface.ask(null, QUESTION, { timeoutMs: 20_000 });
  refused = () => false;
  expect(r.text.length).toBeGreaterThan(300);
  // One reconnect, and it changed tier: standard (start) -> premium.
  expect(connects.length).toBe(1);
  expect(connects[0]).toContain("proxy=premium");
  expect(gotos.filter(isSerp).length).toBe(2);
  expect(gotos.filter(isAim).length).toBe(1);
}, 60_000);

test(
  "surface answers every question after the page loses its frame",
  async () => {
    dvCookies = [];
    const results = [];
    for (let i = 1; i <= 5; i++) {
      if (i > DETACH_AFTER && !dead) dead = first;
      try {
        const r = await surface.ask(null, QUESTION, { timeoutMs: 30_000 });
        results.push(`q${i} ok (${r.citations.length} citations)`);
      } catch (e) {
        results.push(`q${i} FAIL ${String(e?.message ?? e).slice(0, 55)}`);
      }
    }
    console.log(results.join("\n"));
    // Before the fix this was 2/5: q3-q5 all threw on frame F1.
    expect(results.filter((r) => r.includes(" ok ")).length).toBe(5);
  },
  120_000
);
