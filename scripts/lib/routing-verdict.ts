// The Profound validation-x-discovery routing rule (routing.ts). Pure so the
// three verdict boundaries are unit tested rather than re-derived by eye.
//
//   discovery >= 10%                    the engines already recommend us here
//   discovery < 10%, validation >= 60%  they know the fact but do not surface
//                                       it: off-page work earns the citation
//   discovery < 10%, validation < 60%   they do not even know the fact:
//                                       on-page work teaches it first

export const DISCOVERY_GOAL_PCT = 10;
export const VALIDATION_TRUST_PCT = 60;

export function routingVerdict(discoveryPct: number, validationPct: number): string {
  if (discoveryPct >= DISCOVERY_GOAL_PCT) return "goal-state";
  if (validationPct >= VALIDATION_TRUST_PCT)
    return "trust-gap: off-page work (citations, placements)";
  return "comprehension-gap: on-page work (content, docs, llms.txt)";
}
