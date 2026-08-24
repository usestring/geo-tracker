// google-ai-mode must keep answering after its page loses its main frame.
//
// This is the Aug 21 incident reproduced: q61 answered, one frame detached, and
// every question after it failed on the same frame id. The fake browser below
// reproduces both halves of what kept it dead — the page never heals, and a
// reconnect hands the same dead target back.
//
// Runs ~30s. The surface polls until the answer text stops growing, and that
// wait is the real code path rather than a stub.
import { test, expect, mock } from "bun:test";

process.env.STRING_API_KEY = "test-key"; // force the remote path
delete process.env.AI_MODE_LOCAL;

const DETACH_AFTER = 2;
const QUESTION = "What is the best web scraping API for large scale collection today?";
const ANSWER = `${QUESTION} ${"x".repeat(1200)}`;

let seq = 0;
let dead = null;

function makePage() {
  const id = `F${++seq}`;
  let closed = false;
  const p = {
    _id: id,
    isClosed: () => closed,
    close: async () => { closed = true; },
    setViewport: async () => {},
    setRequestInterception: async () => {},
    on: () => {},
    goto: async () => {
      if (p === dead) throw new Error(`Attempted to use detached Frame '${id}'.`);
    },
    // Dispatch on the evaluated function's source, so each of the surface's
    // three evaluate call sites gets the shape it expects.
    evaluate: async (fn) => {
      if (p === dead) throw new Error(`Attempted to use detached Frame '${id}'.`);
      const src = String(fn);
      if (src.includes("accept all")) return false;                       // consent
      if (src.includes("innerText")) return ANSWER;                       // stability poll
      if (src.includes("a[href]")) return [{ url: "https://ex.com/a", title: "a" }];
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
mock.module("puppeteer-core", () => ({ default: { connect: async () => fakeBrowser } }));

const surface = await import("../scripts/surfaces/google-ai-mode.mjs");

test(
  "surface answers every question after the page loses its frame",
  async () => {
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
