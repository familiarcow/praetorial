// MODAL1c2: Take bet as a FlowModal over the bet page. The take logic is the BetPage's, moved here unchanged
// (race guard -> prepareTake -> funding check -> sign + relay -> confirmTake); it answers the modal with the result to show.
// M1 (UX-37 #5, UIR1 §3.6): ONE confirm step: REVIEW1's frozen-terms / changed-bet block, C1's ReviewCard (take variant: the same
// 5 lines as create, referee as @username; Full terms collapsed), a pay box (lib/takeBetFlow takePayRows), what you can lose, one button.
// SM2: paused / shutdown come from AppCtx and stale reads from useGate("take") (no props); one balance read (fundingCheck).
import React, { useRef, useState } from "react";
import { Banner, Button, CheckField } from "../ui";
import { KeyValue } from "../kit";
import ReviewCard from "./ReviewCard";
import { GateNotice, useAppState } from "../kit/Gate";
import { FlowModal, type FlowApi, type FlowResult } from "../modal/FlowModal";
import { getBet, type Bet } from "../../lib/escrowAdapter";
import { buildStakeTransfer } from "../../lib/stakeTransfer";
import { takeAvailability, raceGuard, confirmTake, takerReviewOffer } from "../../lib/takeView";
import { takeTipOffer, takeChoices, takeEligibility, prepareTake } from "../../lib/takeScreen";
import { TAKE_STEPS, TAKE_DRAFT_KEY, takeTerms, takeFlowResult, takePayRows, takeResultText } from "../../lib/takeBetFlow";
import type { Names } from "../../lib/betView";
import { useMoneyStale } from "../../lib/moneyContext";
import { DECLINED_MESSAGE } from "../../lib/openRefusal";
import { confirmTiming } from "../../lib/openConfirm";
import { viewFunction, viewTxLogs } from "../../lib/rpc";
import { INTENTS_CONTRACT_ID } from "../../lib/config";
import { useRelayAction } from "../../lib/useRelayAction";
import { afterBetChange } from "../../lib/indexerRefresh";
import { chainClock } from "../../lib/chainClock";
import { fundingCheck, type FundingShort } from "../../lib/fundingGate";
import { ShortNotice } from "./ShortNotice";
import { useGate } from "../kit/Gate";
import { clearDraft } from "../../lib/flowModal";
import { symbolForAssetId } from "../../lib/assets";
import { COPY as GS_COPY } from "../../lib/globalStates";
import type { StorageRates } from "../../lib/storageCharge";

export interface TakeWallet { nearAddress: string; signRawHash: (address: string, hashHex: string) => Promise<string> }

