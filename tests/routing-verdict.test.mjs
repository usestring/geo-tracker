// routing.ts routes each theme to on-page or off-page work from two rates.
// The boundaries are the contract (>= on both thresholds), and a one-character
// comparison slip would route real work to the wrong half of the program.
import { test, expect } from "bun:test";
import { routingVerdict } from "../scripts/lib/routing-verdict.ts";

test("discovery at or above 10% is the goal state regardless of validation", () => {
  expect(routingVerdict(10, 0)).toBe("goal-state");
  expect(routingVerdict(55, 90)).toBe("goal-state");
});

test("low discovery with strong validation is a trust gap (off-page)", () => {
  expect(routingVerdict(9.9, 60)).toContain("trust-gap");
  expect(routingVerdict(0, 100)).toContain("trust-gap");
});

test("low discovery with weak validation is a comprehension gap (on-page)", () => {
  expect(routingVerdict(9.9, 59.9)).toContain("comprehension-gap");
  expect(routingVerdict(0, 0)).toContain("comprehension-gap");
});
