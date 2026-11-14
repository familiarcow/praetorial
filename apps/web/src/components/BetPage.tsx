// B1 (UIR1 §3.5, familiarcow UX-37 #1 #4 #9, 2026-11-11 Details + usernames): the bet page.
//   header card   question in plain words, pill + relative time, @usernames vs @usernames with stakes, who decides, one sentence
//   action card   the ONE thing this viewer can do now (take / rule / challenge / finalize / ask for the result / apply the ruling /
//                 retry the payout / refund everyone / share), or nothing
//   ruling + payout cards (when there is one)
//   More actions  collapsed: concede, cancel, change who decides, duplicate, new bet, add evidence
//   Activity      collapsed: the bet's full history (familiarcow #9: keep it all, collapsed); a toast when it changes while you look
//   Details       collapsed: everything that decides the bet (src/kit/details.tsx); raw ids only in its Account details row
//   Verify (V1)   every Activity row's on-chain proof, the AI judge's Verify sheet (ruling card, Details › AI judge) and Download
//                 verification file: src/components/BetVerify.tsx (read-only; raw ids allowed there, @username first)
// Wording and state come from lib/betView.ts (LIFE1 phaseOf); every button keeps its contract-mirror gate from before (takeAvailability,
// challengeOffer, finalizeOffer, canConcede, refereeScreen, payoutScreen, emergency refund, RequestResultSection, ApplyRuling,
// RefereeChange), so this file changes the layout, never when a money action is allowed. All relays and read-backs are unchanged.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, TextField } from "../ui";
import {
  getBet, Bet, buildSubmitExhibitsArgs, buildEmergencyRefundArgs, requiredChallengeBond, ChallengeBondQuote,
} from "../../lib/escrowAdapter";
import { rulingCard, challengeOffer, finalizeOffer } from "../../lib/ruling";
import { fetchStorageRates, type StorageRates } from "../../lib/storageCharge";
import { takeAvailability } from "../../lib/takeView";
import { confirmTiming } from "../../lib/openConfirm";
import { viewFunction } from "../../lib/rpc";
import { parseInviteLink } from "../../lib/takeScreen";
import { ESCROW_CONTRACT_ID } from "../../lib/config";
import { useRelayAction } from "../../lib/useRelayAction";
import { chainClock } from "../../lib/chainClock";
import { useMoneyStale } from "../../lib/moneyContext";
import { COPY as GS_COPY } from "../../lib/globalStates";
import { COPY } from "../../lib/globalStates";
import RequestResultSection from "./RequestResultSection";
import CancelOffer from "./CancelOffer";
import ApplyRuling from "./ApplyRuling";
import TakeBetModal from "./TakeBetModal";
import { useGate, GateNotice, useAppState, useLoginFirst } from "../kit/Gate";
import { ChallengeModal, ConcedeModal, RefereeRuleModal } from "./ResolutionModals";
import { TAKE_DRAFT_KEY } from "../../lib/takeBetFlow";
import { loadDraft } from "../../lib/flowModal";
import { lifecycleNotice } from "../../lib/betLifecycle";
import { refereeChangeFrozen, FROZEN_MESSAGE, pendingRefereeProposal } from "../../lib/liveBet";
import RefereeChange from "./RefereeChange";
import { useBetVerify } from "./BetVerify";
import { refereeScreen, type RuleOutcome } from "../../lib/refereeScreen";
import { payoutScreen, drainPayoutsArgs, DRAIN_METHOD, confirmDrain, type PayoutLine } from "../../lib/payoutScreen";
import { inviteSecretForBet, signInvite, buildInviteUrl } from "../../lib/inviteLink";
import { betView, changeToast, person, personLabel, type ActionId, type BetView } from "../../lib/betView";
import { betDetail } from "../../lib/betDetail";
import { money } from "../../lib/money";
import { releasePins, releaseFeeAccount } from "../../lib/releaseConfig";
import { useAppRegistry, useBetNames, accountsOnBet, nameAccountsIn, hideAmounts } from "../../lib/betNames";
import { e2eRenderCrash } from "../../lib/testHooks";
import {
  Amounts, DeciderChip, Disclosure, EmptyState, Notice, Sides, StatusPill, TimeLeft, ActivityList, DetailsCard, useToast,
} from "../kit";

// Statuses emergency_refund refuses outright as already terminal (contracts/escrow/src/lib.rs emergency_refund: Settled/Voided/
// Cancelled/Expired have nothing left owed). Finalized is excluded too: its payout is already fully scheduled.
const EMERGENCY_REFUND_INELIGIBLE_STATUSES = new Set(["Finalized", "Settled", "Voided", "Cancelled", "Expired"]);

export interface BetPageWallet {
  nearAddress: string; // implicit account id == the hex ed25519 pubkey itself
  signRawHash: (address: string, hashHex: string) => Promise<string>;
}
interface Props {
  /** FE15 (S17): copy this bet's terms into a new bet form. Returns a plain error sentence, or null when it navigated to the form. */
  onDuplicate?: (bet: Bet) => string | null;
  betId: number;
  myAccountId: string | null;
  wallet: BetPageWallet | null;
  /** FE2b: called with the /add-money path when the take deposit exceeds the Intents balance. */
  onNeedMoney?: (path: string) => void;
}