export default function TakeBetModal({ bet, betId, myAccountId, wallet, storageRates, inviteSig, names, onNeedMoney, onTaken, onClose }: {
  bet: Bet; betId: number; myAccountId: string | null; wallet: TakeWallet | null; storageRates?: StorageRates;
  inviteSig: string | null; names?: Names;
  onNeedMoney?: (path: string) => void; onTaken: () => void; onClose: () => void;
}) {
  const { paused, shutdown } = useAppState().ctx; // SM2 gap M1-3: from AppCtx, never props
  const stale = useMoneyStale(); // figures are hidden while the reads are stale (the gate below turns the button off)
  const takeAction = useRelayAction();
  // SM2: the cross-machine gate (lib/appState), minus the shortfall (shown by this modal's own ShortNotice).
  const takeGate = useGate("take");
  const [takeError, setTakeError] = useState<string | null>(null);
  const [short, setShort] = useState<FundingShort | null>(null);
  const kind = useRef<string>("failed");
  // REVIEW1 (#3, SM1 CRT-5): what the user reviews is frozen when the modal opens. Display, the pre-sign race guard and the take
  // message (referee_ack) all use this snapshot, never BetPage's 15 s poll, so a referee swapped after the review cannot slip through.
  const [reviewed] = useState<Bet>(() => bet);
  const betR: any = { ...reviewed, storage_rates: storageRates };
  // The reviewed referee's @username, kept once known: the page's names map follows the LIVE bet, so after a referee swap it no
  // longer holds the reviewed one (the review must not turn into "Unnamed account").
  const refName = useRef<string | undefined>(undefined);
  const reviewedRef = reviewed.envelope.referee?.account ?? null;
  if (reviewedRef && typeof names?.[reviewedRef] === "string") refName.current = names[reviewedRef] as string;
  // The poll moved on from what was reviewed: block the take and show what changed.
  const drift = raceGuard(betR, { ...bet, storage_rates: storageRates } as any);
  const changedNote = !drift.ok ? (
    <Banner status="error" data-testid="take-changed" role="alert">
      <p>This bet changed since you opened it, so it can't be taken as you reviewed it. Nothing was signed or sent.</p>
      <ul>{drift.details.map((d) => <li key={d}>{d}</li>)}</ul>
      <p>Close this and review the bet again.</p>
    </Banner>
  ) : null;

  async function doTake(values: Record<string, string>): Promise<FlowResult> {
    const tip = values.tip === "1";
    const asset = values.asset || null;
    const STAY: FlowResult = { kind: "stay" };
    if (!wallet) return STAY;
    setTakeError(null); setShort(null);
    // Race guard: re-read get_bet right before signing; stop if terms, stakes, deadlines or the referee changed since the REVIEWED snapshot.
    let now: Bet | null;
    try { now = await getBet(betId); } catch { setTakeError("We couldn't re-read the bet before taking it, so nothing was signed or sent. Try again."); return STAY; }
    // REVIEW1 (#10): "has this offer expired" by chain time (block header), not the device clock.
    const chainMs = (await chainClock.ensure(60_000)) ?? Date.now();
    const nowAvail = takeAvailability(now as any, { account: wallet.nearAddress, inviteSig, nowNs: BigInt(Math.floor(chainMs)) * 1_000_000n, paused, shutdown });
    if (nowAvail.kind !== "available") { setTakeError(`${nowAvail.message} Nothing was signed or sent.`); return STAY; }
    const race = raceGuard(betR, { ...now!, storage_rates: storageRates } as any);
    if (!race.ok) { setTakeError(`${race.message} ${race.details.join(". ")}.`); return STAY; }
    const prepared = await prepareTake({ betId, shown: betR, tip, inviteSig, takerAccount: myAccountId, asset: asset ?? undefined, readBet: async () => now as any });
    if (!prepared.ok) { setTakeError(prepared.message); return STAY; }
    // FE2b / S11: balance check on the exact deposit (stake + storage) in the asset being paid. The flow draft keeps tip + asset for the way back.
    // FUND1b: say it in the modal first (exact amount missing); the user chooses to go to Add money.
    // SM2 gap M1-2: ONE balance read gives the shortfall and the refund check's "before" (a failed read never blocks: 0n = "on its way back").
    const funds = await fundingCheck({ account: wallet.nearAddress, tokenId: prepared.tokenId, payNowUnits: BigInt(prepared.amount), returnTo: `/bet/${betId}` });
    if (funds.short && onNeedMoney) { setShort(funds.short); return STAY; }
    const readBalance = async () => BigInt(String(await viewFunction<string>(INTENTS_CONTRACT_ID, "mt_balance_of", { account_id: wallet.nearAddress, token_id: prepared.tokenId }) ?? "0"));
    const beforeBalance = funds.balanceUnits ?? 0n;
    let declined = false;
    // Same sign + relay path as Open/Challenge: intents mt_transfer_call (1 yocto) into the escrow (INTENTS1).
    const stake = buildStakeTransfer({ tokenId: prepared.tokenId, amount: prepared.amount, msg: prepared.msg });
    const r = await takeAction.run({
      senderId: wallet.nearAddress, publicKeyHexEd25519: wallet.nearAddress, receiverId: stake.receiverId, methodName: stake.methodName,
      args: stake.args, depositYocto: stake.depositYocto, gasTgas: stake.gasTgas,
      signRawHash: async (a, h) => { try { return await wallet.signRawHash(a, h); } catch (e) { declined = true; throw e; } },
    });
    if (declined) { kind.current = "declined"; return takeFlowResult({ kind: "declined", message: DECLINED_MESSAGE }, null); }
    // The relayer only says "sent"; the contract decides afterwards. Success needs get_bet to list this account as the taker.
    const t = confirmTiming();
    const txHash = r.ok ? r.txHash ?? null : null;
    const outcome = await confirmTake({
      betId, me: wallet.nearAddress, before: { balance: beforeBalance }, txHash,
      deps: { getBet: (id) => getBet(id) as any, balance: readBalance, txLogs: (h) => viewTxLogs(h, wallet.nearAddress), sleep: (ms) => new Promise((x) => setTimeout(x, ms)) },
      attempts: r.ok ? t.attempts : Math.min(t.attempts ?? 3, 3), delayMs: t.delayMs,
    });
    if (outcome.kind === "pending" && !r.ok) { kind.current = "failed"; return takeFlowResult({ kind: "failed", message: r.error?.startsWith("We couldn't set up your account") ? r.error : `The take didn't go through. Nothing was taken and no money moved.${r.error ? ` Details: ${r.error}` : ""}` }, null); }
    kind.current = outcome.kind;
    if (outcome.kind === "taken") { onTaken(); afterBetChange(betId); } // IDX2: fire-and-forget nudge; Explore drops the taken offer in seconds
    return takeFlowResult({ kind: outcome.kind, message: outcome.kind === "refused" ? outcome.sentence : outcome.message }, txHash);
  }

  // Cancel throws the draft away (otherwise the bet page would reopen the take from it on the next visit).
  const cancel = () => { try { clearDraft(window.sessionStorage, TAKE_DRAFT_KEY(betId)); } catch { /* storage off */ } onClose(); };
  const renderStep = (_step: { id: string }, api: FlowApi) => {
    const choices = takeChoices(betR);
    const picked = choices.find((c) => c.asset === api.values.asset)?.asset ?? reviewed.envelope.taker_asset;
    const tipOffer = takeTipOffer(betR, picked);
    const tip = api.values.tip === "1" && tipOffer.visible;
    const terms = takeTerms(betR, { tip, asset: picked });
    const blocked = choices.find((c) => c.asset === picked)?.blocked ?? null;
    const elig = takeEligibility({ takerAllow: reviewed.envelope.taker_allow, betId, taker: myAccountId, inviteSig });
    const tipBad = api.values.tip === "1" && !!tipOffer.problem;
    // The 5 lines are the REVIEWED snapshot from the taker's side (the picked asset's stake); the referee by @username (frozen too).
    const review = takerReviewOffer(betR, { tip, asset: picked, refereeUsername: refName.current });
    return (
      <div data-testid="take-terms" className="k-stack">
        {changedNote}
        {stale ? <p data-testid="money-stale-note">{GS_COPY.moneyStale}</p> : <ReviewCard offer={review.offer} storage={review.storage} />}
        {choices.length > 1 && !stale && (
          <label>
            Pay with
            <select data-testid="take-asset-select" value={picked} onChange={(e) => api.set("asset", e.currentTarget.value)}>
              {choices.map((c) => <option key={c.asset} value={c.asset}>{symbolForAssetId(c.asset) ?? c.asset}: {c.stake.toString()} units (+{(c.deposit - c.stake).toString()} storage)</option>)}
            </select>
          </label>
        )}
        {blocked && <div data-testid="take-blocked">{storageRates ? blocked : "Loading the storage charge from the contract…"}</div>}
        {!elig.ok && <div data-testid="take-ineligible">{elig.message}</div>}
        {tipOffer.visible && !stale && (
          <div>
            <CheckField data-testid="take-tip-checkbox" label="Tip the referee (taken from my stake)" checked={api.values.tip === "1"} onChange={(e) => api.set("tip", e.currentTarget.checked ? "1" : "")} />
            <span data-testid="take-tip-cost"> {terms.texts.fee}</span>
          </div>
        )}
        {tipBad && <div data-testid="take-tip-problem">{tipOffer.problem}</div>}
        {!stale && <KeyValue variant="total" data-testid="take-confirm-summary" rows={takePayRows(terms).map((r) => ({ id: r.id, label: r.label, value: r.value, emphasis: r.id === "pay-now" }))} />}
        {!stale && <p className="k-sheet__risk" data-testid="take-lose">{terms.loseText}</p>}
        {takeError && <Banner status="error" data-testid="take-error">{takeError}</Banner>}
        {short && onNeedMoney && <ShortNotice short={short} onAddMoney={() => onNeedMoney(short.path)} />}
        <GateNotice action="take" testId="take-modal-gate" />
        <div className="k-actions k-actions--stack k-sheet__footer" data-kit="ConfirmSheet-actions">
          <Button data-testid="take-confirm" variant="primary" disabled={!wallet || stale || !takeGate.allowed || api.busy || !elig.ok || !!blocked || tipBad || !drift.ok} onClick={() => api.submit()}>Take this bet</Button>
          <Button data-testid="take-cancel" variant="secondary" disabled={api.busy} onClick={cancel}>Cancel</Button>
        </div>
      </div>
    );
  };

  return (
    <FlowModal
      isOpen
      title="Take this bet"
      steps={TAKE_STEPS}
      draftKey={TAKE_DRAFT_KEY(betId)}
      ownNav
      submitLabel="Take this bet"
      onClose={onClose}
      onSubmit={doTake}
      renderStep={renderStep}
      renderResult={(r) => (
        <div>
          <span data-testid="take-result" data-kind={r.phase === "success" ? "taken" : r.phase === "pending" ? "pending" : kind.current}>
            {takeResultText(r.phase, r.reason)}
          </span>
        </div>
      )}
    />
  );
}
