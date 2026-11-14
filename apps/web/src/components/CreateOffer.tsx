import { longBetJudgeNote } from "../../lib/judgeChain";
import React, { useEffect, useState } from "react";
import { Button, Banner, TextField, CheckField } from "../ui";
import type { StructuredOffer, TakerOptionUI } from "./ReviewCard";
import { feeForSideUnits } from "../../lib/escrowAdapter";
import StakeSection, { useStake } from "./StakeSection";
import { type StakeDraft } from "../../lib/stakeSection";
import { releaseFeeAccount } from "../../lib/releaseConfig";
import { OFFER_EXPIRY_OPTIONS, defaultResolveSecs, resolveProblem, expiryProblem, takerProblem } from "../../lib/stakeDeadlines";
import { builderGate } from "../../lib/builderGate";
import { fundingDeadlineSecs, openWindowProblem, offerClosesLabel as offerClosesLabelFor } from "../../lib/offerExpiry";
import { customDeadlineSecs } from "../../lib/customBuilder";
import { windowStartIsAuto } from "../../lib/betDetails";
import { blankCustomTermSheet } from "../../lib/termSheet";
import { pickerGroupFor, betSentence, blankFill, customSheetFor, deadlineLabelFor, fillProblems, typedSheetFor, claimLineFor, type BetKind, type FillState } from "../../lib/betTypePicker";
import BetTypeStep from "./BetTypeStep";
import FillStep from "./FillStep";
import WhoDecides from "./WhoDecides";
import BetOptions from "./BetOptions";
import { FIXED_SETTLEMENT_PERIOD, FIXED_SETTLEMENT_SECS, DEFAULT_EXPIRY } from "../../lib/betOptions";
import { templateSourceNames, customSourceHosts } from "../../lib/templateSources";
import { eventTimes, templateId } from "../../lib/templates";
import { deciderLine } from "../../lib/assetPriceSheet";
import { MOCK_REGISTRY, type UserRegistry } from "../../lib/refereeRegistry";
import { copiedRefereeName, dateInputValue, stakeAmountText } from "../../lib/createFlow";
import { amountUnits } from "../../lib/reviewCard";
import { exactTime } from "../../lib/dates";
import { RefereeChoice, AI_CHOICE, refereeAccount, validateReferee, tipProblem } from "../../lib/referee";
import { findAsset, toBaseUnits } from "../../lib/assets";
import { chainClock } from "../../lib/chainClock";
// REVIEW1 (#10): "now" for the sheet stamp and the shown deadlines is chain time (block header), not the device clock. Only before the
// first block has been read does it fall back to the device clock; the Open re-checks the deadline against chain time before signing.
const nowForReview = (): number => chainClock.nowMs() ?? Date.now();

/** What survives leaving the create screen for the review and coming back with "Edit" (held by App). */
export interface CreateDraft {
  step: "type" | "fill" | "resolver"; fill: FillState; referee: RefereeChoice;
  /** FE3b Q4: every other entered value, so Edit from the review keeps amounts, odds, deadlines, taker options and referee details. */
  more?: {
    settlementPeriod: string; offerExpiry: string; resolveDate: string | null;
    takerAccount: string; inviteByLink: boolean; refereeUsername?: string; tipMaker: boolean;
  } & StakeDraft; // BET1b: stake token, your amount, their amount (null = even) and the odds they make
}