/** The release pins the Details card names (resolver wasm hash, judge models); null if this build has none. */
function release(): { resolverWasmHash: string; models: string[] } | null {
  try { const p = releasePins(); return { resolverWasmHash: p.resolver_wasm_hash, models: p.models }; } catch { return null; }
}

const chainNowMs = (): number => chainClock.nowMs() ?? Date.now();
const NO_ACTIVITY: never[] = [];

// The toast (live changes, "Link copied") comes from the app-wide ToastProvider (main.tsx; SM2 B1-3).
export default function BetPage({ betId, myAccountId, wallet, onNeedMoney, onDuplicate }: Props) {
  const [bet, setBet] = useState<Bet | null | "loading" | "error">("loading");
  const [challengeResult, setChallengeResult] = useState<{ kind: string; message: string } | null>(null);
  const [finalizeResult, setFinalizeResult] = useState<string | null>(null);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [bondQuote, setBondQuote] = useState<ChallengeBondQuote | null | "loading">("loading");
  const [exhibitHashInput, setExhibitHashInput] = useState("");
  // SM2 B1-5: chain time (block header + monotonic clock), the device clock only until the first block is read.
  const [nowMs, setNowMs] = useState(() => chainNowMs());
  const finalizeAction = useRelayAction();
  const exhibitAction = useRelayAction();
  const refundAction = useRelayAction();
  const drainAction = useRelayAction();
  const [pendingLines, setPendingLines] = useState<PayoutLine[] | null>(null);
  const [drainResult, setDrainResult] = useState<string | null>(null);
  // MODAL1c3: request-result lives in RequestResultSection; challenge / concede / referee ruling open as modals over this page.
  const [resModal, setResModal] = useState<null | { kind: "challenge"; quote: ChallengeBondQuote } | { kind: "concede" } | { kind: "referee"; outcome: RuleOutcome }>(null);
  const [ruleResult, setRuleResult] = useState<{ kind: string; message: string } | null>(null);
  const [cancelResult, setCancelResult] = useState<{ kind: string; message: string } | null>(null);
  const [concedeResult, setConcedeResult] = useState<{ kind: string; message: string } | null>(null);
  const [storageRates, setStorageRates] = useState<StorageRates | undefined>(undefined);
  // MODAL1c2: the take flow is a modal over this page; a saved draft (a detour to /add-money and back) reopens it where it was.
  const [takeOpen, setTakeOpen] = useState(() => typeof window !== "undefined" && loadDraft(window.sessionStorage, TAKE_DRAFT_KEY(betId)) !== null);
  const [inviteeInput, setInviteeInput] = useState("");
  const [inviteLinkOut, setInviteLinkOut] = useState<string | null>(null);
  const [inviteErr, setInviteErr] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const { paused, shutdown } = useAppState().ctx; // SM2: the contract flags come from AppCtx, never read here
  const stale = useMoneyStale();
  const toast = useToast();
  // SM2: the cross-machine gates (lib/appState). Bet-phase eligibility still comes from the lib view modules below.
  // GUEST1: a guest presses any action -> "Log in to bet" on this same URL (never a modal, a signer or a relayer call).
  const loginFirst = useLoginFirst();
  const takeGate = useGate("take"), ruleGate = useGate("rule"), challengeGate = useGate("challenge"), evidenceGate = useGate("add-evidence");
  const registry = useAppRegistry();
  const names = useBetNames(bet && bet !== "loading" && bet !== "error" ? bet : null, registry);

  // Poll get_bet so the page (and the change toast) follow the live state. No push backend.
  useEffect(() => {
    let cancelled = false;
    setBet("loading");
    async function poll() {
      try {
        const b = await getBet(betId);
        if (!cancelled) setBet(b);
      } catch {
        // FE16b: keep the last good bet on screen (money hidden by the stale flag) instead of dropping to an error.
        if (!cancelled) setBet((p) => (p && p !== "loading" && p !== "error" ? p : "error"));
      }
    }
    poll();
    const interval = setInterval(poll, 15_000);
    // Gates (request-result delay, challenge window, finalize) move with time; relative times re-render on their own (kit TimeLeft).
    const clock = setInterval(() => setNowMs(chainNowMs()), 1000);
    return () => { cancelled = true; clearInterval(interval); clearInterval(clock); };
  }, [betId]);

  // STG1b: the contract's per-asset storage rates (immutable) size each take deposit; read once per bet.
  useEffect(() => {
    if (!bet || bet === "loading" || bet === "error") return;
    const assets = [bet.envelope.taker_asset, ...(bet.envelope.taker_options ?? []).map((o) => o.asset)];
    if (assets.every((a) => storageRates?.[a] != null)) return;
    fetchStorageRates(assets).then(setStorageRates).catch(() => setStorageRates(undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bet === "loading" || bet === "error" || !bet ? null : bet.envelope.taker_asset]);

  const loadedStatus = bet && bet !== "loading" && bet !== "error" ? bet.status : null;
  const loadedBonds = bet && bet !== "loading" && bet !== "error" ? bet.bonds.length : -1;
  useEffect(() => {
    if (!bet || bet === "loading" || bet === "error" || !myAccountId) { setBondQuote(null); return; }
    let cancelled = false;
    setBondQuote("loading");
    requiredChallengeBond(betId, myAccountId).then((q) => !cancelled && setBondQuote(q)).catch(() => !cancelled && setBondQuote(null));
    return () => { cancelled = true; };
    // LFIX1 (SM1 LIFE-8): the quote depends on the round (bonds) and the party only, not on every 15 s poll's new bet object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [betId, myAccountId, loadedStatus, loadedBonds]);

  // FE13 (S15): once a bet has an ending, read its unpaid payout lines from the contract (pending_payouts drops finished lines).
  const endedKey = bet && bet !== "loading" && bet !== "error" && payoutScreen(bet, null, []) ? `${bet.status}:${bet.outcome}` : null;
  useEffect(() => {
    if (!endedKey) { setPendingLines(null); return; }
    let cancelled = false;
    const read = () => viewFunction<PayoutLine[]>(ESCROW_CONTRACT_ID, "pending_payouts", { bet_id: betId });
    read().then((l) => !cancelled && setPendingLines(l ?? [])).catch(() => !cancelled && setPendingLines(null));
    const iv = setInterval(() => { read().then((l) => !cancelled && setPendingLines(l ?? [])).catch(() => {}); }, 15_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [betId, endedKey]);

  const loaded = bet && bet !== "loading" && bet !== "error" ? bet : null;
  const view: BetView | null = useMemo(() => (loaded ? betView(loaded, myAccountId, nowMs, {
    names, pending: pendingLines, shutdown, contractId: ESCROW_CONTRACT_ID,
    bond: bondQuote === "loading" ? undefined : bondQuote ? money(bondQuote.amount, bondQuote.asset) : null,
  }) : null), [loaded, myAccountId, nowMs, names, pendingLines, shutdown, bondQuote]);
  const detail = useMemo(() => (loaded ? betDetail(loaded, { names, release: release(), contractId: ESCROW_CONTRACT_ID }) : null), [loaded, names]);

  // V1: every Activity row gets its on-chain proof; the judge's Verify sheet; Download verification file.
  const verify = useBetVerify({ bet: loaded, betId, detail, activity: view?.activity ?? NO_ACTIVITY, names, me: myAccountId });

  // familiarcow UX-37 #9: a toast when the bet changes while you look (replaces the Notifications panel; the full history is in Activity).
  const prevView = useRef<BetView | null>(null);
  useEffect(() => {
    if (!view) return;
    const t = changeToast(prevView.current, view);
    if (t) toast({ tone: "info", text: t });
    prevView.current = view;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.id, view?.pill.label, view?.activity.length]);

  if (bet === "loading") return <p data-testid="bet-status" className="k-muted">{COPY.loading}</p>;
  if (bet === "error") return <Notice tone="bad" title={<span data-testid="bet-status">{COPY.betLoadFailed}</span>} />;
  if (bet === null || !view || !detail) {
    return <EmptyState data-testid="bet-not-found" title={<span data-testid="bet-status">{`We can't find bet #${betId}`}</span>} body="Check the link you were sent." action={<a href="/">Home</a>} />;
  }

  const name = (account: string) => personLabel(person(account, myAccountId, names));
  // FE16b: while the page is out of date no money figure is shown, sentences included ("You put in — to win —.").
  const sentence = stale ? hideAmounts(view.sentence) : view.sentence;
  // payoutScreen's lines name receivers by account id; on screen they are people (@username / You) and "the Praetorial fee account".
  const feeAccts = new Set([releaseFeeAccount(), ...(pendingLines ?? []).filter((l) => l.reason.startsWith("fee")).map((l) => l.receiver)].filter((a): a is string => !!a));
  // everyone the payout lines can name: the bet's people plus any other receiver (named as a person, never as a raw id)
  const people = [...new Set([...accountsOnBet(bet), ...(pendingLines ?? []).map((l) => l.receiver).filter((a) => !feeAccts.has(a))])];
  const nameMid = (a: string) => (a === myAccountId ? "you" : people.includes(a) ? name(a) : "the Praetorial fee account");
  const named = (line: string) => {
    const out = nameAccountsIn(line, [...people, ...feeAccts], nameMid);
    return out.charAt(0).toUpperCase() + out.slice(1);
  };
  const isMaker = !!myAccountId && bet.envelope.maker === myAccountId;
  const isTaker = !!myAccountId && bet.taker === myAccountId;
  const isParty = isMaker || isTaker;
  // TFIX2: test builds only (lib/testHooks; compiled out of mainnet): a forced render error for the crash-screen specs.
  const forcedCrash = e2eRenderCrash();
  if (forcedCrash === "bet-page" || (forcedCrash === "taken-by-me" && isTaker)) throw new Error(`e2e render crash (${forcedCrash})`);
  // SM2 B1-2/4/8: what this person may do comes from betView (phase + primary/secondary), never from bet.status here.
  const can = (id: ActionId) => view.primary?.id === id || view.secondary.some((a) => a.id === id);
  const isOpen = view.phase === "open" || view.phase === "open-lapsed";
  const card = rulingCard(bet, myAccountId, nowMs);
  const bondLoading = bondQuote === "loading";
  const offer = challengeOffer(bet, myAccountId, bondLoading ? { amount: "0", asset: "" } : bondQuote, nowMs);
  const fin = finalizeOffer(bet, nowMs);
  const isReferee = !!myAccountId && bet.envelope.referee?.account === myAccountId;
  // submit_exhibits: bettors, in the challenge window of round 1 (betView "add-evidence").
  const canSubmitExhibits = can("add-evidence");
  // emergency_refund has no caller check: anyone can return the deposits once the contract is shut down.
  const showConcede = can("concede"); // betView: never offered to the side the ruling favours
  const canEmergencyRefund = shutdown && !EMERGENCY_REFUND_INELIGIBLE_STATUSES.has(bet.status);
  const rs = refereeScreen(bet, myAccountId, nowMs);
  const ps = payoutScreen(bet, myAccountId, pendingLines);
  const notice = lifecycleNotice(ESCROW_CONTRACT_ID, betId, bet, nowMs);
  const pend = pendingRefereeProposal(bet);
  const inviteSecret = isOpen && isMaker && typeof window !== "undefined" ? inviteSecretForBet(window.localStorage, bet.envelope.taker_allow) : null;
  const inviteSig = parseInviteLink(typeof window !== "undefined" ? window.location.href : "");
  const avail = !isParty ? takeAvailability({ ...bet, storage_rates: storageRates } as any, { account: myAccountId, inviteSig, nowNs: BigInt(Math.floor(nowMs)) * 1_000_000n, paused, shutdown }) : null;
  // The take block is for someone who could take it: an open offer (or one that just closed / is paused / is not for them).
  // ...or one that a shared link still points at after it was taken / cancelled / expired (say why it can't be taken).
  const offerEnded = ["Taken", "Cancelled", "Expired"].includes(bet.status);
  const showTake = !!avail && !isReferee && (avail.kind === "available" || ((isOpen || offerEnded) && avail.kind !== "own" && avail.kind !== "referee-you"));
  const takeMessage = avail?.kind === "not-you" && typeof bet.envelope.taker_allow === "object" && "Account" in bet.envelope.taker_allow
    ? `This bet is only for ${name((bet.envelope.taker_allow as { Account: string }).Account)}. Sign in as them to take it.` : avail && "message" in avail ? avail.message : null;
  const endedRole = ps && (isParty || isReferee);

  const refreshBet = () => { getBet(betId).then(setBet).catch(() => {}); };

  // finalize(bet_id): permissionless once the window has closed (the keeper does it too). Success needs get_bet to show the bet settled.
  async function doFinalize() {
    if (!wallet) return;
    setFinalizeResult(null);
    const r = await finalizeAction.run({
      senderId: wallet.nearAddress, publicKeyHexEd25519: wallet.nearAddress, receiverId: ESCROW_CONTRACT_ID,
      methodName: "finalize", args: { bet_id: betId }, signRawHash: wallet.signRawHash,
    });
    if (!r.ok) { setFinalizeResult("Finalizing didn't go through. Nothing changed. Try again in a moment."); return; }
    const t = confirmTiming();
    for (let i = 0; i < (t.attempts ?? 8); i++) {
      const b = await getBet(betId).catch(() => null);
      if (b && ["Finalized", "Settled", "Voided"].includes(b.status)) { setBet(b); return; }
      await new Promise((x) => setTimeout(x, t.delayMs ?? 2000));
    }
    setFinalizeResult("We sent it but can't see the bet as settled yet. Check again in a moment.");
  }

  async function doEmergencyRefund() {
    if (!wallet) return;
    await refundAction.run({
      senderId: wallet.nearAddress, publicKeyHexEd25519: wallet.nearAddress, receiverId: ESCROW_CONTRACT_ID,
      methodName: "emergency_refund", args: buildEmergencyRefundArgs(betId), signRawHash: wallet.signRawHash,
    });
  }

  // FE13: re-send unsent payout lines. drain_payouts is permissionless and relayer-allowlisted; the contract decides whether it worked.
  async function doRetryPayout() {
    if (!wallet) return;
    setDrainResult(null);
    const r = await drainAction.run({
      senderId: wallet.nearAddress, publicKeyHexEd25519: wallet.nearAddress, receiverId: ESCROW_CONTRACT_ID,
      methodName: DRAIN_METHOD, args: drainPayoutsArgs(betId), signRawHash: wallet.signRawHash,
    });
    if (!r.ok) return;
    const t = confirmTiming();
    const out = await confirmDrain({
      betId,
      deps: { getBet: (id) => getBet(id), pending: (id) => viewFunction<PayoutLine[]>(ESCROW_CONTRACT_ID, "pending_payouts", { bet_id: id }), sleep: (ms) => new Promise((x) => setTimeout(x, ms)) },
      attempts: t.attempts, delayMs: t.delayMs,
    });
    setDrainResult(out.kind === "paid" ? null : out.message);
    if (out.bet) setBet(out.bet);
    if (out.pending) setPendingLines(out.pending);
  }

  async function doSubmitExhibits() {
    if (!wallet) return;
    const hashes = exhibitHashInput.split(",").map((h) => h.trim()).filter(Boolean);
    if (hashes.length === 0) return;
    await exhibitAction.run({
      senderId: wallet.nearAddress, publicKeyHexEd25519: wallet.nearAddress, receiverId: ESCROW_CONTRACT_ID,
      methodName: "submit_exhibits", args: buildSubmitExhibitsArgs(betId, hashes), signRawHash: wallet.signRawHash,
    });
    setExhibitHashInput("");
  }

  async function copyLink() {
    const url = `${window.location.origin}/bet/${betId}`;
    try { await navigator.clipboard.writeText(url); toast({ tone: "success", text: "Link copied." }); }
    catch { toast({ tone: "error", text: `Copy this link: ${url}` }); }
  }
  const busy = (a: { status: string }) => a.status === "signing" || a.status === "relaying";

  // ---------------------------------------------------------------- the one action (gates unchanged from before B1)
  const actions: React.ReactNode[] = [];
  if (canEmergencyRefund) actions.push(
    <div key="refund" data-testid="emergency-refund-section" className="k-stack">
      <p className="k-action__text">{COPY.refundButton}</p>
      <p data-testid="emergency-refund-explainer" className="k-action__hint">
        The app was shut down for good. Anyone can return this bet's deposits: each stake, bond and deposit goes back to whoever put it in, nothing more.
      </p>
      <Button data-testid="emergency-refund-btn" variant="primary" onClick={loginFirst ?? doEmergencyRefund} disabled={!loginFirst && (!wallet || stale || busy(refundAction))}>{COPY.refundButton}</Button>
      {refundAction.status !== "idle" && (
        <p data-testid="emergency-refund-status" data-state={refundAction.status} className="k-small k-muted">
          {busy(refundAction) ? "Sending…" : refundAction.status === "error" ? "It didn't go through." : ""}
        </p>
      )}
      {refundAction.error && <p data-testid="emergency-refund-error" role="alert">{refundAction.error}</p>}
      {refundAction.txHash && <p data-testid="emergency-refund-tx" data-tx={refundAction.txHash} className="k-small">Sent. The deposits are on their way back.</p>}
    </div>,
  );
  if (rs.kind === "referee") actions.push(
    <div key="referee" data-testid="referee-section" className="k-stack">
      <p data-testid="referee-banner" className="k-action__text">You're the referee for this bet</p>
      {rs.buttons.length > 0 && !ruleResult && <p className="k-small">{sentence}</p>}
      <p data-testid="referee-deadline" className="k-action__hint">{rs.deadlineLine}</p>
      {rs.tipLine && <p data-testid="referee-tip" className="k-action__hint">{rs.tipLine}</p>}
      {rs.message && <p data-testid="referee-state" data-state={rs.state}>{rs.message}</p>}
      {rs.buttons.length > 0 && !ruleResult && (
        <div className="k-actions k-actions--stack k-actions--sticky">
          <GateNotice action="rule" only={["no-username", "username-unknown", "checking-username"]} />
          {rs.buttons.map((b) => (
            <Button key={b.outcome} data-testid={`referee-btn-${b.outcome}`} variant={b.outcome === "VOID" ? "secondary" : "primary"} disabled={!loginFirst && (!wallet || stale || !ruleGate.allowed)}
              onClick={loginFirst ?? (() => setResModal({ kind: "referee", outcome: b.outcome }))}>{b.label}</Button>
          ))}
        </div>
      )}
    </div>,
  );
  if (ruleResult) actions.push(<p key="rule-result" data-testid="referee-result" data-kind={ruleResult.kind}>{ruleResult.message}</p>);
  if (showTake && avail) actions.push(
    <div key="take" data-testid="take-section" className="k-stack">
      {avail.kind !== "available" && <p data-testid="take-state" data-kind={avail.kind}>{takeMessage}</p>}
      {avail.kind === "available" && (
        <div data-testid="take-review" className="k-stack">
          <p className="k-action__text">{sentence}</p>
          {view.next && <p className="k-action__hint"><TimeLeft at={view.next.at} label={view.next.label} past={view.next.past} /></p>}
          {!myAccountId && <p data-testid="take-login" className="k-action__hint">Log in to take this bet. You'll come back to this page.</p>}
          {stale && <p data-testid="money-stale-note">{GS_COPY.moneyStale}</p>}
          <div className="k-actions k-actions--stack k-actions--sticky">
            <GateNotice action="take" only={["no-username", "username-unknown", "checking-username"]} />
            <Button data-testid="take-open" variant="primary" onClick={loginFirst ?? (() => setTakeOpen(true))} disabled={!loginFirst && (!wallet || stale || !takeGate.allowed)}>Take this bet</Button>
          </div>
        </div>
      )}
    </div>,
  );
  if (offer.kind === "available") actions.push(
    <div key="challenge" data-testid="challenge-section" className="k-stack">
      <p className="k-action__text">{sentence}</p>
      <p className="k-action__hint"><span data-testid="challenge-bond-line">{offer.bondLine}</span>{view.next && <> · <TimeLeft at={view.next.at} label="Final" past="Final" /></>}</p>
      <p data-testid="challenge-round" className="k-small k-muted">{offer.round === 1 ? "First challenge" : "Last challenge: there is no appeal after this one"}</p>
      <div className="k-actions k-actions--stack k-actions--sticky">
        <Button data-testid="challenge-btn" variant="primary" disabled={!loginFirst && (!wallet || stale || !challengeGate.allowed || bondLoading)}
          onClick={loginFirst ?? (() => { if (bondQuote && bondQuote !== "loading") setResModal({ kind: "challenge", quote: bondQuote }); })}>Challenge the ruling</Button>
        <GateNotice action="challenge" only={["no-username", "username-unknown", "checking-username"]} />
      </div>
    </div>,
  );
  if (challengeResult) actions.push(<p key="challenge-result" data-testid={challengeResult.kind === "challenged" ? "challenge-result" : "challenge-refusal"} data-kind={challengeResult.kind}>{challengeResult.message}</p>);
  if (fin.show) actions.push(
    <div key="finalize" data-testid="finalize-section" className="k-stack">
      <p className="k-action__text">The challenge window is over. The ruling stands.</p>
      <p className="k-action__hint">This normally happens on its own. You can make it final now; it pays everyone.</p>
      <div className="k-actions k-actions--stack">
        <Button data-testid="finalize-btn" variant="primary" onClick={loginFirst ?? doFinalize} disabled={!loginFirst && (!wallet || stale || busy(finalizeAction))}>Finalize now</Button>
      </div>
      {finalizeResult && <p data-testid="finalize-result" role="alert">{finalizeResult}</p>}
    </div>,
  );
  if (isOpen && isMaker) actions.push(
    <div key="share" data-testid="share-section" className="k-stack">
      <p className="k-action__text">{sentence}</p>
      {view.next && <p className="k-action__hint"><TimeLeft at={view.next.at} label={view.next.label} past={view.next.past} /></p>}
      {inviteSecret ? (
        <div data-testid="invite-section" className="k-stack">
          <p className="k-small">Invite-only: each link works for one person. Enter their account and send them the link privately.</p>
          <TextField label="Their account" data-testid="invite-invitee-input" value={inviteeInput} onChange={(e) => { setInviteeInput(e.currentTarget.value); setInviteLinkOut(null); }} />
          <Button data-testid="invite-make-link" variant="primary" onClick={() => {
            try {
              const sig = signInvite({ secretHex: inviteSecret, betId, invitee: inviteeInput });
              setInviteLinkOut(buildInviteUrl(window.location.href, betId, sig));
              setInviteErr(null);
            } catch (e) { setInviteErr(String((e as Error).message)); setInviteLinkOut(null); }
          }}>Create invite link</Button>
          {inviteErr && <Notice tone="bad" data-testid="invite-error" title={inviteErr} />}
          {inviteLinkOut && <TextField label="Invite link" hideLabel data-testid="invite-link-output" readOnly value={inviteLinkOut} onFocus={(e) => e.currentTarget.select()} />}
        </div>
      ) : (
        <div className="k-actions k-actions--stack"><Button data-testid="share-link" variant="primary" onClick={copyLink}>Copy link</Button></div>
      )}
    </div>,
  );
  const requestResult = <RequestResultSection key="request" betId={betId} bet={bet} nowMs={nowMs} wallet={wallet} onChanged={refreshBet} />;
  const applyRuling = <ApplyRuling key="apply" betId={betId} bet={bet} wallet={wallet} onBet={setBet} />;

  // ---------------------------------------------------------------- More actions (collapsed)
  const more: React.ReactNode[] = [];
  if (showConcede) more.push(
    <div key="concede" data-testid="concede-section" className="k-stack">
      <p className="k-action__text">Concede</p>
      <p data-testid="concede-explainer" className="k-action__hint">Give up your side now. The other side is paid the pot minus the normal fee, any challenge bonds go back to whoever posted them. This can't be undone.</p>
      <div className="k-actions k-danger-fill"><Button data-testid="concede-btn" variant="destructive" onClick={loginFirst ?? (() => setResModal({ kind: "concede" }))} disabled={!loginFirst && (!wallet || stale)}>Concede</Button></div>
    </div>,
  );
  if (isOpen && isMaker) more.push(<CancelOffer key="cancel" betId={betId} bet={bet} wallet={wallet} onDone={(o) => { setCancelResult(o); refreshBet(); }} />);
  if (canSubmitExhibits) more.push(
    <div key="exhibit" data-testid="submit-exhibit-section" className="k-stack">
      <p className="k-action__text">Add evidence</p>
      <p className="k-action__hint">Paste the sha256 fingerprint of each file (comma-separated). Only the fingerprint goes on chain; keep the file to share it.</p>
      <TextField label="Evidence fingerprints" hideLabel data-testid="exhibit-hash-input" placeholder="sha256, sha256" value={exhibitHashInput} onChange={(e) => setExhibitHashInput(e.currentTarget.value)} />
      <Button data-testid="submit-exhibit-btn" onClick={loginFirst ?? doSubmitExhibits} disabled={!loginFirst && (!wallet || stale || !evidenceGate.allowed || !exhibitHashInput.trim() || busy(exhibitAction))}>Add evidence</Button>
      {busy(exhibitAction) && <p data-testid="submit-exhibit-status" className="k-small k-muted">Sending…</p>}
      {exhibitAction.error && <p data-testid="submit-exhibit-error" role="alert">{exhibitAction.error}</p>}
      {exhibitAction.txHash && <p data-testid="submit-exhibit-tx" className="k-small">Evidence added.</p>}
    </div>,
  );
  if (onDuplicate && isParty) more.push(
    <div key="dup" className="k-actions">
      <Button type="button" data-testid={isOpen ? "open-duplicate" : "payout-duplicate"} onClick={() => setDuplicateError(onDuplicate(bet))}>Duplicate this bet</Button>
      {ps && <a data-testid="payout-new-bet" href="/new">Start a new bet</a>}
    </div>,
  );
  // FE10b: RefereeChange stays mounted for the bet's whole life so its result line survives the post-change refresh.
  const refereeChange = isParty ? <RefereeChange key="referee-change" bet={bet} betId={betId} me={myAccountId} wallet={wallet} names={names} registry={registry} onRefresh={refreshBet} /> : null;
  const moreSummary = [showConcede && "Concede", isOpen && isMaker && "Cancel", canSubmitExhibits && "Add evidence", isParty && !refereeChangeFrozen(bet) && !ps && "Change who decides", onDuplicate && isParty && "Duplicate"].filter(Boolean).join(" · ");

  const onlyTakeNotice = actions.length === 1 && showTake && avail?.kind !== "available";
  const primaryKind = (actions.length && !onlyTakeNotice) || canEmergencyRefund ? "primary" : "info";
  return (
    <div data-testid="bet-page" className="b1-page">
      {/* the contract status for tests and support tools; people read the pill */}
      <span data-testid="bet-status" hidden>{bet.status}</span>

      <header className="k-card b1-head" data-testid="bet-header" data-kit="BetHeader">
        <h1 className="k-header__q" data-testid="bet-question">{view.question}</h1>
        <span className="k-row">
          <StatusPill pill={notice ? { ...view.pill, label: notice.label, tone: "warn" } : view.pill} data-testid="bet-chip" data-chip={view.pill.id} />
          {view.next && <TimeLeft at={view.next.at} label={view.next.label} past={view.next.past} />}
        </span>
        <span data-testid="bet-stakes">{stale ? "—" : <Sides view={view} />}</span>
        <DeciderChip decider={view.decider} data-testid="bet-decider" />
        <p className="k-header__sentence" data-testid="bet-sentence">{notice ? `${notice.title}.` : stale ? hideAmounts(view.headline ?? view.sentence) : view.headline ?? view.sentence}</p>
      </header>

      {notice && <Notice tone="warn" data-testid="lifecycle-notice" data-kind={notice.id} title={notice.title} body={notice.lines.join(" ")} />}
      {isParty && refereeChangeFrozen(bet) && ["Resolving", "Proposed", "Challenged", "Evidence", "Rejudge"].concat(bet.bonds.length ? ["Taken"] : []).includes(bet.status) && (
        <p data-testid="referee-change-frozen" className="k-small k-muted">{FROZEN_MESSAGE}</p>
      )}
      {pend && !refereeChangeFrozen(bet) && (() => {
        const what = (v: string | null) => (v === "the AI" ? "the AI" : v ? name(v) : "the AI");
        const maker = name(bet.envelope.maker), taker = bet.taker ? name(bet.taker) : "the taker";
        return (
          <Notice tone="info" data-testid="referee-pending" title="A change of who decides is waiting"
            body={`${pend.makerSet ? `${maker} proposed ${what(pend.maker)}` : ""}${pend.makerSet && pend.takerSet ? "; " : ""}${pend.takerSet ? `${taker} proposed ${what(pend.taker)}` : ""}. It only happens when both sides propose the same; waiting for ${pend.makerSet ? taker : maker}.`} />
        );
      })()}
      {rs.kind === "wait" && <p data-testid="referee-waiting" className="k-small k-muted">They have until the deadline to decide (<TimeLeft at={Number(bet.envelope.resolve_deadline) / 1e6} label="due" past="passed" />). If they don't, both stakes come back.</p>}

      {actions.length > 0 && (
        <section className="k-card k-action b1-action" data-testid="action-card" data-kind={primaryKind}>
          {actions}
        </section>
      )}
      {/* Always mounted in this one place (each keeps its own modal / result line across the refresh that follows a send);
          each draws itself as an action card only when it applies. */}
      {applyRuling}
      {requestResult}
      {concedeResult && <Notice tone={concedeResult.kind === "conceded" ? "good" : "warn"} data-testid="concede-result" data-kind={concedeResult.kind} title={concedeResult.message} />}
      {!isOpen && cancelResult && <Notice tone="good" data-testid="cancel-result" data-kind={cancelResult.kind} title={cancelResult.message} />}

      {card.kind === "ruling" && (
        <section className="k-card" data-testid="ruling-card" data-outcome={card.outcome} data-kit="RulingCard">
          <span className="k-row k-small k-muted"><DeciderChip decider={{ kind: "ai" }} /></span>
          <p className="k-ruling__outcome" data-testid="ruling-headline">{card.headline}</p>
          {card.body && <p data-testid="ruling-body">{card.body}</p>}
          {card.evidence.length === 0 ? <p data-testid="ruling-no-quotes" className="k-small k-muted">The AI didn't leave a quote for this ruling. Its full reasoning is under Details.</p> : card.evidence.map((e, i) => (
            <blockquote key={i} className="k-quote" data-testid={`ruling-quote-${i}`}>“{e.quote}”
              <cite>{e.url ? <a data-testid={`ruling-source-${i}`} href={e.url} target="_blank" rel="noreferrer noopener">{e.sourceName}</a> : <span data-testid={`ruling-source-${i}`}>{e.sourceName}</span>}</cite>
            </blockquote>
          ))}
          {view.ruling?.kind === "ai" && view.ruling.finalAt != null && (
            <p data-testid="ruling-final" className="k-small k-muted">Becomes <TimeLeft at={view.ruling.finalAt} label="final" past="final" /> unless someone challenges.</p>
          )}
          <button type="button" className="k-copy k-verify-btn" data-testid="ruling-verify" onClick={verify.openSheet}>Verify this ruling</button>
        </section>
      )}
      {view.ruling?.kind === "person" && (
        <section className="k-card" data-testid="referee-ruling-card" data-outcome={view.ruling.outcome}>
          <p className="k-ruling__outcome">{view.ruling.outcome === "VOID" ? `${personLabel(view.ruling.who)} voided this bet` : `${personLabel(view.ruling.who)} ruled ${view.ruling.outcome}`}</p>
          <button type="button" className="k-copy k-verify-btn" data-testid="ruling-verify" onClick={verify.openSheet}>Verify who decided</button>
        </section>
      )}
      {offer.kind === "no-more-appeals" && <p data-testid="no-more-appeals" className="k-small k-muted">There are no more challenges left on this bet.</p>}
      {offer.kind === "closed" && <p data-testid="challenge-closed" data-reason={offer.reason} className="k-small k-muted">{offer.reason === "window-closed" ? "The challenge window has closed." : offer.message}</p>}

      {ps && view.payout && (
        <section className="k-card" data-testid="payout-screen" data-ending={ps.ending} data-kit="PayoutCard">
          <p className="k-payout__headline" data-testid="payout-headline">{view.payout.headline}</p>
          <dl className="k-kv k-kv--total" data-testid="payout-rows">
            {view.payout.rows.map((r, i) => (
              <React.Fragment key={i}><dt data-emphasis={r.emphasis ? "1" : "0"}>{r.label}</dt><dd data-emphasis={r.emphasis ? "1" : "0"}>{stale ? "—" : <Amounts list={r.value} minor={r.minor} />}</dd></React.Fragment>
            ))}
          </dl>
          {/* how the amounts above were worked out (storage, tips, no-fee, challenge costs), people as @usernames */}
          {ps.lines.length > 0 && <ul data-testid="payout-lines" className="k-list k-small">{ps.lines.map((l, i) => <li key={i}>{named(l)}</li>)}</ul>}
          <div data-testid="payout-progress" data-state={ps.progress.state} className="k-stack">
            <p data-testid="payout-progress-message" className="k-small k-muted">{ps.progress.message}</p>
            {ps.progress.lines.length > 0 && <ul data-testid="payout-progress-lines" className="k-list k-small">{ps.progress.lines.map((l, i) => <li key={i}>{named(l)}</li>)}</ul>}
            {ps.progress.canRetry && (
              <div className="k-actions"><Button data-testid="payout-retry-btn" variant="primary" onClick={loginFirst ?? doRetryPayout} disabled={!loginFirst && (!wallet || stale || busy(drainAction))}>Retry payout</Button></div>
            )}
            {drainResult && <p data-testid="payout-retry-result">{drainResult}</p>}
            {drainAction.error && !drainResult && <p data-testid="payout-retry-error" role="alert">{drainAction.error}</p>}
          </div>
          {endedRole && (
            <span className="k-row k-small">
              {!onDuplicate && <a data-testid="payout-new-bet" href="/new">Start a new bet</a>}
              <a data-testid="payout-my-bets" href="/my-bets">My bets</a>
            </span>
          )}
        </section>
      )}

      {(more.length > 0 || refereeChange) && (
        <details className="k-disc" data-testid="more-actions" data-kit="Disclosure" open={moreOpen || !!duplicateError || undefined}
          onToggle={(e) => setMoreOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary><span className="k-disc__title">More actions</span>{moreSummary && <span className="k-disc__summary">{moreSummary}</span>}<span className="k-disc__chev" aria-hidden="true">›</span></summary>
          <div className="k-disc__body k-stack b1-more">
            {more}
            {refereeChange}
            {duplicateError && <Notice tone="bad" data-testid="duplicate-error" title={duplicateError} />}
          </div>
        </details>
      )}

      <ActivityList entries={verify.entries} data-testid="bet-activity" />
      <DetailsCard detail={detail} contractId={ESCROW_CONTRACT_ID} onVerifyJudge={verify.openSheet} />
      {verify.cta}
      {verify.sheet}

      {takeOpen && !loginFirst && (
        <TakeBetModal bet={bet} betId={betId} myAccountId={myAccountId} wallet={wallet} storageRates={storageRates} inviteSig={inviteSig}
          names={names} onNeedMoney={onNeedMoney}
          onTaken={() => { getBet(betId).then(setBet).catch(() => {}); }} onClose={() => setTakeOpen(false)} />
      )}
      {!loginFirst && resModal?.kind === "challenge" && (
        <ChallengeModal bet={bet} betId={betId} wallet={wallet} names={names} quote={resModal.quote} onChanged={refreshBet}
          onClose={(last) => { setResModal(null); if (last) setChallengeResult(last); }} />
      )}
      {resModal?.kind === "concede" && (
        <ConcedeModal bet={bet} betId={betId} wallet={wallet} names={names} onChanged={refreshBet}
          onClose={(last) => { setResModal(null); if (last) setConcedeResult(last); }} />
      )}
      {resModal?.kind === "referee" && (
        <RefereeRuleModal bet={bet} betId={betId} wallet={wallet} names={names} outcome={resModal.outcome} onChanged={refreshBet}
          onClose={(last) => { setResModal(null); if (last) setRuleResult(last); }} />
      )}
    </div>
  );
}
