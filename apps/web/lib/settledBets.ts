// DOCS5: what has settled, as counted from docs/BETS.md (tests/docs5.unit.test.ts recounts the table and must get these numbers).
// Source: the SHOW1 inventory (2026-11-13 23:11 ET), re-checked on chain on 2026-11-14 (spikes/docs5/REPORT.md). The README's numbers
// line, the What page and the Hackathon page all print settledLine(), so they cannot drift apart.

export const SETTLED = {
  total: 38,
  onMainnet: 1,
  onTestnet: 37,
  /** ruled by the AI judge, including the one whose losing side then conceded */
  aiJudge: 15,
  aiThenConceded: 1,
  referee: 17,
  /** conceded before any ruling */
  conceded: 5,
  /** refunded as VOID: no ruling by the deadline */
  deadlineVoid: 1,
  yes: 21,
  no: 12,
  void: 5,
  builtIn: 16,
  custom: 22,
} as const;

/** The one-line summary. "md" bolds the lead for the README; "text" is what a rendered page reads as. */
export function settledLine(form: "md" | "text"): string {
  const s = SETTLED;
  const lead = `${s.total} bets settled end to end`;
  return `${form === "md" ? `**${lead}**` : lead} (${s.onMainnet} on mainnet, ${s.onTestnet} on testnet): ${s.aiJudge} ruled by the AI judge (one then conceded), ${s.referee} by human referees, ${s.conceded} by concession, ${s.deadlineVoid} refunded as VOID after its deadline.`;
}

/** The mainnet bets (escrow bet_count = MAINNET_STATUS.betCount). Made by the builder against their own second account, 3 NEAR a side. */
export const MAINNET_BETS = [
  { id: 1, what: "Bitcoin's price at a set time (1-minute close at or above $68,350 at 2026-11-13 23:59 UTC)", status: "ruled NO by the AI judge and settled on 13 November" },
  { id: 2, what: "the hackathon bet (Praetorial is announced as a winner of this NEAR hackathon)", status: "taken, awaiting its ruling (window ends 25 November)" },
] as const;