export default function CreateOffer({
  onSubmit,
  makerAccount,
  refereeRegistry = MOCK_REGISTRY,
  draft = null,
  onDraft,
  copyInfo = null,
}: {
  /** FE15: set when the form was copied from an old bet (banner, highlighted past dates). */
  copyInfo?: { banner: string; notes: string[] } | null;
  draft?: CreateDraft | null;
  onDraft?: (d: CreateDraft) => void;
  onSubmit: (offer: StructuredOffer) => void;
  makerAccount: string | null;
  /** D-REFUI1: registered users only. Defaults to the mock registry until the real service exists. */
  refereeRegistry?: UserRegistry;
}) {
  const [step, setStep] = useState<CreateDraft["step"]>(draft?.step ?? "type");
  const [fill, setFill] = useState<FillState>(draft?.fill ?? blankFill("custom"));
  // BET1b: the Stake section (token, you put in / they put in, live limits and fee) -- components/StakeSection.tsx.
  const stake = useStake(draft?.more);
  const { symbol: stakeSymbol, makerAmount, takerAmount, odds, stakeErr, theirStakeErr } = stake;
  const [resolveDate, setResolveDate] = useState<string | null>(draft?.more?.resolveDate ?? null);
  // BET1c (UX-33): the challenge window is fixed at 24h; a draft/copied bet's other window is not carried over.
  const settlementPeriod = FIXED_SETTLEMENT_PERIOD;
  const settlementSecs = FIXED_SETTLEMENT_SECS;
  const [offerExpiry, setOfferExpiry] = useState(draft?.more?.offerExpiry ?? DEFAULT_EXPIRY);
  const [takerAccount, setTakerAccount] = useState(draft?.more?.takerAccount ?? "");
  const [inviteByLink, setInviteByLink] = useState(draft?.more?.inviteByLink ?? false);
  const [referee, setReferee] = useState<RefereeChoice>(draft?.referee ?? AI_CHOICE);
  const [refereeUsername, setRefereeUsername] = useState<string | undefined>(draft?.more?.refereeUsername);
  const [tipMaker, setTipMaker] = useState(draft?.more?.tipMaker ?? false);
  const human = referee.mode === "human";
  const refCtx = { maker: makerAccount, taker: null as string | null, feeAccount: releaseFeeAccount() };
  // BET1c: the username search box state lives in WhoDecides.
  const resetReferee = () => { setReferee(AI_CHOICE); setRefereeUsername(undefined); setRefRegErr(null); setTipMaker(false); };
  const tplId = fill.typeId;
  useEffect(() => { onDraft?.({ step, fill, referee, more: { ...stake.draft, settlementPeriod, offerExpiry, resolveDate, takerAccount, inviteByLink, refereeUsername, tipMaker } }); }, [step, fill, referee, stake.draft.stakeText, stake.draft.theirText, stake.draft.stakeSymbol, settlementPeriod, offerExpiry, resolveDate, takerAccount, inviteByLink, refereeUsername, tipMaker]);
  const [refRegErr, setRefRegErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // FE15: a copied referee must still be a registered user (same check as picking one); the username comes back with it.
  // SM2 C1-1 (G8): resolved in lib/createFlow (the screen never calls the registry); never names the raw account.
  useEffect(() => {
    const acct = copyInfo ? refereeAccount(referee) : null;
    if (!acct) return;
    let live = true;
    (async () => {
      const r = await copiedRefereeName(refereeRegistry, acct);
      if (!live) return;
      if (r.kind === "unregistered") { setRefRegErr(r.message); return; }
      if (r.kind === "named") { setRefRegErr(null); setRefereeUsername(r.username); }
      // "unknown" (registry down): shown by the form's own checks on Review
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Errors the Stake / More options sections already print under their own field (UIR1 §3.4: never twice).
  const shownInline = (e: string) => [stakeErr, theirStakeErr, takerErr, human ? resolveErr : null, human ? expiryErr : null].includes(e);
  function validate(): string | null {
    if (stakeErr) return stakeErr;
    if (theirStakeErr) return theirStakeErr;
    if (takerErr) return takerErr;
    if (windowErr) return windowErr; // DR3W1: the event ends before anyone could take it
    if (human && resolveErr) return resolveErr;
    if (human && expiryErr) return expiryErr;
    const refEl = validateReferee(referee, { ...refCtx, taker: takerAccount || null });
    if (refEl.length) return refEl.join(" ");
    if (refRegErr) return refRegErr;
    if (human && tipMaker) {
      const tp = tipProblem(BigInt(toBaseUnits(stakeSymbol, makerAmount)), BigInt(findAsset(stakeSymbol)?.minFeePerSide ?? "0"));
      if (tp) return tp;
    }
    const flags = fillProblems({ ...fill, human }, nowForReview());
    if (flags.length) return `Fix term sheet before opening: ${flags.join(" ")}`;
    return null;
  }

  // D-SCOPE5 (BET1b): no cross-asset taker options -- the taker pays in the same token only.
  const takerOptions: TakerOptionUI[] = [{ assetSymbol: stakeSymbol, amount: takerAmount, isSameAsset: true, pctFromMarket: 0, quoteTime: null }];

  // FE3: every bet is a typed sheet (4 launch types) or a custom builder sheet; the existing lints (fillProblems) judge both.
  const fillNow: FillState = { ...fill, human };
  const reviewNowMs = nowForReview();
  let typedSheet: Record<string, unknown> | null = null;
  try { typedSheet = tplId === "custom" ? customSheetFor(fill.custom, human) : typedSheetFor(fillNow, reviewNowMs); } catch { typedSheet = null; }
  const flags = fillProblems(fillNow, reviewNowMs);
  // TPL1: a price bet on a coin other than Bitcoin is a custom sheet even though the form is a price type.
  const sheetIsCustom = !!typedSheet && templateId(typedSheet).id === "custom";
  const termSheet = blankCustomTermSheet();
  const priceWarning: string | null = null;
  const customVenueNotes: string[] = [];
  const refereeErrors = refereeAccount(referee) ? validateReferee(referee, { ...refCtx, taker: takerAccount || null }) : [];
  // SM2 C1-3: the lib/money rule, not a float toFixed (the tip = the contract's side_fee on your stake)
  const tipHuman = stakeAmountText(stakeSymbol, feeForSideUnits(amountUnits(stakeSymbol, makerAmount), BigInt(findAsset(stakeSymbol)?.minFeePerSide ?? "0")));

  const takerErr = takerProblem(takerAccount, { maker: makerAccount, referee: refereeAccount(referee) });
  const nowSecs = Math.floor(reviewNowMs / 1000);
  let eventSecs: number | null = null;
  try { if (typedSheet) eventSecs = sheetIsCustom ? customDeadlineSecs(typedSheet) ?? null : eventTimes(typedSheet).endSecs; } catch { eventSecs = null; }
  const windowErr = eventSecs !== null && tplId !== "custom" ? openWindowProblem({ endSecs: eventSecs, nowSecs }) : null;
  const defaultResolve = eventSecs === null ? null : defaultResolveSecs(eventSecs, nowSecs);
  const resolveSecs = resolveDate ? Date.parse(`${resolveDate}T00:00:00Z`) / 1000 : defaultResolve;
  const resolveErr = human && resolveSecs !== null && eventSecs !== null && Number.isFinite(resolveSecs) ? resolveProblem({ resolveSecs, eventSecs, nowSecs }) : human && resolveDate && !Number.isFinite(resolveSecs) ? "Pick a date." : null;
  const expiryErr = human && resolveSecs !== null && Number.isFinite(resolveSecs)
    ? expiryProblem({ expirySecs: nowSecs + (OFFER_EXPIRY_OPTIONS.find((o) => o.id === offerExpiry)?.secs ?? 0), resolveSecs }) : null;

  // D-REFUI3b: a person has until this date to rule (default event + 1 year, held to 4 years); shown on the review card.
  // FE5b: the chosen expiry -> funding deadline (min of the event close and now + expiry), the same helper buildOpenEnvelope uses.
  const offerExpirySecs = OFFER_EXPIRY_OPTIONS.find((o) => o.id === offerExpiry)?.secs;
  let fundingLatest: number | null = null;
  try { if (typedSheet) fundingLatest = sheetIsCustom ? customDeadlineSecs(typedSheet) ?? null : eventTimes(typedSheet).closeSecs; else if (termSheet.deadlineUtcIso) fundingLatest = Date.parse(termSheet.deadlineUtcIso) / 1000; } catch { fundingLatest = null; }
  const closes = fundingLatest !== null && Number.isFinite(fundingLatest) ? fundingDeadlineSecs({ latestSecs: fundingLatest, nowSecs, expirySecs: offerExpirySecs }) : null;
  const offerClosesLabel = closes ? offerClosesLabelFor(closes) : null;
  const resolveByLabel = human && resolveSecs !== null && Number.isFinite(resolveSecs) ? exactTime(resolveSecs * 1000).utc : null;

  const offer: StructuredOffer = {
    termSheet,
    typedSheet,
    restampWindowStart: tplId === "custom" && windowStartIsAuto(fill.custom) ? true : undefined,
    sources: !typedSheet ? [] : sheetIsCustom ? customSourceHosts(typedSheet) : templateSourceNames(typedSheet),
    deciderText: (tplId === "btc_close_at_t" || tplId === "btc_touch" || tplId === "outperform") && typedSheet ? deciderLine(typedSheet) : null,
    deadlineLabel: deadlineLabelFor(fillNow),
    eventAtSecs: eventSecs,
    claimText: claimLineFor(fillNow),
    makerAssetSymbol: stakeSymbol,
    makerAmount,
    takerAssetSymbol: stakeSymbol,
    takerAmount,
    odds: Number(odds.toFixed(4)),
    settlementPeriodLabel: settlementPeriod,
    settlementSecs,
    resolveSecs: human && resolveSecs !== null && !resolveErr ? resolveSecs : undefined,
    takerOptions,
    referee,
    refereeUsername: human ? refereeUsername : undefined,
    tipMaker: human && tipMaker,
    resolveByLabel,
    offerClosesLabel,
    offerClosesAtSecs: closes ? closes.secs : null,
    offerClosesClamped: !!closes?.clamped,
    reviewedAtMs: nowSecs * 1000,
    offerExpirySecs,
    takerAccount: takerAccount || null,
    inviteByLink: inviteByLink && !takerAccount,
    flags,
    priceWarning,
    customVenueNotes,
  };

  return (
    <div data-testid="create-offer-form">
      {copyInfo && (
        <div data-testid="copied-banner" role="status">
          <p>{copyInfo.banner}</p>
          {copyInfo.notes.map((n, i) => <p key={i} data-testid={`copied-note-${i}`}>{n}</p>)}
        </div>
      )}
      {step === "type" && <BetTypeStep group={pickerGroupFor(fill.typeId)} onPick={(id: BetKind) => { setFill((f) => (f.typeId === id ? f : blankFill(id))); setStep("fill"); }} />}
      {step === "fill" && (
        <FillStep
          fill={{ ...fill, human }}
          onChange={setFill}
          copied={!!copyInfo}
          onBack={() => setStep("type")}
          onNext={() => setStep("resolver")}
        />
      )}
      {step === "resolver" && (<div data-testid="step-resolver">
      <p data-testid="resolver-sentence">{betSentence({ ...fill, human })}</p>
      {/* The flags container is always present (empty when the bet passes every lint). */}
      <div data-testid="term-sheet-flags" style={{ color: "var(--ax-color-text-error, #b91c1c)" }}>
        {flags.map((f, i) => (
          <div key={i} data-testid={`flag-${i}`}>{f}</div>
        ))}
      </div>

      <StakeSection stake={stake} />

      <WhoDecides
        referee={referee}
        setReferee={setReferee}
        onAi={resetReferee}
        refereeUsername={refereeUsername}
        setRefereeUsername={setRefereeUsername}
        tipMaker={tipMaker}
        setTipMaker={setTipMaker}
        refRegErr={refRegErr}
        setRefRegErr={setRefRegErr}
        refereeRegistry={refereeRegistry}
        refCtx={{ ...refCtx, taker: takerAccount || null }}
        refereeErrors={refereeErrors}
        tipHuman={tipHuman}
        makerAmount={makerAmount}
        symbol={stakeSymbol}
      />
      <BetOptions
        human={human}
        offerExpiry={offerExpiry}
        setOfferExpiry={setOfferExpiry}
        takerAccount={takerAccount}
        setTakerAccount={setTakerAccount}
        takerErr={takerErr}
        inviteByLink={inviteByLink}
        setInviteByLink={setInviteByLink}
        resolveValue={resolveDate ?? (defaultResolve === null ? "" : dateInputValue(defaultResolve))}
        setResolveDate={setResolveDate}
        resolveErr={resolveErr}
        expiryErr={expiryErr}
      />

      {/* C1 (UIR1 §3.4): the footer -- Back, then the one primary "Review". A problem already shown under its field is not repeated. */}
      {error && !shownInline(error) && <Banner status="error" data-testid="form-error">{error}</Banner>}
      <div className="k-actions create-footer" data-testid="resolver-footer">
        <Button type="button" variant="ghost" data-testid="resolver-back" onClick={() => setStep("fill")}>Back</Button>
        <Button
          variant="primary"
          data-testid="review-offer"
          onClick={() => {
            const err = validate();
            setError(err);
            if (!err) onSubmit(offer);
          }}
        >
          Review
        </Button>
      </div>
      </div>)}
    </div>
  );
}
