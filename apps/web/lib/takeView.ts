import { COPY } from "./globalStates";
// FE9 (S10, S11): pure logic of the link holder's bet page: which state the page is in, the race guard run right before signing,
// the read-back after the Take is sent, and the taker-side input for the shared review card (lib/reviewCard.ts).
// Every number comes from the bet / contract views; nothing is hard-coded here.
import type { Bet } from "./escrowAdapter";
import { termSheetSummary } from "./escrowAdapter";
import { symbolForAssetId, findAsset } from "./assets";
import { humanUnits } from "./storageCharge";
import { takeChoices } from "./takeScreen";
import { formatUtc } from "./offerExpiry";
import { parseTakeRejected, plainTakeRefusal, takeRefusalSentence } from "./takeRefusal";
import { AI_CHOICE, humanChoice } from "./referee";
import type { StructuredOffer } from "../src/components/ReviewCard";
import type { ReviewStorage } from "./reviewCard";

type BetView = Bet & { storage_rates?: Record<string, string>; fee_min_taker?: string | null; fee_min_taker_options?: string[] | null };

export type Availability =
  | { kind: "available" }
  | { kind: "notfound" | "taken" | "cancelled" | "expired" | "paused" | "shutdown" | "not-you" | "invite-needed" | "own" | "referee-you" | "hash-only"; message: string };

export function takeAvailability(bet: BetView | null, ctx: { account: string | null; inviteSig: string | null; nowNs: bigint; paused: boolean; shutdown: boolean }): Availability {
  if (!bet) return { kind: "notfound", message: "We couldn't find this bet. Check the link you were sent." };
  if (bet.status === "Cancelled") return { kind: "cancelled", message: "The maker cancelled this bet." };
  if (bet.status === "Expired") return { kind: "expired", message: "This offer has expired." };
  if (bet.status !== "Open") return { kind: "taken", message: "Someone already took this bet." };
  if (ctx.nowNs > BigInt(bet.envelope.funding_deadline)) return { kind: "expired", message: "This offer has expired." };
  if (ctx.shutdown) return { kind: "shutdown", message: COPY.takeShutdown };
  if (ctx.paused) return { kind: "paused", message: COPY.takePaused };
  // SECREV1 SR-5: a hash-only AI bet (terms not kept on chain) can be forced to a signed VOID by anyone passing missing or junk terms
  // to request_resolution (frozen escrow + resolver). The app always opens with keep_terms:true; refuse to take any other.
  if ((bet.envelope as any).keep_terms === false && !bet.envelope.referee) {
    return { kind: "hash-only", message: "This bet's terms aren't stored on chain, so it can't be judged safely. Praetorial can't take it." };
  }
  if (ctx.account && ctx.account === bet.envelope.maker) return { kind: "own", message: "This is your own bet. Share the link so someone else can take it." };
  if (ctx.account && bet.envelope.referee?.account === ctx.account) return { kind: "referee-you", message: "You're the referee on this bet, so you can't take it." };
  const allow: any = bet.envelope.taker_allow;
  if (allow && typeof allow === "object" && typeof allow.Account === "string" && ctx.account && allow.Account !== ctx.account) {
    return { kind: "not-you", message: `This bet is only for ${allow.Account}, and you're signed in as ${ctx.account}. Sign in as that account to take it.` };
  }
  if (allow && typeof allow === "object" && "InvitePubkey" in allow && !ctx.inviteSig) {
    return { kind: "invite-needed", message: "This bet is invite-only. Open the personal link the maker sent you." };
  }
  return { kind: "available" };
}

export type RaceResult = { ok: true } | { ok: false; changed: ("referee" | "stakes" | "deadlines" | "terms")[]; details: string[]; message: string };

const j = (v: unknown) => JSON.stringify(v ?? null);
const refName = (r: { account?: string } | null | undefined) => (r?.account ? r.account : "the AI");
const when = (ns: number) => formatUtc(Math.round(Number(ns) / 1e9));

/** Compares the bet the taker reviewed with the bet as it is now. Any difference stops the take before anything is signed.
 *  REVIEW1 (#3): `details` says what changed (old -> new) so the screen can show it. */
