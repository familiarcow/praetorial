// MODAL1c3: pure helpers for the resolution flow modals (request result, challenge, concede, referee ruling). No React.
// Every number comes from the bet's own fields, the contract's required_challenge_bond view or lib/requestResult; amounts are BigInt end to end.
import type { Bet } from "./escrowAdapter";
import type { ChallengeBondQuote } from "./escrowAdapter";
import type { FlowStep } from "./flowModal";
import { requestResolutionDepositYocto, formatNear } from "./requestResult";
import { isChallengedRuling } from "./betLifecycle";
import { challengeRoundLabel, money as bondMoney } from "./ruling";
import { ruleConfirmSentence, sides, sum, type RuleOutcome } from "./refereeScreen";

/** Every resolution action is one irreversible step: read exactly what happens, then confirm. */
export const RESOLUTION_STEPS: FlowStep[] = [{ id: "confirm", title: "Confirm" }];
export const RESOLUTION_DRAFT_KEY = (kind: string, betId: number) => `resolution-${kind}-${betId}`;

export interface RequestResultTerms { depositYocto: bigint; nearText: string; lines: string[] }
export function requestResultTerms(bet: Bet): RequestResultTerms {
  const depositYocto = requestResolutionDepositYocto(bet);
  const nearText = `${formatNear(depositYocto)} NEAR`;
  return {
    depositYocto, nearText,
    lines: [
      `This attaches ${nearText} from your wallet. Whatever the check doesn't use is refunded.`,
      isChallengedRuling(bet)
        ? "It asks the AI judge to look at the challenged ruling again now. The keeper normally does this when the evidence window ends."
        : "It asks the AI judge for the result now. The keeper normally does this a few minutes after the event.",
      "No bet money moves.",
    ],
  };
}

export interface ChallengeTerms { roundLabel: string; bondText: string; lines: string[] }
export function challengeTerms(bet: Bet, quote: ChallengeBondQuote): ChallengeTerms {
  const bondText = bondMoney(quote);
  const roundLabel = challengeRoundLabel(bet.bonds.length + 1);
  return {
    roundLabel, bondText,
    lines: [
      `Challenging costs a bond of ${bondText}, paid from your Escrow balance now. You get it back if you win the challenge.`,
      "The AI will look at the ruling again.",
    ],
  };
}

export interface PayoutTerms { winner: string | null; payoutText: string; feeText: string | null }
function payout(bet: Bet, winner: string | null, refund: boolean): PayoutTerms {
  const s = sides(bet);
  if (refund) return { winner: null, payoutText: sum(s.map((x) => ({ asset: x.asset, units: x.stake }))), feeText: null };
  return {
    winner,
    payoutText: sum(s.map((x) => ({ asset: x.asset, units: x.stake - x.fee - x.tip }))),
    feeText: sum(s.map((x) => ({ asset: x.asset, units: x.fee }))),
  };
}

export interface ConcedeTerms extends PayoutTerms { lines: string[] }
export function concedeTerms(bet: Bet, me: string | null): ConcedeTerms {
  const e: any = bet.envelope;
  const winner = me === e.maker ? bet.taker : e.maker;
  const p = payout(bet, winner, false);
  return {
    ...p,
    lines: [
      `Your side loses and ${winner ?? "the other side"} is paid ${p.payoutText} right away: the whole pot minus the ${p.feeText} fee.`,
      "Any challenge bonds go back to whoever posted them.",
      "This cannot be undone.",
    ],
  };
}

export interface RuleTerms extends PayoutTerms { sentence: string; lines: string[] }
export function ruleTerms(bet: Bet, outcome: RuleOutcome): RuleTerms {
  const e: any = bet.envelope;
  const sentence = ruleConfirmSentence(bet, outcome);
  if (outcome === "VOID") {
    const p = payout(bet, null, true);
    return { ...p, sentence, lines: [`Both bettors get their stake back (${p.payoutText} in total), with no fee.`] };
  }
  const winner = e.maker_side === outcome ? e.maker : bet.taker;
  const p = payout(bet, winner, false);
  return { ...p, sentence, lines: [`${winner} is paid ${p.payoutText}: both stakes minus the ${p.feeText} fee.`] };
}

