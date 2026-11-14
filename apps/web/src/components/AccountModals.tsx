// MODAL1c5: "Move to betting balance" and "Withdraw to wallet" as modals over the Add money screen. The relay logic is AddMoney's, moved here unchanged
// (runMove / runWithdraw, same methods, args, deposits and REFGAS1 gas via useRelayAction); each flow reads out the amount, asset and where it goes
// (and that there is no fee) before the confirm, and success is still only ever the chain-checked outcome.
import React from "react";
import { Button, TextField } from "../ui";
import { FlowModal, type FlowApi, type FlowResult } from "../modal/FlowModal";
import { ResolutionShell, type Run, type ResolutionOutcome } from "./ResolutionModals";
import { runMove, type Holding } from "../../lib/moveToBetting";
import { runWithdraw } from "../../lib/withdraw";
import { viewFunction, viewTxFailure } from "../../lib/rpc";
import { useRelayAction } from "../../lib/useRelayAction";
import { runDirectTx } from "../../lib/directTx";
import { appSignRawHash } from "../../lib/appSigner";
import { formatMoney } from "../../lib/intentsBalance";
import { fromBaseUnits } from "../../lib/decimal";
import { findAsset } from "../../lib/assets";
import { clearDraft, type FlowStep } from "../../lib/flowModal";
import { MOVE_STEPS, MOVE_DRAFT_KEY, WITHDRAW_STEPS, WITHDRAW_DRAFT_KEY, moveTerms, withdrawTerms, parseWithdrawAmount, accountFlowPhase } from "../../lib/accountFlows";

const sleep = (ms: number) => new Promise<void>((x) => setTimeout(x, ms));
const lines = (ls: string[]) => <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.5, overflowWrap: "anywhere" }}>{ls.map((l) => <li key={l}>{l}</li>)}</ul>;

function useRunner(account: string) {
  const action = useRelayAction();
  return (step: { receiverId: string; methodName: string; args: Record<string, unknown>; gasTgas: number; depositYocto: string }) => action.run({
    senderId: account, publicKeyHexEd25519: account, receiverId: step.receiverId, methodName: step.methodName,
    args: step.args, gasTgas: step.gasTgas, depositYocto: step.depositYocto, signRawHash: appSignRawHash,
  });
}
/** SEC1/MON-2: an earlier, unresolved send of exactly this step (null = none). */
function useInflight(account: string) {
  const action = useRelayAction();
  return (step: { receiverId: string; methodName: string; args: Record<string, unknown>; depositYocto: string }) =>
    action.check({ senderId: account, receiverId: step.receiverId, methodName: step.methodName, args: step.args, depositYocto: step.depositYocto });
}
const CHECKING = "Checking whether it went through. Don't send it again yet; check back in a minute.";

type Step = { receiverId: string; methodName: string; args: Record<string, unknown>; gasTgas: number; depositYocto: string };
function useDirect(account: string) {
  return (step: Step) => runDirectTx({
    senderId: account, publicKeyHexEd25519: account, receiverId: step.receiverId, methodName: step.methodName, args: step.args, gasTgas: step.gasTgas,
    depositYocto: step.depositYocto, signRawHash: appSignRawHash,
  });
}

export function MoveModal({ holding, account, onChanged, onClose }: { holding: Holding; account: string; onChanged: () => void; onClose: (last: ResolutionOutcome | null) => void }) {
  const relay = useRunner(account);
  // RELAYDEP1 / D-RELAYDEP1: the wrap carries the user's own NEAR, so the user signs and pays that transaction directly.
  const direct = useDirect(account);
  const t = moveTerms(holding);
  async function run(): Promise<Run> {
    // LIVE1: runMove wraps native NEAR, then moves the wNEAR balance READ after the deposit (wrap takes a storage fee),
    // and only reports success once every relayed transaction's final outcome is clean.
    const r = await runMove(holding, account, { relay, direct, view: (c, m, a) => viewFunction<string>(c, m, a), txFailure: (hash) => viewTxFailure(hash, account), sleep });
    onChanged();
    const txHash = r.txHashes[r.txHashes.length - 1] ?? null;
    if (r.ok) return { kind: "moved", message: "Moved to your betting balance.", txHash };
    // SM2 F5-2: an unknown outcome is "checking" (pending), never "failed", exactly like Withdraw below.
    if (r.pending) return { kind: "checking", message: CHECKING, detail: r.detail, txHash };
    return { kind: "failed", message: "We couldn't move your money. Nothing was lost; try again in a moment.", detail: r.detail, txHash };
  }
  return (
    <ResolutionShell kind="move" title="Move to betting balance" draftId={0} steps={MOVE_STEPS} draftKey={MOVE_DRAFT_KEY(holding.symbol, holding.source)} phaseOf={accountFlowPhase}
      termsTestId="move-terms" confirmTestId="move-confirm" cancelTestId="move-cancel" resultTestId={() => "move-result"} detailTestId="move-error-detail"
      confirmLabel={t.confirmLabel} terms={lines(t.lines)} run={run} onClose={onClose} />
  );
}