export function raceGuard(shown: BetView, now: BetView): RaceResult {
  const a = shown.envelope, b = now.envelope;
  const changed: ("referee" | "stakes" | "deadlines" | "terms")[] = [];
  const details: string[] = [];
  if (j(a.referee) !== j(b.referee)) { changed.push("referee"); details.push(`Referee: ${refName(a.referee)} -> ${refName(b.referee)}`); }
  if (a.stake_maker !== b.stake_maker || a.stake_taker !== b.stake_taker || a.maker_asset !== b.maker_asset || a.taker_asset !== b.taker_asset || j(a.taker_options) !== j(b.taker_options)) {
    changed.push("stakes");
    if (a.stake_maker !== b.stake_maker) details.push(`Maker's stake: ${a.stake_maker} -> ${b.stake_maker} units`);
    if (a.stake_taker !== b.stake_taker) details.push(`Your stake: ${a.stake_taker} -> ${b.stake_taker} units`);
    if (a.maker_asset !== b.maker_asset || a.taker_asset !== b.taker_asset || j(a.taker_options) !== j(b.taker_options)) details.push("The tokens you can pay with changed");
  }
  if (a.funding_deadline !== b.funding_deadline || a.resolve_deadline !== b.resolve_deadline || a.settlement_period !== b.settlement_period) {
    changed.push("deadlines");
    if (a.funding_deadline !== b.funding_deadline) details.push(`Offer closes: ${when(a.funding_deadline)} -> ${when(b.funding_deadline)}`);
    if (a.resolve_deadline !== b.resolve_deadline) details.push(`Decided by: ${when(a.resolve_deadline)} -> ${when(b.resolve_deadline)}`);
    if (a.settlement_period !== b.settlement_period) details.push("The challenge window changed");
  }
  if (a.terms_hash !== b.terms_hash || a.models_snapshot_hash !== b.models_snapshot_hash || a.terms !== b.terms || a.fee_bps !== b.fee_bps || a.maker !== b.maker || a.maker_side !== b.maker_side || j(a.taker_allow) !== j(b.taker_allow)) {
    changed.push("terms");
    details.push(a.fee_bps !== b.fee_bps ? "The fee changed" : "The bet's terms changed");
  }
  if (changed.length === 0) return { ok: true };
  const list = changed.length === 1 ? changed[0] : `${changed.slice(0, -1).join(", ")} and ${changed[changed.length - 1]}`;
  return { ok: false, changed, details, message: `The ${list} changed since you opened this page. Nothing was signed or sent. Reload and review the bet again.` };
}

export interface TakeDeps {
  getBet(id: number): Promise<BetView | null>;
  balance(): Promise<bigint>;
  txLogs(txHash: string): Promise<string[] | null>;
  sleep(ms: number): Promise<void>;
}
export type TakeOutcome =
  | { kind: "taken"; message: string }
  | { kind: "lost"; message: string }
  | { kind: "gone"; message: string }
  | { kind: "refused"; reason: string | null; known: boolean; refunded: boolean; sentence: string }
  | { kind: "pending"; message: string };

export const TAKEN_BY_ME = "You took this bet. It's live now.";
export const LOST_RACE = "Someone else took this bet first. Your money was returned.";
export const GONE_MESSAGE = "This bet was cancelled or expired before your take landed. Your money was returned.";
export const TAKE_PENDING = "Still confirming. Your money is safe; check My bets.";

async function safe<T>(f: () => Promise<T>): Promise<T | undefined> { try { return await f(); } catch { return undefined; } }