export type FlowPhase = "success" | "pending" | "failure";
/** Only an outcome the bet itself shows is a success. A sent-but-unseen transaction is pending; everything else is a failure. */
export function flowPhase(kind: string): FlowPhase {
  if (kind === "conceded" || kind === "challenged" || kind === "ruled" || kind === "requested") return "success";
  if (kind === "pending") return "pending";
  return "failure";
}

// ---------------------------------------------------------------- M1: the ConfirmSheet view of each resolution confirm
// UIR1 §3.6 + PEOPLE RULE: KeyValue rows (what moves, how much, to whom) + ONE risk sentence + a SHORT button label (the amount is in
// the body, never the button, so nothing is cut off at 375 px). People are "@username" / "you" / "Unnamed account", never an id.
import { person, personLabel, type Names } from "./betView";

export interface SheetRow { id: string; label: string; value: string }
export interface ResolutionSheet { title: string; rows: SheetRow[]; risk: string; confirmLabel: string; danger: boolean; sentence: string | null }

const who = (account: string | null | undefined, me: string | null, names: Names): string =>
  account ? personLabel(person(account, me, names)) : "The other side";

export const resolutionSheet = {
  requestResult(bet: Bet): ResolutionSheet {
    const t = requestResultTerms(bet);
    return {
      title: "Request the result now", confirmLabel: "Request the result", danger: false, sentence: null,
      rows: [
        { id: "deposit", label: "You attach", value: `${t.nearText} from your wallet, refunded if unused` },
        { id: "what", label: "What it does", value: isChallengedRuling(bet) ? "The AI looks at the challenged ruling again now" : "The AI judge checks the result now" },
      ],
      risk: "No bet money moves.",
    };
  },
  challenge(bet: Bet, quote: ChallengeBondQuote): ResolutionSheet {
    const t = challengeTerms(bet, quote);
    return {
      title: "Challenge this ruling", confirmLabel: "Post bond & challenge", danger: false, sentence: null,
      rows: [
        { id: "round", label: "Round", value: t.roundLabel },
        { id: "bond", label: "Bond", value: `${t.bondText}, from your betting balance now; back if you win` },
      ],
      risk: "The AI will look at the ruling again. The bond comes back only if your challenge wins.",
    };
  },
  concede(bet: Bet, me: string | null, names: Names): ResolutionSheet {
    const t = concedeTerms(bet, me);
    const w = who(t.winner, me, names);
    return {
      title: "Concede this bet", confirmLabel: "Concede", danger: true, sentence: null,
      rows: [
        { id: "paid", label: `${w} is paid`, value: `${t.payoutText}, right away` },
        { id: "fee", label: "Fee", value: `${t.feeText}, from the pot` },
        { id: "bonds", label: "Challenge bonds", value: "Back to whoever posted them" },
      ],
      risk: "Your side loses. This cannot be undone.",
    };
  },
  rule(bet: Bet, outcome: RuleOutcome, me: string | null, names: Names): ResolutionSheet {
    const t = ruleTerms(bet, outcome);
    const risk = "This pays out immediately and can't be changed or challenged.";
    const base = { title: `Rule ${outcome}`, confirmLabel: `Confirm ${outcome}`, danger: true, risk };
    if (outcome === "VOID") {
      return { ...base, sentence: "You're ruling VOID: both bettors get their stake back, no fee.", rows: [{ id: "refund", label: "Refunded", value: `${t.payoutText} in total, no fee` }] };
    }
    const w = who(t.winner, me, names);
    return {
      ...base, sentence: `You're ruling ${outcome}: ${w} wins ${t.payoutText}.`,
      rows: [{ id: "paid", label: `${w} is paid`, value: t.payoutText }, { id: "fee", label: "Fee", value: `${t.feeText}, from the pot` }],
    };
  },
};
