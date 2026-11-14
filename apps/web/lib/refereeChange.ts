// FE10b / D-FE10B1: changing the referee from the live bet page. Mirrors contracts/escrow/src/lib.rs `pub fn amend_referee`:
//  - Open (untaken): the maker alone sets/removes the referee and it applies at once.
//  - Taken with no challenge bond: BOTH parties must send the same text (commit_two_party: maker_value == taker_value, then it applies and
//    both sides are cleared). The contract has no decline/withdraw call: "decline" is a page-local dismissal, nothing is sent.
//  - Anything later (Resolving, Proposed, Challenged, Evidence, Rejudge, terminal): frozen.
// `new_referee_json` is serde_json of Option<Referee>: `{"account":..,"mode":"Human"}` or `null` (switch to the AI; the tips are cleared).
// Relayed through services/relayer (policy.ts): args exactly {bet_id: integer, new_referee_json: string <= 4096 bytes}, deposit 0.
import type { Bet } from "./escrowAdapter";
import { refereeJson, pendingRefereeProposal } from "./liveBet";
import { isUsableAccount } from "./referee";

export const AMEND_REFEREE_JSON_MAX_BYTES = 4096;

export interface AmendRefusalRow { id: string; source: string; line: number; message: string }
// Every require()/panic_str reached by amend_referee, commit_two_party and bet_mut. `line` is the lib.rs line that raises it
// (tests/refereeChange.unit.test.ts checks the text is still on that line). No numbers are written into the copy.
export const AMEND_REFEREE_REFUSALS: AmendRefusalRow[] = [
  { id: "shutdown", source: "contract is shut down", line: 3521, message: "This app has been shut down, so the referee can't be changed" },
  { id: "bad-json", source: "new_referee_json must be a valid Option<Referee> JSON", line: 3525, message: "That referee wasn't understood" },
  { id: "terminal", source: "bet already terminal", line: 3538, message: "This bet is already over, so its referee can't be changed" },
  { id: "frozen", source: "referee frozen once a decision or dispute starts", line: 3547, message: "The referee can't be changed now: a ruling is in progress or has been made" },
  { id: "maker-or-fee", source: "referee cannot be maker or fee_account", line: 3552, message: "That account can't be the referee: it is the maker or the app's fee account" },
  { id: "named-taker", source: "referee cannot be the named taker", line: 3560, message: "The referee can't be the person this bet was made for" },
  { id: "taker", source: "referee cannot be the taker", line: 3563, message: "The referee can't be the person who took the bet" },
  { id: "maker-only", source: "only the maker may edit an untaken offer", line: 3568, message: "Only the person who made this offer can change its referee before it is taken" },
  { id: "party-only", source: "only maker or taker may propose", line: 3778, message: "Only the two people in this bet can change its referee" },
  { id: "unknown-bet", source: "unknown bet_id", line: 5561, message: "We can't find this bet" },
];

export function plainAmendRefusal(reason: string): { known: boolean; message: string } {
  const row = AMEND_REFEREE_REFUSALS.find((r) => reason.includes(r.source));
  return row ? { known: true, message: row.message } : { known: false, message: "The referee change didn't go through. Nothing changed" };
}

/** The exact args the relayer allows for amend_referee. `account` null = switch to the AI. */
export function buildAmendRefereeArgs(betId: number, account: string | null): { bet_id: number; new_referee_json: string } {
  return amendArgsFromJson(betId, refereeJson(account));
}

/** Same shape from an already-serialised referee (agreeing sends the other side's stored text unchanged). */
export function amendArgsFromJson(betId: number, json: string): { bet_id: number; new_referee_json: string } {
  if (!Number.isInteger(betId) || betId < 0) throw new Error("bet id must be a non-negative integer");
  if (new TextEncoder().encode(json).length > AMEND_REFEREE_JSON_MAX_BYTES) throw new Error("referee text is too long");
  return { bet_id: betId, new_referee_json: json };
}

export type ChangeMode = "maker-alone" | "propose" | "frozen" | "none";

export function refereeChangeMode(bet: Pick<Bet, "status" | "bonds" | "taker" | "envelope">, me: string | null): ChangeMode {
  if (!me) return "none";
  const isMaker = bet.envelope.maker === me;
  const isTaker = !!bet.taker && bet.taker === me;
  if (!isMaker && !isTaker) return "none";
  if (bet.status === "Open") return isMaker ? "maker-alone" : "none";
  if (bet.status === "Taken" && bet.bonds.length === 0) return "propose";
  return "frozen";
}

