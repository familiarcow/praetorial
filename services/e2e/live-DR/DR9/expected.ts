// DR9 pure logic (no chain access): drill-4 expected refunds, drill verdict rules, pause-window rule, README line rule.
// emergency_refund (contracts/escrow/src/lib.rs, frozen freeze-candidate-2): maker gets stake_maker + storage_maker, taker (if any) gets
// stake_taker + storage_taker, in their own asset, no fee, via schedule_payout.
export interface RefundBet { maker: string; taker: string | null; stakeM: bigint; stakeT: bigint; storageM: bigint; storageT: bigint }

export function emergencyRefundCredits(b: RefundBet, _feeAccount: string): Map<string, bigint> {
  const c = new Map<string, bigint>();
  c.set(b.maker, (c.get(b.maker) ?? 0n) + b.stakeM + b.storageM);
  if (b.taker) c.set(b.taker, (c.get(b.taker) ?? 0n) + b.stakeT + b.storageT);
  return c;
}

/** observed: per-account balance delta (raw units). Returns mismatches; [] means exact (incl. fee account 0 and escrow residue 0). */
export function checkRefunds(b: RefundBet, feeAccount: string, observed: Record<string, bigint>, escrowAfter: bigint): string[] {
  const want = emergencyRefundCredits(b, feeAccount);
  const bad: string[] = [];
  for (const who of new Set([...want.keys(), ...Object.keys(observed), feeAccount])) {
    const w = want.get(who) ?? 0n, g = observed[who] ?? 0n;
    if (g !== w) bad.push(`${who}: observed ${g} != expected ${w}`);
  }
  if (escrowAfter !== 0n) bad.push(`escrow holds ${escrowAfter} after refunds, expected 0`);
  return bad;
}

export interface Verdict { verdict: "PASS" | "FAIL" | "NOT-DRILLED"; reason?: string }

export function drill2Verdict(i: { tokenPresent: boolean; alertGeneratedOffline: boolean; delivered: boolean }): Verdict {
  if (!i.tokenPresent) return { verdict: "NOT-DRILLED", reason: "ALERT_TELEGRAM_BOT_TOKEN missing from $PRAETORIAL_SECRETS_DIR/praetorial-alerts.env (ALRT1, familiarcow step)" };
  return i.delivered ? { verdict: "PASS" } : { verdict: "FAIL", reason: "alert not confirmed delivered" };
}

export function drill3Verdict(i: { causedDelay: boolean; txs: string[] }): Verdict {
  if (!i.causedDelay) return { verdict: "NOT-DRILLED", reason: "no safe way to delay a payout without a contract change" };
  return i.txs.length > 0 ? { verdict: "PASS" } : { verdict: "FAIL", reason: "no retry_payout/drain_payouts tx recorded" };
}

export function pauseWindowProblems(i: { pausedAtMs: number; unpausedAtMs: number; pausedAfterUnpause: boolean; pauseTx: string; unpauseTx: string }): string[] {
  const bad: string[] = [];
  if (i.unpausedAtMs - i.pausedAtMs >= 10 * 60_000) bad.push("pause window >= 10 minutes");
  if (i.pausedAfterUnpause) bad.push("is_new_offers_paused still true after unpause");
  if (!i.pauseTx) bad.push("pause tx hash missing");
  if (!i.unpauseTx) bad.push("unpause tx hash missing");
  return bad;
}

/** README rule: lines `Drill N: PASS tx <hash>` or `Drill N: NOT-DRILLED (<reason>)`, all four present. */
export function readmeProblems(text: string): string[] {
  const bad: string[] = [];
  for (const n of [1, 2, 3, 4]) {
    const line = text.split("\n").find((l) => l.startsWith(`Drill ${n}:`));
    if (!line) { bad.push(`Drill ${n}: line missing`); continue; }
    if (/^Drill \d: PASS/.test(line)) { if (!/\btx\s+\S+/.test(line)) bad.push(`Drill ${n}: PASS without a tx hash`); }
    else if (/^Drill \d: NOT-DRILLED/.test(line)) { if (!/NOT-DRILLED \([^)]+\)/.test(line)) bad.push(`Drill ${n}: NOT-DRILLED without a reason`); }
    else bad.push(`Drill ${n}: verdict must be PASS or NOT-DRILLED(reason)`);
  }
  return bad;
}
