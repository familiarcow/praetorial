// MODAL1c3: the resolution actions (request the result, challenge, concede, referee ruling) as modals over the bet page.
// The relay logic is the BetPage's / RequestResultSection's, moved here unchanged (same methods, args, deposits, gas via useRelayAction).
// One irreversible step each: read exactly what happens (amount, fee, asset), then confirm. Mutual settle does not exist in the contract (D-SETTLE3).
// M1 (UIR1 §3.6, PEOPLE RULE, SM2): each confirm is a ConfirmSheet (lib/resolutionFlows resolutionSheet: rows + risk + short label,
// people as @username), gated by useGate(action); the challenge bond shortfall is gate("challenge", {short}) with Add money (B1-9).
import React, { useRef, useState } from "react";
import { Button } from "../ui";
import type { FlowStep } from "../../lib/flowModal";
import { FlowModal, type FlowApi, type FlowResult } from "../modal/FlowModal";
import { getBet, buildChallengeMsg, buildConcedeArgs, type Bet, type ChallengeBondQuote } from "../../lib/escrowAdapter";
import { buildStakeTransfer } from "../../lib/stakeTransfer";
import { confirmChallenge, challengeGuard } from "../../lib/ruling";
import { confirmConcede, concedeGuard } from "../../lib/liveBet";
import { confirmRule, refereeRuleArgs, REFEREE_RULE_METHOD, type RuleOutcome } from "../../lib/refereeScreen";
import { buildRequestResolutionArgs, requestLanded } from "../../lib/requestResult";
import {
  RESOLUTION_STEPS, RESOLUTION_DRAFT_KEY, flowPhase, type FlowPhase, requestResultTerms, resolutionSheet, type SheetRow,
} from "../../lib/resolutionFlows";
import { fundingCheck } from "../../lib/fundingGate";
import { person, personLabel, type Names } from "../../lib/betView";
import type { Short, UserAction } from "../../lib/appState";
import { KeyValue } from "../kit/blocks";
import { GateNotice, useGate } from "../kit/Gate";
import { DECLINED_MESSAGE } from "../../lib/openRefusal";
import { confirmTiming } from "../../lib/openConfirm";
import { contractRefusalMessage } from "../../lib/relayGas";
import { ESCROW_CONTRACT_ID } from "../../lib/config";
import { useRelayAction } from "../../lib/useRelayAction";
import { needsUserSignedTx, runDirectTx } from "../../lib/directTx";
import type { BetPageWallet } from "./BetPage";

export interface ResolutionOutcome { kind: string; message: string }
export interface Run extends ResolutionOutcome { txHash?: string | null; /** MODAL1c5: the technical reason shown under a failure (the relayer's / chain's own words). */ detail?: string | null }

interface BaseProps {
  /** Called when the modal closes, with the last outcome (if any) so the page can keep the result line. */
  onClose: (last: ResolutionOutcome | null) => void;
  bet: Bet; betId: number; wallet: BetPageWallet | null;
  /** M1: @usernames for the people the sheet names (BetPage's names map). Missing = "Unnamed account", never a raw id. */
  names?: Names;
  /** The bet changed on chain: the page re-reads it. */
  onChanged?: () => void;
}

const sleep = (ms: number) => new Promise<void>((x) => setTimeout(x, ms));
const deps = { getBet: (id: number) => getBet(id), sleep };

interface ShellProps {
  kind: string; title: string; draftId: number; termsTestId: string; confirmTestId: string; cancelTestId: string;
  resultTestId: (phase: "success" | "pending" | "failure") => string;
  confirmLabel: string; destructive?: boolean; disabled?: boolean;
  /** MODAL1c4: the cancel / change-referee modals reuse this shell with their own steps, draft key, phase mapping and Cancel label. */
  detailTestId?: string; steps?: FlowStep[]; draftKey?: string; phaseOf?: (kind: string) => FlowPhase; cancelLabel?: string;
  terms?: React.ReactNode;
  /** M1 (ConfirmSheet anatomy): what moves, how much, to whom (KeyValue), and one plain risk sentence under it. */
  rows?: SheetRow[]; risk?: React.ReactNode;
  /** M1 (SM2): the action's gate. Its GateNotice shows in the sheet and the confirm is off while it blocks. `short` = the pay-in shortfall. */
  action?: UserAction; short?: Short | null;
  run: () => Promise<Run>;
  onClose: (last: ResolutionOutcome | null) => void;
}

