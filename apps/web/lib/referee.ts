// Resolver choice (FE4, UX-4 / UX-17 / UX-18, D-REF1 / RF2): who settles the bet is ONE decision: the AI (default) or a named person.
// The contract has one human referee mode (`Human`); the web model is `{mode: "ai" | "human", referee?: account}` and the wire
// shape `{account, mode: "Human"}` is built from it only when the envelope is made. The maker may set `tip_maker`; the taker names the
// referee they agree to (`referee_ack`) and may opt in to tipping (`tip`). Mirrors contracts/escrow/src/lib.rs Referee/TransferMsg::Take.
import { feeForSideUnits } from "./escrowAdapter";

export type RefereeMode = "ai" | "human";

export interface RefereeChoice {
  mode: RefereeMode;
  /** The picked person's account; only meaningful when mode === "human". */
  referee?: string;
}

/** The default: the AI decides, nobody to pick. */
export const AI_CHOICE: RefereeChoice = { mode: "ai" };
export const humanChoice = (account?: string): RefereeChoice => ({ mode: "human", referee: account });

/** The trimmed referee account for a human choice with a pick; null otherwise (AI, or nobody picked yet). */
export function refereeAccount(choice: RefereeChoice): string | null {
  if (choice.mode !== "human") return null;
  const a = (choice.referee ?? "").trim();
  return a ? a : null;
}

const IMPLICIT = /^[0-9a-f]{64}$/;
const TAIL = /^[0-9a-f]{8}$/;

/** The registry shows implicit accounts as their last 8 chars; a named account as itself. True when `shown` is that account. */
export function accountMatches(full: string | null | undefined, shown: string): boolean {
  const f = (full ?? "").trim();
  const s = shown.trim();
  if (!f || !s) return false;
  return f === s || (TAIL.test(s) && IMPLICIT.test(f) && f.endsWith(s));
}

/** A full account id the contract can take: a named account (has a dot) or a 64-hex implicit account. A bare 8-char tail is not. */
export function isUsableAccount(account: string): boolean {
  const a = account.trim();
  return IMPLICIT.test(a) || (a.length >= 2 && a.includes(".") && !/\s/.test(a));
}

export interface RefereeContext {
  maker: string | null;
  taker: string | null;
  /** The contract's fee account (lib/release.json); null when unknown (the contract still refuses it at open). */
  feeAccount?: string | null;
}

// Validates the choice against the contract rules (D-REF1 / RF2): referee != maker, != the named taker, != the fee account.
// No acceptance step exists (UX-18): the taker agrees by taking the bet.
export function validateReferee(choice: RefereeChoice, ctx: RefereeContext): string[] {
  if (choice.mode !== "human") return [];
  const a = refereeAccount(choice);
  if (!a) return ["Pick someone, or switch back to the AI."];
  if (accountMatches(ctx.maker, a)) return ["You can't pick yourself."];
  if (accountMatches(ctx.taker, a)) return ["Referee cannot be the taker."];
  if (accountMatches(ctx.feeAccount, a)) return ["That account can't be a referee."];
  return [];
}

/** D-REFUI3a review text. `deadlineLabel` is the resolve deadline the person must rule by. */
export function refereeReviewLine(choice: RefereeChoice, deadlineLabel: string = "the deadline"): string {
  if (choice.mode !== "human") return "Referee: none -- the AI judges this bet.";
  return `A person decides this bet. If they don't rule by ${deadlineLabel}, you're both refunded. Referee: ${refereeAccount(choice) ?? ""}.`;
}

/** One bettor's tip, native units: the contract's side_fee (min(stake, max(stake*bps/10000, min_fee_per_side))). */
export function tipUnits(stakeUnits: bigint, minFeePerSideUnits: bigint): bigint {
  return feeForSideUnits(stakeUnits, minFeePerSideUnits);
}

/** The contract refuses when protocol fee + tip exceeds the stake (both use the same formula). */
export function tipProblem(stakeUnits: bigint, minFeePerSideUnits: bigint): string | null {
  const t = tipUnits(stakeUnits, minFeePerSideUnits);
  return t + t > stakeUnits ? "Protocol fee + tip exceeds the stake; raise the stake or drop the tip." : null;
}

/** S4b checkbox sentence (UX-5/UX-15). `tip` is the contract tip rule amount for the bettor's own stake, already formatted. */
export function refereeTipLine(tip: string, symbol: string): string {
  return `You pay ${tip} ${symbol} to the referee when the bet ends, whatever the result. That is the same as the platform fee on your stake.`;
}

/** The tip is carved out of the tipper's own stake and shown as its own line; this line changes when the checkbox flips. */
export function refereeCostLine(a: { tipOn: boolean; stake: string; tip: string; symbol: string }): string {
  if (!a.tipOn) return `No tip. You put in ${a.stake} ${a.symbol}.`;
  return `Tip to the referee: ${a.tip} ${a.symbol}, out of your ${a.stake} ${a.symbol} stake. It is not added on top.`;
}

/** UX-1: the invite is just "join Praetorial"; it never names anyone in a bet. */
export function inviteText(origin: string): string {
  return `Come and join Praetorial: ${origin.replace(/\/+$/, "")}/`;
}

export interface TipCostInput { makerTip: string; makerSymbol: string; takerTip: string; takerSymbol: string }
/** Review-card tip cost; the tip is carved out of the tipper's own stake (not added on top). */
export function tipCostLine(choice: RefereeChoice & { tipMaker?: boolean }, cost: TipCostInput): string {
  if (choice.mode !== "human") return "";
  if (!choice.tipMaker) return "No tip from you to the referee. The taker can choose to tip when they take the bet.";
  return `You tip the referee ${cost.makerTip} ${cost.makerSymbol}, taken from your stake. If the taker tips too, they pay ${cost.takerTip} ${cost.takerSymbol} from theirs.`;
}

/** The referee a taker must name (referee_ack) to take this bet; null in AI mode. */
export function refereeAckFor(env: { referee?: { account: string; mode?: string } | null }): string | null {
  return env.referee?.account ?? null;
}
