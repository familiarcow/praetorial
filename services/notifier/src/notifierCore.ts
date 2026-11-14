// Host-neutral notifier core (CF1c2): computeNotices / computeNoticesMulti and the notice types, no fs/path, so the
// notifier Worker bundles it. notifier.ts re-exports this and keeps the node-only outbox/seen-keys file I/O.
// Notifier: computes which bets need a notice (proposed, challenge
// window closing soon, settled/voided) and writes them to a local
// outbox file. No contract call, ever — "alerts are a convenience: the
// contract never depends on them" (master map). The email provider is a
// stubbed interface: no real emails are sent, no PII (account IDs are
// NEAR accounts, already public onchain data, not email addresses —
// this build has no user-contact-info DB to read from, so it notifies
// by account id only; wiring a real email provider means implementing
// EmailProvider against whatever DKIM/SPF-capable service is chosen and
// supplying an account_id -> email mapping, neither of which exists in
// this testnet-only repo).
import type { Bet } from "@praetorial/common/types.js";

export type NoticeKind = "proposed" | "challenge_window_closing" | "settled" | "voided";

export interface Notice {
  bet_id: number;
  // D-UPGRADE1: which escrow contract (version) this bet lives on.
  // Optional/defaulted "" for the single-contract call path so every
  // pre-existing caller of computeNotices keeps compiling unchanged.
  contract_id?: string;
  kind: NoticeKind;
  to_accounts: string[];
  detail: string;
  computed_at: string;
}

/** Stub interface a real provider (SendGrid/Postmark/Resend/SES) would
 * implement. Deliberately not called by anything in this build. */
export interface EmailProvider {
  send(notice: Notice, toEmail: string): Promise<void>;
}

export class NoOpEmailProvider implements EmailProvider {
  async send(): Promise<void> {
    // Intentionally does nothing — no real emails are ever sent by this repo.
  }
}

const CLOSING_SOON_WINDOW_NS = 6 * 60 * 60 * 1_000_000_000; // 6h, ns

export function computeNotices(bets: Map<number, Bet>, nowNs: number, seenKeys: Set<string>): Notice[] {
  const notices: Notice[] = [];
  const mark = (key: string, build: () => Notice) => {
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    notices.push(build());
  };

  for (const [id, bet] of bets) {
    const accounts = [bet.envelope.maker, bet.taker].filter((a): a is string => !!a);
    if (bet.status === "Proposed" && bet.proposed_at !== null) {
      mark(`proposed:${id}`, () => ({
        bet_id: id,
        kind: "proposed",
        to_accounts: accounts,
        detail: `outcome=${bet.outcome} proposed_at=${bet.proposed_at}`,
        computed_at: new Date().toISOString(),
      }));
      const windowEnd = bet.proposed_at + bet.envelope.settlement_period;
      if (windowEnd - nowNs > 0 && windowEnd - nowNs <= CLOSING_SOON_WINDOW_NS) {
        mark(`closing:${id}`, () => ({
          bet_id: id,
          kind: "challenge_window_closing",
          to_accounts: accounts,
          detail: `settlement_period ends at ns=${windowEnd}`,
          computed_at: new Date().toISOString(),
        }));
      }
    }
    if (bet.status === "Settled") {
      mark(`settled:${id}`, () => ({
        bet_id: id,
        kind: "settled",
        to_accounts: accounts,
        detail: `outcome=${bet.outcome}`,
        computed_at: new Date().toISOString(),
      }));
    }
    if (bet.status === "Voided") {
      mark(`voided:${id}`, () => ({
        bet_id: id,
        kind: "voided",
        to_accounts: accounts,
        detail: "void",
        computed_at: new Date().toISOString(),
      }));
    }
  }
  return notices;
}

// D-UPGRADE1: runs computeNotices per configured contract and tags
// every resulting notice with its contract id. seenKeys is namespaced
// per contract ("<contractId>::<key>") so the same bet_id on two
// different contract versions is never deduped against each other.
export function computeNoticesMulti(
  betsByContract: Map<string, Map<number, Bet>>,
  nowNs: number,
  seenKeys: Set<string>,
): Notice[] {
  const notices: Notice[] = [];
  for (const [contractId, bets] of betsByContract) {
    // Redeploy at the same account restarts bet ids: record each bet's
    // identity under "<contract>::id:<n>" and, if it changes, forget the old
    // bet's seen keys so the NEW bet's notices are not swallowed (and go to
    // the new parties). First sight of an id records without purging, so
    // seen files written before this existed keep deduping.
    for (const [id, bet] of bets) {
      const idKey = `${contractId}::id:${id}`;
      const fp = `${bet.created_at}|${bet.envelope.maker}|${bet.envelope.terms_hash}`;
      const prevFp = [...seenKeys].find((k) => k.startsWith(`${idKey}=`));
      if (prevFp === `${idKey}=${fp}`) continue;
      if (prevFp !== undefined) {
        seenKeys.delete(prevFp);
        for (const kind of ["proposed", "closing", "settled", "voided"]) seenKeys.delete(`${contractId}::${kind}:${id}`);
      }
      seenKeys.add(`${idKey}=${fp}`);
    }
    const namespacedSeen = new NamespacedSeenSet(seenKeys, contractId);
    const contractNotices = computeNotices(bets, nowNs, namespacedSeen as unknown as Set<string>);
    for (const n of contractNotices) notices.push({ ...n, contract_id: contractId });
  }
  return notices;
}

/** Thin Set adapter that transparently prefixes every key with
 * `${contractId}::` before touching the real (shared) seenKeys set --
 * lets computeNotices stay untouched/single-contract-shaped while
 * still getting per-contract namespacing for free. */
class NamespacedSeenSet {
  constructor(private backing: Set<string>, private prefix: string) {}
  has(key: string): boolean {
    return this.backing.has(`${this.prefix}::${key}`);
  }
  add(key: string): this {
    this.backing.add(`${this.prefix}::${key}`);
    return this;
  }
}