/** One confirm step inside the shared FlowModal, laid out as the kit ConfirmSheet (UIR1 §3.6): rows + risk in the body, short labels,
 *  primary first and stacked full width on phones; `destructive` = the filled high-contrast danger button. */
export function ResolutionShell(p: ShellProps) {
  const last = useRef<Run | null>(null);
  const g = useGate(p.action ?? "view-bet", { short: p.short });
  const blocked = !!p.action && !g.allowed;
  const onSubmit = async (): Promise<FlowResult> => {
    const out = await p.run();
    if (out.kind === "stay") return { kind: "stay" };
    last.current = out;
    const phase = (p.phaseOf ?? flowPhase)(out.kind);
    if (phase === "success") return { kind: "success", txHash: out.txHash ?? null, message: out.message };
    if (phase === "pending") return { kind: "pending", txHash: out.txHash ?? null, message: out.message };
    return { kind: "failure", reason: out.message };
  };
  const renderStep = (_s: unknown, api: FlowApi) => (
    <div className="k-stack">
      <div data-testid={p.termsTestId} data-kit="ConfirmSheet" data-danger={p.destructive ? "1" : "0"}>
        {p.terms}
        {p.rows && <KeyValue variant="total" rows={p.rows} data-testid={`${p.termsTestId}-rows`} />}
        {p.risk != null && <p className="k-sheet__risk" data-testid={`${p.termsTestId}-risk`}>{p.risk}</p>}
      </div>
      {p.action && <GateNotice action={p.action} short={p.short} testId={`${p.kind}-gate`} />}
      <div className={`k-actions k-actions--stack k-sheet__footer${p.destructive ? " k-danger-fill" : ""}`} data-kit="ConfirmSheet-actions">
        <Button data-testid={p.confirmTestId} variant={p.destructive ? "destructive" : "primary"} disabled={api.busy || p.disabled || blocked} onClick={() => api.submit()}>{p.confirmLabel}</Button>
        <Button data-testid={p.cancelTestId} variant="secondary" disabled={api.busy} onClick={() => p.onClose(null)}>{p.cancelLabel ?? "Cancel"}</Button>
      </div>
    </div>
  );
  return (
    <FlowModal
      isOpen title={p.title} steps={p.steps ?? RESOLUTION_STEPS} draftKey={p.draftKey ?? RESOLUTION_DRAFT_KEY(p.kind, p.draftId)} ownNav submitLabel={p.confirmLabel}
      onClose={() => p.onClose(last.current ? { kind: last.current.kind, message: last.current.message } : null)}
      onSubmit={onSubmit} renderStep={renderStep}
      renderResult={(r) => (
        <div>
          <span data-testid={p.resultTestId(r.phase)} data-kind={last.current?.kind ?? (r.phase === "failure" ? "refused" : r.phase)}>
            {r.phase === "failure" ? r.reason : last.current?.message ?? ""}
          </span>
          {r.phase === "failure" && p.detailTestId && last.current?.detail ? <small data-testid={p.detailTestId}> Details: {last.current.detail}</small> : null}
        </div>
      )}
    />
  );
}

/** Sign + relay one method; a decline in the wallet is reported as such, a refused/failed relay as the plain reason. */
export async function relay(action: ReturnType<typeof useRelayAction>, wallet: BetPageWallet, p: { receiverId: string; methodName: string; args: Record<string, unknown>; depositYocto?: string }, failMsg: string): Promise<{ ok: true; txHash: string | null } | { ok: false; out: Run }> {
  let declined = false;
  const signRawHash = async (a: string, h: string) => { try { return await wallet.signRawHash(a, h); } catch (e) { declined = true; throw e; } };
  // RELAYDEP1 / D-RELAYDEP1: a deposit inside a relayed delegate is paid by the RELAYER, so deposit-bearing calls (the request_resolution bond) are user-signed transactions.
  const r = needsUserSignedTx(p.methodName, BigInt(p.depositYocto ?? "0")) ? await runDirectTx({
    senderId: wallet.nearAddress, publicKeyHexEd25519: wallet.nearAddress, receiverId: p.receiverId, methodName: p.methodName, args: p.args, depositYocto: p.depositYocto ?? "0", signRawHash,
  }) : await action.run({
    senderId: wallet.nearAddress, publicKeyHexEd25519: wallet.nearAddress, receiverId: p.receiverId, methodName: p.methodName, args: p.args, depositYocto: p.depositYocto,
    signRawHash: async (a, h) => { try { return await wallet.signRawHash(a, h); } catch (e) { declined = true; throw e; } },
  });
  if (declined) return { ok: false, out: { kind: "declined", message: DECLINED_MESSAGE } };
  if (!r.ok) return { ok: false, out: { kind: "refused", message: contractRefusalMessage(r) ?? failMsg } };
  return { ok: true, txHash: r.txHash ?? null };
}

