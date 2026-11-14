// RF2d (D-REFUI4): pure logic behind the BetPage Take screen. The page shows the agreed referee, offers the taker's
// own tip (same side_fee formula as the maker side), and re-reads the bet right before building the Take so a
// referee change since page load refuses instead of sending a stale `referee_ack`.
import nacl from "tweetnacl";
import { Bet, buildTakeMsg, feeForSideUnits } from "./escrowAdapter";
import { tipProblem } from "./referee";
import { estimatedStorageBytes, storageForRate, type StorageRates } from "./storageCharge";

type BetView = Pick<Bet, "status" | "envelope"> & { storage_rates?: StorageRates; fee_min_taker?: string | null; fee_min_taker_options?: string[] | null };

export interface TakeRefereeLine { mode: "human" | "ai"; referee: string | null; text: string }

/** `deadlineLabel`: the resolve deadline, already formatted for display. */
export function takeRefereeLine(bet: BetView, deadlineLabel: string): TakeRefereeLine {
  const ref = bet.envelope.referee?.account ?? null;
  if (!ref) return { mode: "ai", referee: null, text: "The AI judges this bet." };
  return { mode: "human", referee: ref, text: `A person decides this bet: ${ref}. If they don't rule by ${deadlineLabel}, you're both refunded.` };
}

export interface TakeTipOffer { visible: boolean; tipUnits: bigint; problem: string | null }

/** One thing the taker can deposit: the primary taker asset or a taker_options entry (TK1). */
export interface TakeChoice { asset: string; stake: bigint; deposit: bigint; isPrimary: boolean; tipUnits: bigint; problem: string | null; /** non-null = this choice cannot be taken (nothing may be built) */ blocked: string | null }

/**
 * Contract (handle_take, STG1): the deposit must equal stake + the TAKEN asset's own storage charge
 * (max(1, ceil(bytes * rate / 2048)), rate from bet.storage_rates[asset]) of EXACTLY one entry: the primary pair
 * (matched first) or the first taker_options entry with that asset. The fee/tip is side_fee(matched stake, fee_bps,
 * min) where min = bet.fee_min_taker for the primary and bet.fee_min_taker_options[i] (FM1, same index as taker_options[i])
 * for an option. A missing / length-mismatched array blocks the option choice instead of guessing.
 */
export function takeChoices(bet: BetView): TakeChoice[] {
  const e = bet.envelope;
  const bytes = estimatedStorageBytes(e.terms, e.terms_hash, e.models_snapshot_hash);
  const mk = (asset: string, stake: bigint, isPrimary: boolean, minRaw: string | null | undefined): TakeChoice => {
    const rate = bet.storage_rates?.[asset];
    const storage = rate == null ? 0n : storageForRate(bytes, rate);
    if (rate == null) {
      return { asset, stake, deposit: stake, isPrimary, tipUnits: 0n, problem: null,
        blocked: "The storage charge for this payment asset could not be read from the contract, so the deposit can't be computed; nothing was sent. Reload and try again." };
    }
    if (minRaw == null) {
      return { asset, stake, deposit: stake + storage, isPrimary, tipUnits: 0n, problem: null,
        blocked: "This bet does not list the minimum fee for this payment option, so it can't be checked; nothing was sent. Pick another asset or reload." };
    }
    const min = BigInt(minRaw);
    return { asset, stake, deposit: stake + storage, isPrimary, tipUnits: feeForSideUnits(stake, min), problem: tipProblem(stake, min), blocked: null };
  };
  const opts = e.taker_options ?? [];
  const mins = bet.fee_min_taker_options;
  const aligned = Array.isArray(mins) && mins.length === opts.length;
  const out = [mk(e.taker_asset, BigInt(e.stake_taker), true, bet.fee_min_taker ?? "0")];
  opts.forEach((o, i) => {
    if (out.some((c) => c.asset === o.asset)) return; // primary wins; first duplicate option wins (contract `find`)
    out.push(mk(o.asset, BigInt(o.amount), false, aligned ? mins![i] : null));
  });
  return out;
}

/** Taker tip = side_fee(taker stake) using the bet's own min-fee copy; hidden in AI mode. `asset` picks a taker option. */
export function takeTipOffer(bet: BetView, asset?: string): TakeTipOffer {
  if (!bet.envelope.referee) return { visible: false, tipUnits: 0n, problem: null };
  const c = takeChoices(bet).find((x) => x.asset === (asset ?? bet.envelope.taker_asset));
  if (!c) return { visible: false, tipUnits: 0n, problem: null };
  return { visible: true, tipUnits: c.tipUnits, problem: c.problem };
}

// ---- TK1: who may take (taker_allow) and the invite signature ----