/** Success is shown ONLY when get_bet lists this account as the taker. */
export async function confirmTake(a: { betId: number; me: string; deps: TakeDeps; before: { balance: bigint }; txHash: string | null; attempts?: number; delayMs?: number }): Promise<TakeOutcome> {
  const attempts = a.attempts ?? 10;
  const delay = a.delayMs ?? 2000;
  const verdict = (bet: BetView | null | undefined): TakeOutcome | null => {
    if (!bet) return null;
    if (bet.status === "Cancelled" || bet.status === "Expired") return { kind: "gone", message: GONE_MESSAGE };
    if (bet.status !== "Open") return bet.taker === a.me ? { kind: "taken", message: TAKEN_BY_ME } : { kind: "lost", message: LOST_RACE };
    return null;
  };
  for (let i = 0; i < attempts; i++) {
    const v = verdict(await safe(() => a.deps.getBet(a.betId)));
    if (v) return v;
    const logs = a.txHash ? await safe(() => a.deps.txLogs(a.txHash!)) : undefined;
    if (logs) {
      const late = verdict(await safe(() => a.deps.getBet(a.betId)));
      if (late) return late;
      const reason = parseTakeRejected(logs);
      const bal = await safe(() => a.deps.balance());
      const refunded = typeof bal === "bigint" && bal >= a.before.balance;
      return { kind: "refused", reason, known: plainTakeRefusal(reason).known, refunded, sentence: takeRefusalSentence(reason, refunded) };
    }
    if (i < attempts - 1) await a.deps.sleep(delay);
  }
  return { kind: "pending", message: TAKE_PENDING };
}

function periodLabel(ns: number): string {
  const secs = Math.round(ns / 1e9);
  if (secs % 86400 === 0) return `${secs / 86400} day${secs === 86400 ? "" : "s"}`;
  if (secs % 3600 === 0) return `${secs / 3600} hour${secs === 3600 ? "" : "s"}`;
  return `${Math.round(secs / 60)} minutes`;
}

/**
 * The shared review card is written from the maker's point of view ("you" = the first side). For the taker the sides are swapped:
 * "your" stake is the taker stake in the asset being paid, the tip is carved out of that stake (never added), and the storage
 * line is the contract's charge for the taken asset. pay-now = stake + storage.
 */
export function takerReviewOffer(bet: BetView, o: { tip: boolean; deadlineLabel?: string | null; offerClosesLabel?: string | null; asset?: string; refereeUsername?: string }): { offer: StructuredOffer; storage: ReviewStorage | null } {
  const e = bet.envelope;
  const choice = takeChoices(bet).find((c) => c.asset === (o.asset ?? e.taker_asset)) ?? takeChoices(bet)[0];
  const mySym = symbolForAssetId(choice.asset);
  const theirSym = symbolForAssetId(e.maker_asset);
  const myDec = findAsset(mySym)?.decimals ?? 0;
  const theirDec = findAsset(theirSym)?.decimals ?? 0;
  const human = (u: bigint, d: number) => Number(humanUnits(u, d));
  const refAcct = e.referee?.account ?? null;
  const storageUnits = choice.deposit - choice.stake;
  const mineText = `${humanUnits(storageUnits, myDec)} ${mySym}`;
  const offer: StructuredOffer = {
    side: "taker",
    termSheet: {} as any,
    claimText: termSheetSummary(e),
    sources: [],
    deadlineLabel: o.deadlineLabel ?? "the date in the terms",
    makerAssetSymbol: mySym,
    makerAmount: human(choice.stake, myDec),
    takerAssetSymbol: theirSym,
    takerAmount: human(BigInt(e.stake_maker), theirDec),
    odds: Number(e.stake_maker) / Math.max(1, Number(e.stake_taker)),
    settlementPeriodLabel: periodLabel(e.settlement_period),
    resolveByLabel: refAcct ? formatUtc(Math.round(e.resolve_deadline / 1e9)) : null,
    offerClosesLabel: o.offerClosesLabel === undefined ? `This offer closes ${formatUtc(Math.round(e.funding_deadline / 1e9))}` : o.offerClosesLabel,
    takerOptions: [],
    referee: refAcct ? humanChoice(refAcct) : AI_CHOICE,
    refereeUsername: o.refereeUsername,
    tipMaker: o.tip && !!refAcct,
    viewerFee: human(choice.tipUnits, myDec),
    takerAccount: null,
    flags: [],
    priceWarning: null,
    customVenueNotes: [],
  };
  const storage: ReviewStorage | null = bet.storage_rates?.[choice.asset] == null ? null : { maker: mineText, taker: mineText, makerUnits: storageUnits.toString(), takerUnits: storageUnits.toString() };
  return { offer, storage };
}