// ---- Request the result (AI judge): LH5 / D-HORIZON2
export function RequestResultModal({ bet, betId, wallet, onClose, onChanged }: BaseProps) {
  const action = useRelayAction();
  const t = requestResultTerms(bet);
  const sheet = resolutionSheet.requestResult(bet);
  async function run(): Promise<Run> {
    if (!wallet) return { kind: "refused", message: "Sign in first. Nothing was sent." };
    const sent = await relay(action, wallet, { receiverId: ESCROW_CONTRACT_ID, methodName: "request_resolution", args: buildRequestResolutionArgs(betId), depositYocto: t.depositYocto.toString() },
      "The request didn't go through. Nothing was sent and no money moved.");
    if (!sent.ok) return sent.out;
    const tm = confirmTiming();
    // LIFE1: a challenged bet already carries an outcome and a stale pending_resolution_request, so only a new run (runs_used up,
    // or the bet moved on from the status it had when the modal opened) proves this request landed.
    for (let i = 0; i < Math.max(1, tm.attempts ?? 8); i++) {
      const b = await getBet(betId).catch(() => null);
      if (requestLanded(bet, b)) { onChanged?.(); return { kind: "requested", message: "Requested. The AI judge is checking now.", txHash: sent.txHash }; }
      if (i < (tm.attempts ?? 8) - 1) await sleep(tm.delayMs ?? 2000);
    }
    return { kind: "pending", message: "We sent your request but can't see it on the bet yet. Check again in a moment before trying again.", txHash: sent.txHash };
  }
  return <ResolutionShell kind="request-result" title={sheet.title} draftId={betId} termsTestId="request-result-terms" confirmTestId="request-result-confirm" cancelTestId="request-result-cancel"
    resultTestId={() => "request-result-result"} confirmLabel={sheet.confirmLabel} disabled={!wallet} action="request-result" rows={sheet.rows} risk={sheet.risk} run={run} onClose={onClose} />;
}

// ---- Challenge: the bond is stated up front, before the confirm
export function ChallengeModal({ bet, betId, wallet, quote, onClose, onChanged }: BaseProps & { quote: ChallengeBondQuote }) {
  const action = useRelayAction();
  const sheet = resolutionSheet.challenge(bet, quote);
  // SM2 B1-9: a bond the betting balance can't cover is gate("challenge", {short}): the GateNotice offers Add money over the page.
  const [short, setShort] = useState<Short | null>(null);
  // LFIX1 (SM1 CON-1/CON-5): the bet as shown when the modal opened; re-read and compared just before the bond is signed.
  const [shown] = useState<Bet>(() => bet);
  async function run(): Promise<Run> {
    if (!wallet) return { kind: "refused", message: "Sign in first. Nothing was sent." };
    let fresh: Bet | null;
    try { fresh = await getBet(betId); } catch { fresh = null; }
    const g = challengeGuard(shown, fresh, Date.now());
    if (!g.ok) { onChanged?.(); return { kind: "refused", message: g.message }; }
    const funds = await fundingCheck({ account: wallet.nearAddress, tokenId: quote.asset, payNowUnits: BigInt(quote.amount), returnTo: `/bet/${betId}` });
    if (funds.short) { setShort({ sentence: funds.short.sentence, path: funds.short.path }); return { kind: "stay", message: funds.short.sentence }; }
    setShort(null);
    const bondsBefore = bet.bonds.length;
    const sent = await relay(action, wallet, buildStakeTransfer({ tokenId: quote.asset, amount: quote.amount, msg: buildChallengeMsg(betId, bondsBefore + 1) }), "The challenge didn't go through. Nothing was sent and no money moved.");
    if (!sent.ok) return sent.out;
    const tm = confirmTiming();
    const out = await confirmChallenge({ betId, bondsBefore, deps, attempts: tm.attempts, delayMs: tm.delayMs });
    onChanged?.();
    return { ...out, txHash: sent.txHash };
  }
  return <ResolutionShell kind="challenge" title={sheet.title} draftId={betId} termsTestId="challenge-terms" confirmTestId="challenge-confirm" cancelTestId="challenge-cancel"
    resultTestId={(ph) => (ph === "success" ? "challenge-result" : "challenge-refusal")} confirmLabel={sheet.confirmLabel} disabled={!wallet}
    action="challenge" short={short} rows={sheet.rows} risk={sheet.risk} run={run} onClose={onClose} />;
}