/** Reads `invite=<128 hex>` (64-byte ed25519 signature) from a shared challenge link's query or hash; null if absent/malformed. */
export function parseInviteLink(link: string): string | null {
  const m = /[?&#]invite=([0-9a-fA-F]+)(?:[&#]|$)/.exec(link);
  return m && m[1].length === 128 ? m[1].toLowerCase() : null;
}

export type TakeEligibility = { ok: true; inviteSig: string | null } | { ok: false; message: string };

function hexBytes(h: string, n: number): Uint8Array | null {
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length !== n * 2) return null;
  return Uint8Array.from(Buffer.from(h, "hex"));
}

/** Mirrors handle_take's taker_allow check: Any / Account(a) == sender / InvitePubkey(pk) with a valid signature over
 *  `praetorial:invite:v1:{bet_id}:{sender}`. A refusal means nothing is built or sent. */
export function takeEligibility(a: { takerAllow: unknown; betId: number; taker: string | null; inviteSig: string | null }): TakeEligibility {
  let al: any = a.takerAllow;
  if (typeof al === "string" && al.startsWith("{")) { try { al = JSON.parse(al); } catch { /* fall through */ } }
  if (typeof al === "string" && al.startsWith('"')) { try { al = JSON.parse(al); } catch { /* fall through */ } }
  // A missing field is treated as public: the contract is the enforcer, this check only avoids sending a doomed take.
  if (al === undefined || al === null || al === "Any" || (al && typeof al === "object" && "Any" in al)) return { ok: true, inviteSig: a.inviteSig };
  if (al && typeof al === "object" && typeof al.Account === "string") {
    if (a.taker === al.Account) return { ok: true, inviteSig: a.inviteSig };
    return { ok: false, message: `This is a direct challenge for ${al.Account}; ${a.taker ? `you are ${a.taker}` : "sign in as that account"} and cannot take it. Nothing was sent.` };
  }
  if (al && typeof al === "object" && typeof al.InvitePubkey === "string") {
    if (!a.inviteSig) return { ok: false, message: "This bet is invite-only. Open the challenge link the maker sent you (it carries your invite); nothing was sent." };
    if (!a.taker) return { ok: false, message: "Sign in to take this invite-only bet; nothing was sent." };
    const pk = hexBytes(al.InvitePubkey, 32);
    const sig = hexBytes(a.inviteSig, 64);
    const msg = new TextEncoder().encode(`praetorial:invite:v1:${a.betId}:${a.taker}`);
    if (!pk || !sig || !nacl.sign.detached.verify(msg, sig, pk)) {
      return { ok: false, message: "This invite is not valid for your account on this bet (it must be signed by the maker's invite key for your account); nothing was sent." };
    }
    return { ok: true, inviteSig: a.inviteSig.toLowerCase() };
  }
  return { ok: false, message: "Unrecognised taker rules on this bet; nothing was sent." };
}

export type PreparedTake =
  | { ok: true; msg: string; tokenId: string; amount: string; refereeAck: string | null; tip: boolean }
  | { ok: false; message: string };

export async function prepareTake(a: {
  betId: number;
  shown: BetView;
  tip: boolean;
  inviteSig: string | null;
  /** The signed-in taker's account (needed for direct challenges and invites). */
  takerAccount?: string | null;
  /** Asset id of the chosen deposit: the primary taker_asset (default) or a taker_options asset. */
  asset?: string;
  readBet: (betId: number) => Promise<BetView | null>;
}): Promise<PreparedTake> {
  let now: BetView | null;
  try {
    now = await a.readBet(a.betId);
  } catch {
    return { ok: false, message: "Could not re-read the bet before taking it; nothing was sent. Try again." };
  }
  if (!now) return { ok: false, message: "This bet no longer exists; nothing was sent." };
  if (now.status !== "Open") return { ok: false, message: `This bet is ${now.status}, not open; nothing was sent.` };
  const shownRef = a.shown.envelope.referee?.account ?? null;
  const nowRef = now.envelope.referee?.account ?? null;
  if (shownRef !== nowRef) {
    return { ok: false, message: "The referee changed since you opened this page. Nothing was sent; reload and review the bet again." };
  }
  const elig = takeEligibility({ takerAllow: now.envelope.taker_allow, betId: a.betId, taker: a.takerAccount ?? null, inviteSig: a.inviteSig });
  if (!elig.ok) return { ok: false, message: elig.message };
  const choice = takeChoices({ ...now, storage_rates: a.shown.storage_rates ?? now.storage_rates }).find((c) => c.asset === (a.asset ?? now.envelope.taker_asset));
  if (!choice) return { ok: false, message: "That asset is no longer offered for this bet; nothing was sent. Reload and pick again." };
  if (choice.blocked) return { ok: false, message: choice.blocked };
  const tip = a.tip && !!nowRef;
  if (tip && choice.problem) return { ok: false, message: choice.problem };
  const msg = buildTakeMsg(a.betId, elig.inviteSig, { tip, refereeAck: nowRef });
  return { ok: true, msg, tokenId: choice.asset, amount: choice.deposit.toString(), refereeAck: nowRef, tip };
}
