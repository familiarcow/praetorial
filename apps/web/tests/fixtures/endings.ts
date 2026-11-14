// WEBE2E1: the single list of the 8 ways a bet ends. Each ending must have ONE mocked Playwright journey (bet page -> action/ruling screen ->
// payout screen, mocked chain state advancing between steps). endings-matrix.unit.test.ts fails if an entry loses its journey.
export interface Ending { id: string; spec: string; title: string }
export const JOURNEY_SPEC = "endings-journeys.spec.ts";
export const ENDINGS: Ending[] = [
  { id: "ai-yes", spec: JOURNEY_SPEC, title: "journey: AI rules YES -> finalize -> payout (maker wins)" },
  { id: "ai-no", spec: JOURNEY_SPEC, title: "journey: AI rules NO -> finalize -> payout (maker lost)" },
  { id: "ai-void", spec: JOURNEY_SPEC, title: "journey: AI VOID (unavailability) -> finalize -> refund payout, no fee" },
  { id: "ai-challenged", spec: JOURNEY_SPEC, title: "journey: AI ruling challenged (one round) -> re-ruled -> finalize -> payout" },
  { id: "concede", spec: JOURNEY_SPEC, title: "journey: concede -> payout in progress -> retry -> Paid" },
  { id: "referee-yes", spec: JOURNEY_SPEC, title: "journey: human referee rules YES -> payout" },
  { id: "referee-silent", spec: JOURNEY_SPEC, title: "journey: human referee silent -> deadline refund payout" },
  { id: "emergency", spec: JOURNEY_SPEC, title: "journey: emergency shutdown -> emergency_refund -> refund payout" },
];