// ---- Concede: C1 / D-CONCEDE1
export function ConcedeModal({ bet, betId, wallet, names, onClose, onChanged }: BaseProps) {
  const action = useRelayAction();
  // REVIEW1 (LIFE-11): the terms shown are the bet as it was when the modal opened; the bet is re-read and compared before signing.
  const [shown] = useState<Bet>(() => bet);
  const sheet = resolutionSheet.concede(shown, wallet?.nearAddress ?? null, names ?? {});
  async function run(): Promise<Run> {
    if (!wallet) return { kind: "refused", message: "Sign in first. Nothing was sent." };
    let fresh: Bet | null;
    try { fresh = await getBet(betId); } catch { return { kind: "refused", message: "We couldn't re-read the bet before conceding, so nothing was sent. Try again." }; }
    const g = concedeGuard(shown, fresh);
    if (!g.ok) { onChanged?.(); return { kind: "refused", message: g.message }; }
    const sent = await relay(action, wallet, { receiverId: ESCROW_CONTRACT_ID, methodName: "concede", args: buildConcedeArgs(betId) },
      "The concede didn't go through. Nothing was conceded and no money moved.");
    if (!sent.ok) return sent.out;
    // The relayer only says "sent"; the contract decides. Success needs get_bet to show the bet decided for the other side.
    const tm = confirmTiming();
    const out = await confirmConcede({ betId, me: wallet.nearAddress, deps, attempts: tm.attempts, delayMs: tm.delayMs });
    onChanged?.();
    return { ...out, txHash: sent.txHash };
  }
  return <ResolutionShell kind="concede" title={sheet.title} draftId={betId} termsTestId="concede-terms" confirmTestId="concede-confirm" cancelTestId="concede-cancel"
    resultTestId={() => "concede-result"} confirmLabel={sheet.confirmLabel} destructive disabled={!wallet} action="concede" rows={sheet.rows} risk={sheet.risk} run={run} onClose={onClose} />;
}

// ---- Referee ruling: FE12 / S14
export function RefereeRuleModal({ bet, betId, wallet, names, outcome, onClose, onChanged }: BaseProps & { outcome: RuleOutcome }) {
  const action = useRelayAction();
  const sheet = resolutionSheet.rule(bet, outcome, wallet?.nearAddress ?? null, names ?? {});
  async function run(): Promise<Run> {
    if (!wallet) return { kind: "refused", message: "Sign in first. Nothing was sent." };
    const sent = await relay(action, wallet, { receiverId: ESCROW_CONTRACT_ID, methodName: REFEREE_RULE_METHOD, args: refereeRuleArgs(betId, outcome) },
      "The ruling didn't go through. Nothing was sent and no money moved.");
    if (!sent.ok) return sent.out;
    const tm = confirmTiming();
    const out = await confirmRule({ betId, outcome, deps, attempts: tm.attempts, delayMs: tm.delayMs, name: (acct) => personLabel(person(acct, wallet.nearAddress, names ?? {})) });
    onChanged?.();
    return { ...out, txHash: sent.txHash };
  }
  return <ResolutionShell kind="referee" title={sheet.title} draftId={betId} termsTestId="referee-terms" confirmTestId="referee-confirm-btn" cancelTestId="referee-cancel-btn"
    resultTestId={() => "referee-result"} confirmLabel={sheet.confirmLabel} destructive disabled={!wallet} action="rule"
    terms={<p data-testid="referee-confirm-text" style={{ margin: "0 0 6px" }}>{sheet.sentence}</p>} rows={sheet.rows} risk={sheet.risk} run={run} onClose={onClose} />;
}
