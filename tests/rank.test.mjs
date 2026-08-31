// visibility-rank.ts ranks brands by share of voice, and two rules are easy
// to get quietly wrong: a zero-share brand must be UNRANKED (absent is not
// "last place" - reporting your brand at #19 of 19 when it appeared nowhere
// would read as data), and equal shares must share a competition rank (1, 2, 2, 4)
// so a week-over-week "movement" is never manufactured by a tiebreak.
import { test, expect } from "bun:test";
import { rankBrands } from "../scripts/lib/rank.ts";

test("ranks by share descending", () => {
  const out = rankBrands({ A: 10, B: 30, C: 20 });
  expect(out.map((b) => b.brand)).toEqual(["B", "C", "A"]);
  expect(out.map((b) => b.rank)).toEqual([1, 2, 3]);
});

test("zero share is unranked, not last", () => {
  const out = rankBrands({ String: 0, Apify: 25, Firecrawl: 5 });
  expect(out.find((b) => b.brand === "String").rank).toBeNull();
  expect(out.find((b) => b.brand === "Apify").rank).toBe(1);
});

test("ties share a competition rank and the next rank skips", () => {
  const out = rankBrands({ A: 30, B: 20, C: 20, D: 10 });
  expect(out.map((b) => b.rank)).toEqual([1, 2, 2, 4]);
});

test("all-zero input ranks nobody", () => {
  const out = rankBrands({ A: 0, B: 0 });
  expect(out.every((b) => b.rank === null)).toBe(true);
});