export function WithdrawModal({ symbol, balanceUnits, account, onChanged, onClose }: {
  symbol: string; balanceUnits: string; account: string; onChanged: () => void; onClose: (last: ResolutionOutcome | null) => void;
}) {
  const relay = useRunner(account);
  // SEC1/MON-1: the wallet's one-time token registration (storage_deposit) carries the user's NEAR, so the user signs and pays it.
  const direct = useDirect(account);
  const inflight = useInflight(account);
  const last = React.useRef<Run | null>(null);
  const asset = findAsset(symbol)!;
  const draftKey = WITHDRAW_DRAFT_KEY(symbol);
  const steps: FlowStep[] = [
    { ...WITHDRAW_STEPS[0], validate: (v) => { const r = parseWithdrawAmount(symbol, v.amount ?? "", balanceUnits); return r.ok ? null : r.message; } },
    WITHDRAW_STEPS[1],
  ];
  const cancel = () => { try { clearDraft(window.sessionStorage, draftKey); } catch { /* storage off */ } onClose(null); };

  const onSubmit = async (values: Record<string, string>): Promise<FlowResult> => {
    const a = parseWithdrawAmount(symbol, values.amount ?? "", balanceUnits);
    if (!a.ok) return { kind: "failure", reason: a.message };
    const r = await runWithdraw({ symbol, amountUnits: a.units }, account, {
      relay, direct, inflight, view: (c, m, args) => viewFunction<unknown>(c, m, args), txFailure: (hash) => viewTxFailure(hash, account), sleep,
    });
    onChanged();
    const txHash = r.txHashes[r.txHashes.length - 1] ?? null;
    if (!r.ok && r.pending) {
      // SEC1/MON-2: outcome unknown is never "failed": the next Withdraw checks this one before signing anything new.
      last.current = { kind: "checking", message: CHECKING, detail: r.detail, txHash };
      return { kind: "pending", txHash, message: CHECKING };
    }
    if (r.ok) {
      const message = r.resumed
        ? `Your earlier withdrawal went through: ${formatMoney(symbol, r.receivedUnits)} is in your wallet${symbol === "NEAR" ? " (as wrapped NEAR)" : ""}.`
        : `${formatMoney(symbol, r.receivedUnits)} is in your wallet${symbol === "NEAR" ? " (as wrapped NEAR)" : ""}.`;
      last.current = { kind: "withdrawn", message, txHash };
      return { kind: "success", txHash, message };
    }
    last.current = { kind: "failed", message: "We couldn't withdraw your money. Anything not sent stays in your betting balance.", detail: r.detail, txHash };
    return { kind: "failure", reason: last.current.message };
  };

  const renderStep = (_s: FlowStep, api: FlowApi) => {
    if (api.index === 0) {
      return (
        <div>
          <p style={{ margin: "0 0 8px" }}>Your betting balance: <strong>{formatMoney(symbol, balanceUnits)}</strong>. Choose how much to send to your wallet.</p>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <TextField data-testid={`withdraw-amount-${symbol}`} label={`Amount of ${symbol} to withdraw`} hideLabel inputMode="decimal" placeholder="0" value={api.values.amount ?? ""}
                onChange={(e) => api.set("amount", e.currentTarget.value)} />
            </div>
            <Button data-testid={`withdraw-max-${symbol}`} variant="secondary" onClick={() => api.set("amount", fromBaseUnits(balanceUnits, asset.decimals))}>Max</Button>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <Button data-testid="withdraw-cancel" variant="secondary" onClick={cancel}>Cancel</Button>
            <Button data-testid="withdraw-review" variant="primary" onClick={() => api.next()}>Review</Button>
          </div>
        </div>
      );
    }
    const a = parseWithdrawAmount(symbol, api.values.amount ?? "", balanceUnits);
    const t = withdrawTerms(symbol, a.ok ? a.units : "0", account);
    return (
      <div>
        <div data-testid="withdraw-terms">{lines(t.lines)}</div>
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <Button data-testid="withdraw-cancel" variant="secondary" disabled={api.busy} onClick={cancel}>Cancel</Button>
          <Button data-testid="withdraw-back" variant="secondary" disabled={api.busy} onClick={() => api.goTo(0)}>Change amount</Button>
          <Button data-testid="withdraw-confirm" variant="primary" disabled={api.busy || !a.ok} onClick={() => api.submit()}>{t.confirmLabel}</Button>
        </div>
      </div>
    );
  };

  return (
    <FlowModal isOpen title="Withdraw to wallet" steps={steps} draftKey={draftKey} ownNav submitLabel="Withdraw" renderStep={renderStep} onSubmit={onSubmit}
      onClose={() => onClose(last.current && last.current.kind === "withdrawn" ? { kind: last.current.kind, message: last.current.message } : null)}
      renderResult={(r) => (
        <div>
          <span data-testid="withdraw-result" data-kind={last.current?.kind ?? r.phase}>{r.phase === "failure" ? r.reason : last.current?.message ?? ""}</span>
          {r.phase === "failure" && last.current?.detail ? <small data-testid="withdraw-error-detail"> Details: {last.current.detail}</small> : null}
        </div>
      )} />
  );
}
