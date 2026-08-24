// The shared session pool must replace a session whose page lost its frame,
// even when the hosted endpoint keeps handing the same dead target back.
//
// Regression for the Aug 21 incident — see tests/README.md.
import { test, expect, mock } from "bun:test";

process.env.STRING_API_KEY = "test-key";

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
    evaluate: async () => {
      if (p === dead) throw new Error(`Attempted to use detached Frame '${id}'.`);
      return 1;
    },
  };
  return p;
}

const first = makePage();

// Reconnect always returns the same target. This is the hosted-browser behaviour
// that made the 20-minute recycle useless on Aug 21.
const fakeBrowser = {
  pages: async () => [first],
  newPage: async () => makePage(),
  disconnect: () => {},
};
mock.module("puppeteer-core", () => ({ default: { connect: async () => fakeBrowser } }));

const { createSessionPool } = await import("../scripts/surfaces/cdp-session.mjs");

test("pool reuses a healthy session and replaces one that lost its frame", async () => {
  const pool = createSessionPool({ sessionMs: 20 * 60 * 1000 });

  const a = await pool.ensure();
  expect(a.page._id).toBe("F1");

  // A healthy session inside its age cap is reused — the probe must not cost a
  // reconnect on the happy path, which is every question but the broken one.
  expect((await pool.ensure()).page._id).toBe("F1");

  // The frame dies well before the age cap expires. Age alone would keep serving it.
  dead = first;
  const b = await pool.ensure();
  expect(b.page._id).not.toBe("F1");
  expect(await b.page.evaluate(() => 1)).toBe(1);
});