/** Problems with the referee typed in, mirroring amend_referee's own checks. Empty = fine to send. */
export function validateNewReferee(account: string, bet: Pick<Bet, "taker" | "envelope">, feeAccount?: string | null): string[] {
  const a = account.trim();
  if (!a) return ["Type the account of the person you want."];
  if (!isUsableAccount(a)) return ["Type the person's full account name."];
  if (a === bet.envelope.maker) return ["The maker can't be the referee."];
  if (feeAccount && a === feeAccount) return ["That account can't be a referee."];
  const ta = bet.envelope.taker_allow as any;
  if (ta && typeof ta === "object" && ta.Account === a) return ["Referee cannot be the named taker."];
  if (bet.taker && a === bet.taker) return ["Referee cannot be the taker."];
  if (bet.envelope.referee?.account === a) return ["That person is already the referee."];
  return [];
}

/** Switching to the AI needs terms text on the bet (a hash-only bet has none) that names sources for a fresh preflight. */
export function hasPreflightableSources(bet: Pick<Bet, "envelope">): boolean {
  if (!bet.envelope.referee) return false;
  const t = bet.envelope.terms;
  if (!t) return false;
  try {
    const p = JSON.parse(t);
    return !!p && Array.isArray(p.sources_allowed) && p.sources_allowed.length > 0;
  } catch { return false; }
}

export interface AgreeOffer { json: string; account: string | null }

/** What `me` would agree to: the other side's proposal, as the exact stored text (commit_two_party compares text). Null when none or already mine. */
export function proposalToAgree(bet: Bet, me: string | null): AgreeOffer | null {
  if (!me || refereeChangeMode(bet, me) !== "propose") return null;
  const p = bet.referee_proposal as { maker_value: string | null; taker_value: string | null } | undefined;
  if (!p) return null;
  const meMaker = bet.envelope.maker === me;
  const other = meMaker ? p.taker_value : p.maker_value;
  const mine = meMaker ? p.maker_value : p.taker_value;
  if (other == null || other === mine) return null;
  try { const v = JSON.parse(other); return { json: other, account: v == null ? null : String(v.account ?? "") }; } catch { return null; }
}

export type AmendOutcome =
  | { kind: "changed"; message: string }
  | { kind: "proposed"; message: string }
  | { kind: "frozen"; message: string }
  | { kind: "pending"; message: string };

export const STILL_CONFIRMING = "We sent your change but can't see it on the bet yet. Check again in a moment before trying again.";

/** Success only when get_bet shows it: the referee flipped (changed) or my side's proposal is stored (proposed). */
export async function confirmAmend(a: {
  betId: number; expected: string | null; via: "maker-alone" | "propose"; me: string;
  deps: { getBet: (id: number) => Promise<Bet | null>; sleep: (ms: number) => Promise<void> };
  attempts?: number; delayMs?: number;
}): Promise<AmendOutcome> {
  const attempts = Math.max(1, a.attempts ?? 8);
  const delayMs = a.delayMs ?? 2000;
  const wantJson = refereeJson(a.expected);
  for (let i = 0; i < attempts; i++) {
    let b: Bet | null = null;
    try { b = await a.deps.getBet(a.betId); } catch { b = null; }
    if (b) {
      const now = b.envelope.referee?.account ?? null;
      if (now === a.expected) {
        return { kind: "changed", message: a.expected ? `The referee is now ${a.expected}.` : "The AI now decides this bet." };
      }
      if (a.via === "propose") {
        const p = (b.referee_proposal ?? {}) as { maker_value?: string | null; taker_value?: string | null };
        const mine = b.envelope.maker === a.me ? p.maker_value : p.taker_value;
        if (mine === wantJson && refereeChangeMode(b, a.me) === "propose") {
          const other = b.envelope.maker === a.me ? b.taker : b.envelope.maker;
          return { kind: "proposed", message: `You proposed ${a.expected ?? "the AI"}. It only changes when ${other ?? "the other side"} proposes the same.` };
        }
      }
      if (refereeChangeMode(b, a.me) === "frozen") {
        return { kind: "frozen", message: "The bet moved on before your change landed, so the referee wasn't changed." };
      }
    }
    if (i < attempts - 1) await a.deps.sleep(delayMs);
  }
  return { kind: "pending", message: STILL_CONFIRMING };
}

export { pendingRefereeProposal };
