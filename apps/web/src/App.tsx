import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, Banner } from "./ui";
import { TopNav } from "@astryxdesign/core/TopNav";
import { AppNavHeight } from "./AppNavHeight";
import { usePrivy, useUser } from "@privy-io/react-auth";
import { useCreateWallet, useSignRawHash } from "@privy-io/react-auth/extended-chains";
import { NearWalletSetup, findNearWallet } from "../lib/nearWalletSetup";
import LoginPage from "./components/Login";
import { type CreateDraft } from "./components/CreateOffer";
import CreateBetStep, { StepSync, ResumeToStake } from "./components/CreateBetStep";
import { FlowModal, type FlowResult } from "./modal/FlowModal";
import { CREATE_STEPS, stepIndexFor, type CreateStepId } from "../lib/createBetFlow";
import ReviewCard, { StructuredOffer } from "./components/ReviewCard";
import BetPage from "./components/BetPage";
import HomePage from "./components/HomePage";
import DocsPage from "./components/docs/DocsPage";
import { GuidePage } from "./components/AiBet";
import WalletPage from "./components/WalletPage";
import StatusBanner from "./components/StatusBanner";
import UsernameStep from "./components/UsernameStep";
import { fundingShort, isAddMoneyPath, parseAddMoneyPath, type FundingShort } from "../lib/fundingGate";
import { FundSheet } from "./components/funding/FundSheet";
import { FundingWatcher } from "./components/funding/FundingWatcher";
import { addMoneySheetOn } from "./components/funding/fundingLive";
import { loadMoney } from "../lib/accountBalances";
import { nothingToBetWith } from "../lib/fundSheet";
import { setAppSigner } from "../lib/appSigner";
import { e2eSignSeam, e2eTestWallet, e2eRegistryUrl, e2eSourceCheckTimeoutMs, onE2eWalletChanged, e2eRenderCrash } from "../lib/testHooks";
import { ShortNotice } from "./components/ShortNotice";
import { HttpUserRegistry } from "../lib/refereeRegistry";
import { refereeAccount } from "../lib/referee";
import { REGISTRY_URL } from "../lib/config";
import { buildStakeTransfer } from "../lib/stakeTransfer";
import { REGISTRY_DOWN_MESSAGE } from "../lib/username";
import { walletErrorMessage } from "../lib/loginCopy";
import { shellView, sessionEnded, LOGGED_OUT_TOAST } from "../lib/shell";
import { Brand } from "./components/BrandMark";
import { Notice, EmptyState } from "./kit/blocks";
import { useToast } from "./kit/Toast";
import { PAGE_NOTICE_ID } from "./components/StatusBanner";
import { useRoute } from "./router";
import { routeRequiresLogin, loginPageLine } from "../lib/router";
import { readGuest, writeGuest, guestRoute, GUEST_BANNER, LOGIN_TO_BET_LINE } from "../lib/guest";
import { useRelayAction } from "../lib/useRelayAction";
import { useContractStatus } from "../lib/useContractStatus";
import { useOnline } from "../lib/useOnline";
import { useLiveState } from "../lib/liveState";
import { liveState } from "../lib/liveState";
import { MoneyStaleContext } from "../lib/moneyContext";
import { moneyBlocked, outOfDateReason } from "../lib/globalStates";
import { viewChainId } from "../lib/rpc";
import { COPY, MONEY_HIDDEN } from "../lib/globalStates";
import { requestSourceCheck, SourceCheckFailedError, SOURCECHECK_TIMEOUT_MS, type OpenAttestation } from "../lib/sourceCheckClient";
import { plainPreflightFailure, preflightApplies, termsCode, type PlainFailure } from "../lib/sourcePreflight";
import { approvalFor, approvalGate, approvalTimeLeftMs, offerKey, offerSheet, recheckDecision, signedMatchesReview, type Approval } from "../lib/openApproval";
import { chainClock, monotonicNow } from "../lib/chainClock";
import SourcePreflight, { HumanNoPreflight, type PreflightState } from "./components/SourcePreflight";
import { buildOpenEnvelope, makerDeposit } from "../lib/openEnvelope";
import { fetchStorageRates, unavailableStorageAssets, reviewStorage, type StorageRates } from "../lib/storageCharge";
import { loadReleaseConfig } from "../lib/releaseConfig";
import { findAsset } from "../lib/assets";
import { canonicalTerms, termsHash } from "../lib/templates";
import { buildOpenMsg, resolverKeys } from "../lib/escrowAdapter";
import { generateInviteKey, saveInviteKey } from "../lib/inviteLink";
import { stampForCheck } from "../lib/openRefresh";
import { customDeadlineSecs } from "../lib/customBuilder";
import { templateId } from "../lib/templates";
import { checkOpenPins } from "../lib/openPins";
import { ESCROW_CONTRACT_ID, INTENTS_CONTRACT_ID } from "../lib/config";
import { assetId as tableAssetId, toBaseUnits } from "../lib/assets";
import { viewTxLogs, viewFunction } from "../lib/rpc";
import ShareScreen from "./components/ShareScreen";
import { afterOpened } from "../lib/indexerRefresh";
import { confirmOpen, confirmTiming, type OpenOutcome } from "../lib/openConfirm";
import { DECLINED_MESSAGE } from "../lib/openRefusal";
import { getBet, type Bet } from "../lib/escrowAdapter";
import { appCtx, accountStateOf, authStateOf, gate, identityOf } from "../lib/appState";
import { AppStateProvider, GateNotice, type GateFixes } from "./kit/Gate";
import { buildReviewModel } from "../lib/reviewCard";
import { autoCheckOnEnter, closingTooSoon, onApprovalExpired, openButton, openFlowResult, openProgress as openProgressLine } from "../lib/createFlow";
import { duplicateDraft, type DuplicateCopy } from "../lib/duplicateBet";

declare global {
  interface Window {
    __e2e?: {
      ready: boolean;
      authenticated: boolean;
      nearAddress: string | null;
      status: string;
      signRawHash?: (address: string, hashHex: string) => Promise<string>;
    };
    // Test-only seams, set by mocked Playwright specs (page.addInitScript) and read ONLY through lib/testHooks.ts, which compiles
    // them out of a mainnet production bundle (types only here).
    __e2eSourceCheckTimeoutMs?: number;
    __e2eRegistryUrl?: string;
    __e2eTestWallet?: {
      nearAddress: string;
      signRawHash: (address: string, hashHex: string) => Promise<string>;
    };
  }
}

// Sub-step of the /new route (create form -> review card).
type NewStep = "create" | "review" | "share";

// NAV1: the fake-wallet seam, read ONLY through lib/testHooks.ts (compiled out of a mainnet production bundle).
const testWallet = e2eTestWallet;

export default function App() {
  const { ready, authenticated, user, logout } = usePrivy();
  const { refreshUser } = useUser();
  const { route, navigate } = useRoute();
  // Mocked e2e specs can swap in window.__e2eTestWallet after load and fire "e2e-wallet-changed".
  const [walletTick, setWalletTick] = useState(0);
  useEffect(() => onE2eWalletChanged(() => setWalletTick((n) => n + 1)), []);
  const signedIn = authenticated || (walletTick >= 0 && !!testWallet());
  // GUEST1: "Browse as guest" (read-only, no account). Per tab (sessionStorage); signing in clears it, Log out never sets it.
  const [guestFlag, setGuestFlag] = useState(() => readGuest(typeof window !== "undefined" ? window.sessionStorage : null));
  const setGuest = (on: boolean) => { writeGuest(window.sessionStorage, on); setGuestFlag(on); };
  // The login page's line after a guest pressed an action ("Log in to bet."); null = the route's own line.
  const [loginLine, setLoginLine] = useState<string | null>(null);
  // Set when a guest asked for the login ("Log in" / an action): the login page shows even on a public page (Docs).
  const [loginAsked, setLoginAsked] = useState(false);
  const askLogin = (line: string | null) => { setGuest(false); setLoginLine(line); setLoginAsked(true); };
  useEffect(() => { if (signedIn) { if (guestFlag) setGuest(false); setLoginLine(null); setLoginAsked(false); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [signedIn, guestFlag]);
  const { createWallet } = useCreateWallet();
  const { signRawHash } = useSignRawHash();
  const [nearAddress, setNearAddress] = useState<string | null>(null);
  const [status, setStatus] = useState("init");
  const [walletRetry, setWalletRetry] = useState(0);
  const [newStep, setNewStep] = useState<NewStep>("create");
  // The old `screen` value, derived from the route so the review-card code below is unchanged.
  const screen: "create" | "review" | "share" | "other" = route.name === "new" ? newStep : "other";
  const setScreen = (s: NewStep) => setNewStep(s);
  const [offer, setOffer] = useState<StructuredOffer | null>(null);
  // FE3: the bet-type / fill-in / resolver step state, so "Edit" on the review returns to what was typed. "Create offer" starts fresh.
  const [createDraft, setCreateDraft] = useState<CreateDraft | null>(null);
  const [createKey, setCreateKey] = useState(0);
  // FE15 (S17): set while the form holds terms copied from an old bet (banner + highlighted past dates).
  const [copyInfo, setCopyInfo] = useState<{ banner: string; notes: string[] } | null>(null);
  // WALLET1 (a): one in-flight NEAR wallet setup per user (effect re-fires share it).
  const walletSetup = useRef(new NearWalletSetup());
  const openAction = useRelayAction();
  // FE8 (S8): what happened to the last Open attempt, and the bet read back once it succeeded.
  const [openResult, setOpenResult] = useState<{ kind: "declined" | "refused" | "pending" | "failed"; message: string } | null>(null);
  const [openBusy, setOpenBusy] = useState<"confirming" | null>(null);
  const [shared, setShared] = useState<{ betId: number; bet: Bet } | null>(null);
  const [storageRates, setStorageRates] = useState<StorageRates | undefined>(undefined);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [sourceCheck, setSourceCheck] = useState<PreflightState>("idle");
  const [preflightFail, setPreflightFail] = useState<PlainFailure | null>(null);
  const [openShort, setOpenShort] = useState<FundingShort | null>(null);
  const [sourceCheckMsg, setSourceCheckMsg] = useState<string | null>(null);
  // REVIEW1 (#2): the source-check approval, bound to the exact offer it checked (lib/openApproval). Any other offer -> no approval.
  const [approval, setApproval] = useState<Approval | null>(null);
  const currentApproval = approvalFor(approval, offer);
  const attestation: OpenAttestation | null = currentApproval?.attestation ?? null;
  // REVIEW1 (#10): automatic re-checks used for the offer under review (max one, lib/openApproval MAX_AUTO_RECHECKS), and the offer key a
  // running check belongs to.
  const autoRechecks = useRef<{ key: string; n: number }>({ key: "", n: 0 });
  // C1 (familiarcow UX-37 #5): offers that already had their ONE automatic AI source check on entering Review (lib/createFlow).
  const autoTried = useRef<Set<string>>(new Set());
  const checkingKey = useRef<string | null>(null);

  // The source-check request for the current review. AI mode (C1): it runs by itself when Review opens, once per reviewed offer; after
  // that the user presses the one button. Human mode (D-FE6B1): the same request runs silently, because the contract needs a fresh
  // resolver-signed attestation on every Open; it makes no AI call.
  const checkRun = useRef(0);
  // REVIEW1 (#10): chain time for stamps and deadlines. Falls back to the device clock ONLY when the RPC answers a block without a
  // timestamp (never the case on a real NEAR RPC); a failed read returns null and the caller stops.
  const chainNowForOpen = async (): Promise<number | null> => {
    const ms = await chainClock.ensure(60_000);
    if (ms !== null) return ms;
    return chainClock.lastReadFailed() ? null : Date.now();
  };
  // `auto` = started by the app (expiry / re-stamp), not by the user: limited to MAX_AUTO_RECHECKS per reviewed offer (each is paid).
  // OFIX1: a source check always reads chain time afresh (one block read) -- the resolver judges open_utc against its own clock.
  const chainNowForCheck = async (): Promise<number | null> => {
    const known = await chainClock.sync();
    if (known) return chainClock.nowMs();
    return chainClock.lastReadFailed() ? null : Date.now();
  };
  // `skewRetry` = this run is the one automatic retry after the resolver called the start time stale (OPEN_UTC_SKEW).
  const runSourceCheck = async (auto = false, skewRetry = false) => {
    if (!offer) return;
    const key = offerKey(offer);
    if (auto && !skewRetry) { // the one skew retry belongs to the run that hit it, not a new paid re-check
      if (autoRechecks.current.key !== key) autoRechecks.current = { key, n: 0 };
      if (recheckDecision(autoRechecks.current.n) === "button") { setSourceCheck("expired"); return; }
      autoRechecks.current.n++;
    }
    const run = ++checkRun.current;
    checkingKey.current = key;
    setSourceCheck("checking");
    setPreflightFail(null);
    setApproval(null);
    const nowMs = await chainNowForCheck();
    if (run !== checkRun.current) return;
    if (nowMs === null) {
      checkingKey.current = null;
      setPreflightFail(plainPreflightFailure("service", []));
      setSourceCheckMsg(null);
      setSourceCheck("failed");
      return;
    }
    const prep = stampForCheck(offerSheet(offer), nowMs, { windowStart: !!offer.restampWindowStart }); // OFIX1: every check re-stamps open_utc to this minute (CFIX1: and an untouched custom "Counts from")
    const requestedAtMono = monotonicNow();
    try {
      // Freshness is judged by approvalTimeLeftMs (chain + monotonic time), not the device clock: pass null.
      const att = await requestSourceCheck(prep.termsHash, prep.terms, undefined, e2eSourceCheckTimeoutMs() ?? SOURCECHECK_TIMEOUT_MS, null);
      if (run !== checkRun.current) return;
      checkingKey.current = null;
      setApproval({ offerKey: key, sheet: prep.sheet, termsHash: prep.termsHash, attestation: att, requestedAtMono });
      if (!auto) setSourceCheckMsg(null); // an automatic re-check keeps its reason on screen until the next Open press
      setSourceCheck("ok");
    } catch (err) {
      if (run !== checkRun.current) return;
      checkingKey.current = null;
      // OFIX1: the start time went stale between stamping and the resolver's clock: re-stamp (fresh chain read) and try once more.
      if (!skewRetry && err instanceof SourceCheckFailedError && termsCode(err.sources) === "OPEN_UTC_SKEW") { void runSourceCheck(auto, true); return; }
      if (err instanceof SourceCheckFailedError) setPreflightFail(plainPreflightFailure(err.kind, err.sources, err.rateLimit, err.workerReason));
      else setPreflightFail(plainPreflightFailure("service", []));
      setSourceCheckMsg(null);
      setSourceCheck("failed");
    }
  };
  // REVIEW1 (#2): a different offer drops the approval and any check still running for the old one.
  const dropApprovalUnlessFor = (o: StructuredOffer) => {
    const key = offerKey(o);
    if (approvalFor(approval, o)) return;
    if (sourceCheck === "checking" && checkingKey.current === key) return;
    checkRun.current++;
    checkingKey.current = null;
    setApproval(null); setSourceCheck("idle"); setPreflightFail(null); setSourceCheckMsg(null);
  };
  // FE15: copy an old bet's terms into a fresh create form. Nothing live is kept: the preflight, attestation, stamp and any result are reset,
  // so the normal flow runs again. Returns a plain error sentence, or null once the form is showing.
  const startDuplicate = (bet: Bet | null): string | null => {
    const r = duplicateDraft(bet, { me: nearAddress, nowMs: Date.now() });
    if (!r.ok) return r.message;
    const c: DuplicateCopy = r.copy;
    checkRun.current++;
    setShared(null); setOffer(null); setSourceCheck("idle"); setPreflightFail(null); setSourceCheckMsg(null); setApproval(null); setOpenResult(null);
    setCopyInfo({ banner: c.banner, notes: c.notes });
    setCreateDraft(c.draft);
    setCreateKey((k) => k + 1);
    setNewStep("create");
    navigate("/new");
    return null;
  };
  const humanReview = screen === "review" && !!offer && !preflightApplies(refereeAccount(offer.referee));
  // C1: the check runs as soon as the review opens (and again for a different offer; the same offer keeps its approval). AI mode: at
  // most one automatic (paid) check per reviewed offer (lib/createFlow autoCheckOnEnter); human mode: the silent attestation.
  useEffect(() => {
    if (screen !== "review" || !offer) return;
    const key = offerKey(offer);
    const human = !preflightApplies(refereeAccount(offer.referee));
    if (!autoCheckOnEnter({ human, key, triedKeys: autoTried.current, approved: !!approvalFor(approval, offer), checking: sourceCheck === "checking" && checkingKey.current === key })) return;
    if (!human) autoTried.current.add(key);
    void runSourceCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, offer]);
  // REVIEW1 (#10): time left on the approval, from chain + monotonic time (lib/openApproval), re-read twice a second while it is shown.
  const [, setFreshTick] = useState(0);
  useEffect(() => {
    if (screen !== "review" || sourceCheck !== "ok" || !currentApproval) return;
    const t = setInterval(() => setFreshTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [screen, sourceCheck, currentApproval]);
  const approvalLeftMs = currentApproval ? approvalTimeLeftMs(currentApproval, { mono: monotonicNow(), chainMs: chainClock.nowMs() }) : null;
  // Ran out: AI mode asks for a new check (button); human mode re-checks once by itself, then a "Check again" button (never a paid loop).
  useEffect(() => {
    if (sourceCheck !== "ok" || approvalLeftMs !== 0) return;
    setApproval(null);
    if (onApprovalExpired({ human: humanReview, autoRechecksUsed: 0 }) === "auto") void runSourceCheck(true); // runSourceCheck(true) counts the re-checks itself
    else setSourceCheck("expired");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceCheck, approvalLeftMs === 0, humanReview]);
  // Keep the chain clock warm while a bet is being made (one block read every few minutes).
  useEffect(() => {
    if (screen !== "review" && screen !== "create") return;
    void chainClock.ensure();
    const t = setInterval(() => void chainClock.ensure(), 4 * 60_000);
    return () => clearInterval(t);
  }, [screen]);

  // STG1b: rates for the review card's per-side storage lines (immutable per asset; read when a review opens).
  useEffect(() => {
    if (screen !== "review" || !offer) return;
    const ids = [tableAssetId(offer.makerAssetSymbol), tableAssetId(offer.takerAssetSymbol)].filter((x): x is string => !!x);
    setStorageUnavailable(false);
    fetchStorageRates(ids).then((r) => { setStorageRates(r); setStorageUnavailable(unavailableStorageAssets(ids, r).length > 0); }).catch(() => setStorageRates(undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, offer?.makerAssetSymbol, offer?.takerAssetSymbol]);

  useEffect(() => {
    if (!authenticated || !user) {
      const tw = testWallet();
      if (tw) {
        // See the __e2eTestWallet declaration above: mocked e2e specs
        // only, standing in for a real Privy NEAR wallet.
        setNearAddress(tw.nearAddress);
        setStatus("wallet-ready");
      } else {
        setNearAddress(null);
      }
      return;
    }
    const existing = findNearWallet(user as any);
    if (existing) {
      setNearAddress(existing);
      setStatus("wallet-ready");
      return;
    }
    let live = true;
    setStatus("creating-wallet");
    walletSetup.current
      .run({ user: user as any, createWallet: () => createWallet({ chainType: "near" as any }), refreshUser: refreshUser as any })
      .then((addr) => {
        if (!live) return;
        setNearAddress(addr);
        setStatus("wallet-ready");
      })
      .catch((err: any) => live && setStatus("wallet-error: " + String(err?.message ?? err)));
    return () => { live = false; };
  }, [authenticated, user, createWallet, refreshUser, walletTick, walletRetry]);

  const { paused, shutdown } = useContractStatus();
  const online = useOnline();
  const live = useLiveState();
  // FE16b (S18): wrong network, or the contract pins a different resolver than this build -> "This page is out of date. Refresh."
  useEffect(() => {
    let off = false;
    (async () => {
      const [chainId, keys] = await Promise.all([viewChainId(), resolverKeys().catch(() => null)]);
      if (off) return;
      liveState.outOfDate(outOfDateReason(loadReleaseConfig(), { chainId, resolverKeys: keys }) !== null);
    })();
    return () => { off = true; };
  }, []);
  const stale = moneyBlocked({ offline: !online, viewFailed: live.viewFailed, outOfDate: live.outOfDate });

  // FE2 / S1b: first login -> pick a username. No registry configured = no step (nothing to claim against).
  const registryUrl = e2eRegistryUrl() ?? REGISTRY_URL;
  const refRegistry = useMemo(() => (registryUrl ? new HttpUserRegistry(registryUrl) : undefined), [registryUrl]);
  type NameState = "off" | "checking" | "has" | "none" | "down" | "skipped";
  const [nameState, setNameState] = useState<NameState>("off");
  // F3 (SM2 gap F3-1): the claimed name itself, so Account and the nav read it from the app state instead of asking the registry.
  const [username, setUsername] = useState<string | null>(null);
  const [nameRetry, setNameRetry] = useState(0);
  useEffect(() => {
    if (!signedIn || !nearAddress || !registryUrl) { setNameState("off"); return; }
    let live = true;
    setNameState("checking");
    // REVIEW1 (AUTH-2): a lookup that never answers is "down" after 15 s, not "Setting up your account…" forever.
    Promise.race([
      new HttpUserRegistry(registryUrl).byAccount(nearAddress),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("registry lookup timed out")), 15_000)),
    ]).then(
      (u) => { if (!live) return; setUsername(u ? u.username : null); setNameState(u ? "has" : "none"); },
      () => live && setNameState("down"),
    );
    return () => { live = false; };
  }, [signedIn, nearAddress, registryUrl, walletTick, nameRetry]);
  // A1 (SM2 gap A1-2): the first-login "Pick a username" sheet opens by itself over the REAL page (browsing stays open); closing it
  // leaves the user in `none`, and any bet action asks again (G6).
  const [nameModalOpen, setNameModalOpen] = useState(true);
  // SM2: "Pick a username" opened on demand by the gate (a bet action by a user who skipped the step).
  const [namePickOpen, setNamePickOpen] = useState(false);
  // F4: the Add money sheet OVER the current page (create / take / bet page keep their draft), or a deposit's tracker.
  const [addMoney, setAddMoney] = useState<{ path?: string; track?: string } | null>(null);
  useEffect(() => { if (nameState !== "none") setNameModalOpen(true); }, [nameState]);
  const onNameDone = (claimed: boolean, name?: string) => {
    setNamePickOpen(false);
    setNameState(claimed ? "has" : "skipped");
    if (claimed && name) setUsername(name);
    if (!claimed || !nearAddress) return;
    // Empty balance after the first login -> straight to Add money (S1: "a balance of 0 is normal; go to S1c").
    // SM2 gap F4-3: read from F3's balance map (lib/accountBalances), decided by lib/fundSheet.nothingToBetWith.
    loadMoney(nearAddress).then((m) => { if (nothingToBetWith(m.map)) navigate("/account"); }).catch(() => {});
  };


  // SECREV1 SR-3: the app's one signer (the Privy key, or a mocked spec's test wallet). Exposed on window.__e2e only via the seam.
  const appSignRawHash: (address: string, hashHex: string) => Promise<string> =
    testWallet()?.signRawHash ??
    (async (address: string, hashHex: string) => {
      const hash = (hashHex.startsWith("0x") ? hashHex : "0x" + hashHex) as `0x${string}`;
      const { signature } = await signRawHash({ address, chainType: "near", hash });
      return signature;
    });
  setAppSigner(appSignRawHash);
  window.__e2e = {
    ready,
    authenticated,
    nearAddress,
    status,
    ...e2eSignSeam(appSignRawHash),
  };

  // The same storage quote feeds the review card and the Open button's "Put X in escrow" label.
  function reviewStorageNow() {
    if (!offer) return null;
    try {
      const mId = tableAssetId(offer.makerAssetSymbol), tId = tableAssetId(offer.takerAssetSymbol);
      const mA = findAsset(offer.makerAssetSymbol), tA = findAsset(offer.takerAssetSymbol);
      if (!mId || !tId || !mA || !tA || storageRates?.[mId] == null || storageRates?.[tId] == null) return null;
      const sheet = currentApproval?.sheet ?? offerSheet(offer);
      const terms = canonicalTerms(sheet);
      const r = reviewStorage({ terms, termsHash: termsHash(terms), modelsHash: loadReleaseConfig().models_snapshot_hash,
        maker: { symbol: mA.symbol, decimals: mA.decimals, ratePerKib: storageRates[mId] }, taker: { symbol: tA.symbol, decimals: tA.decimals, ratePerKib: storageRates[tId] } });
      return { maker: r.maker.text, taker: r.taker.text, makerUnits: r.maker.units.toString(), takerUnits: r.taker.units.toString() };
    } catch { return null; }
  }
  const payNowLabel = offer ? buildReviewModel(offer, reviewStorageNow()).payNow : null;
  const openProgress = openProgressLine(openBusy, openAction.status);

  // MODAL1c1: the Open handler, unchanged in behaviour; it now answers the FlowModal with the result to show.
  const STAY: FlowResult = { kind: "stay" };
  const openBet = async (): Promise<FlowResult> => {
          if (!nearAddress || !offer) return STAY;
          setOpenResult(null); setOpenShort(null);
          // REVIEW1 (#2): only an approval made for THIS offer can open it; anything else stops here.
          const appr = approvalFor(approval, offer);
          if (!appr) {
            setApproval(null); setSourceCheck("idle");
            setSourceCheckMsg("You changed the bet after it was checked, so it has to be checked again before it can open. Nothing was sent.");
            return STAY;
          }
          // Single source of truth for the asset deposited AND the
          // asset named in the envelope -- handle_open refunds
          // unless token_id === envelope.maker_asset, so these must
          // never diverge (DR-WEB-ASSET-MISMATCH-1).
          const makerAssetId = tableAssetId(offer.makerAssetSymbol);
          const takerAssetId = tableAssetId(offer.takerAssetSymbol);
          // Refuse rather than silently fall back to another asset.
          if (!makerAssetId || !takerAssetId) return STAY;
          // WT1: typed sheet from the form (or a custom sheet built from the structured fields); every hash and
          // deadline is derived in lib/openEnvelope (no stub values), release pins come from lib/release.json.
          // WT1b (b): refuse to open against a contract that pins a different resolver than this build.
          const pinErr = await checkOpenPins(resolverKeys);
          if (pinErr) {
            setSourceCheckMsg(pinErr);
            setSourceCheck("failed");
            return STAY;
          }
          // REVIEW1 (#10): chain time, not the device clock, for the open_utc skew and the deadline checks below.
          const nowMs = await chainNowForOpen();
          if (nowMs === null) { setOpenResult({ kind: "failed", message: "We couldn't read the chain's time, so nothing was sent. Try again in a moment." }); return STAY; }
          // WT1d: BTC open_utc is re-stamped at Open when the review was held past the resolver's skew window. The terms (and so
          // terms_hash and the approval) then change. REVIEW1 (CRT-6): say so in both modes; a person-decides bet re-checks once by itself.
          const gate = approvalGate(offer, appr, nowMs);
          if (!gate.ok) {
            setApproval(null);
            setSourceCheckMsg(gate.message);
            if (gate.kind === "reconfirm" && !preflightApplies(refereeAccount(offer.referee))) void runSourceCheck(true);
            else setSourceCheck("idle");
            return STAY;
          }
          const prepared = gate.prepared;
          setSourceCheckMsg(null);
          const isTypedCustom = !!prepared.sheet && templateId(prepared.sheet).id === "custom" && !!offer.typedSheet;
          let built: Record<string, unknown>;
          try {
            built = buildOpenEnvelope({
              maker: nearAddress,
              sheet: prepared.sheet,
              customDeadlineSecs: offer.typedSheet ? (isTypedCustom ? customDeadlineSecs(prepared.sheet) : undefined) : Math.floor(Date.parse(offer.termSheet.deadlineUtcIso) / 1000),
              makerAsset: makerAssetId,
              takerAsset: takerAssetId,
              stakeMaker: toBaseUnits(offer.makerAssetSymbol, offer.makerAmount),
              stakeTaker: toBaseUnits(offer.takerAssetSymbol, offer.takerAmount),
              takerAccount: offer.takerAccount,
              referee: refereeAccount(offer.referee) ? { account: refereeAccount(offer.referee)!, mode: "Human" } : null,
              tipMaker: !!offer.tipMaker,
              nowMs,
              // REVIEW1 (#2): the deadlines the review card showed were computed at reviewedAtMs; sign exactly those.
              deadlineNowMs: offer.reviewedAtMs ?? nowMs,
              settlementSecs: offer.settlementSecs,
              resolveSecs: offer.resolveSecs,
              offerExpirySecs: offer.offerExpirySecs,
            });
          } catch (err) {
            setSourceCheckMsg(String((err as any)?.message ?? err));
            setSourceCheck("failed");
            return STAY;
          }
          const envelope: any = {
            ...built,
            maker_asset: makerAssetId,
            taker_asset: takerAssetId,
            stake_maker: toBaseUnits(offer.makerAssetSymbol, offer.makerAmount),
            stake_taker: toBaseUnits(offer.takerAssetSymbol, offer.takerAmount),
            referee: built.referee,
          };
          // REVIEW1 (#2): what is signed must be what the review card showed. Any difference stops here (should never happen).
          const drift = signedMatchesReview(envelope, offer, appr, makerAssetId, takerAssetId);
          if (drift.length) {
            setOpenResult({ kind: "failed", message: `What would be signed differs from the review (${drift.join(", ")}). Nothing was sent. Edit the bet and review it again.` });
            return STAY;
          }
          // REVIEW1 (#10, CRT-11): the offer must still be open by chain time when it lands.
          if (closingTooSoon(envelope.funding_deadline, nowMs)) {
            setOpenResult({ kind: "failed", message: "This offer's closing time has already passed. Nothing was sent. Edit the bet to pick a later time." });
            return STAY;
          }
          // STG1b: storage_charge_per_side is "0"; the deposit below is stake + the maker asset's own charge
          // (rate read from the contract's asset table, same formula and byte estimate as the contract).
          const rates = await fetchStorageRates([makerAssetId, takerAssetId]);
          if (rates[makerAssetId] == null) {
            setSourceCheckMsg("Could not read the storage charge for the maker asset from the contract; nothing was sent. Try again.");
            setSourceCheck("failed");
            return STAY;
          }
          // FE2b / S7-S8: the balance must cover "You pay now"; otherwise hand off to Add money with the need.
          const payNow = makerDeposit(envelope, rates[makerAssetId]);
          // FUND1b: say it in the modal (exact amount missing) with an "Add money" action; no silent jump.
          const sh = await fundingShort({ account: nearAddress, symbol: offer.makerAssetSymbol, payNowUnits: BigInt(payNow), returnTo: "/new" });
          if (sh) { setOpenShort(sh); return STAY; }
          // IN1: invite by link -> fresh keypair; only the PUBLIC key goes into the Open msg. The secret stays in this browser.
          let invite: { invitePubkey: string } | null = null;
          if (offer.inviteByLink && !offer.takerAccount) {
            const ik = generateInviteKey();
            saveInviteKey(window.localStorage, ik);
            invite = { invitePubkey: ik.pubkeyHex };
          }
          const msg = buildOpenMsg(envelope, appr.attestation, invite ?? offer.takerAccount, nowMs * 1_000_000);
          // S8: snapshot what the read-back compares against (bet count, and the deposit asset's balance for the refund check).
          const readCount = async () => Number(await viewFunction<number>(ESCROW_CONTRACT_ID, "bet_count", {}));
          const readBalance = async () => BigInt(String((await viewFunction<string>(INTENTS_CONTRACT_ID, "mt_balance_of", { account_id: nearAddress, token_id: makerAssetId })) ?? "0"));
          let beforeCount: number, beforeBalance: bigint;
          try { [beforeCount, beforeBalance] = await Promise.all([readCount(), readBalance()]); }
          catch { setOpenResult({ kind: "failed", message: "We couldn't read the contract, so nothing was sent. Try again." }); return STAY; }
          let declined = false;
          // INTENTS1: real intents.near mt_transfer_call (1 yocto), never the mock-only transfer_with_msg.
          const stake = buildStakeTransfer({ tokenId: makerAssetId, amount: payNow, msg });
          const result = await openAction.run({
            senderId: nearAddress,
            publicKeyHexEd25519: nearAddress,
            receiverId: stake.receiverId,
            methodName: stake.methodName,
            args: stake.args,
            depositYocto: stake.depositYocto,
            gasTgas: stake.gasTgas,
            signRawHash: async (a, h) => {
              try { return await appSignRawHash(a, h); }
              catch (e) { declined = true; throw e; }
            },
          });
          if (declined) { setOpenResult({ kind: "declined", message: DECLINED_MESSAGE }); return STAY; }
          // The relayer only says "sent"; the contract decides afterwards. Success needs get_bet to show the bet.
          setOpenBusy("confirming");
          const t = confirmTiming();
          const outcome: OpenOutcome = await confirmOpen({
            deps: { betCount: readCount, getBet: (id) => getBet(id), balance: readBalance, txLogs: (h) => viewTxLogs(h, nearAddress), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
            maker: nearAddress,
            termsHash: prepared.termsHash,
            before: { count: beforeCount, balance: beforeBalance },
            txHash: result.ok ? result.txHash ?? null : null,
            attempts: result.ok ? t.attempts : Math.min(t.attempts ?? 2, 2),
            delayMs: t.delayMs,
          });
          setOpenBusy(null);
    // C1 (SM2 gap C1-2): the result mapping lives in lib/createFlow (mirrors take's takeFlowResult).
    const r = openFlowResult(outcome, result.ok ? { ok: true, txHash: result.txHash ?? null } : { ok: false, error: result.error ?? null });
    if (r.shared) setShared(r.shared);
    // IDX2: fire-and-forget -- Explore shows the new bet at once (optimistic row) and the indexer re-reads it now, not next sweep.
    if (r.shared) afterOpened(r.shared);
    if (r.result) setOpenResult(r.result);
    return r.flow;
  };

  // MODAL1c1: leaving the create modal (finished, discarded or closed) starts the next one clean.
  const resetCreate = () => { checkRun.current++; autoTried.current = new Set(); setCopyInfo(null); setShared(null); setOffer(null); setCreateDraft(null); setSourceCheck("idle"); setPreflightFail(null); setSourceCheckMsg(null); setApproval(null); checkingKey.current = null; autoRechecks.current = { key: "", n: 0 }; setOpenResult(null); setOpenShort(null); setNewStep("create"); };
  const closeCreate = () => { resetCreate(); navigate("/"); };
  const startCreate = () => {
    try { window.sessionStorage.removeItem("flowdraft:create-bet"); } catch { /* storage blocked */ }
    setCreateDraft(null);
    setCopyInfo(null);
    setCreateKey((k) => k + 1);
    setScreen("create");
    navigate("/new");
  };
  // SM2: the one composed app state (lib/appState). Every action gate below reads it; screens read it through useGate.
  const ctx = appCtx({
    auth: authStateOf({ signedIn, address: nearAddress, status }),
    account: accountStateOf(nameState, !registryUrl),
    username: nameState === "has" ? username : null,
    offline: !online, viewFailed: live.viewFailed, outOfDate: live.outOfDate, paused, shutdown,
    guest: guestFlag,
  });
  const fixes: GateFixes = {
    // GUEST1: a guest's action -> "Log in to bet" on the SAME URL (the flag is cleared; after login the route renders as it was).
    login: () => askLogin(LOGIN_TO_BET_LINE),
    pickUsername: () => { if (nameState === "down") setNameRetry((n) => n + 1); else setNamePickOpen(true); },
    retry: () => {
      if (ctx.auth === "setup-failed") { setStatus("init"); setWalletRetry((n) => n + 1); }
      else if (ctx.outOfDate) window.location.reload();
      else if (ctx.account === "unknown") setNameRetry((n) => n + 1);
      else liveState.retryAll();
    },
    addMoney: (path) => toAddMoney(path),
    usernameChanged: (name) => { setNamePickOpen(false); setUsername(name); setNameState("has"); },
  };
  // F4: an /add-money hand-off opens the sheet over the page (mainnet); testnet keeps the Account page (test NEAR + Move).
  function toAddMoney(path: string) { if (isAddMoneyPath(path) && addMoneySheetOn()) setAddMoney({ path }); else navigate(path); }
  const createGate = gate("create", ctx);
  // A1: every shell decision (routes, Log out, the create button, the first-login sheet) from ctx (lib/shell, SM2 gap A1-1).
  const shell = shellView(ctx, createGate);
  const createNeedsName = shell.create.toFix;
  const createDisabled = shell.create.disabled;
  // GUEST1: a guest's Create keeps any saved create draft (no startCreate) and asks for the login on /new.
  const onCreate = () => { if (shell.create.toLogin) { navigate("/new"); fixes.login(); } else if (createNeedsName) fixes[createGate.fix === "retry" ? "retry" : "pickUsername"](); else if (!createDisabled) startCreate(); };
  const loggingOut = useRef(false);
  const doLogout = () => { loggingOut.current = true; setStatus("init"); setNameState("off"); setUsername(null); resetCreate(); void logout(); };
  // A1 (SM2 gap A1-3): the session ended without Log out (Privy flipped `authenticated`): back to the login page, the create draft is
  // kept (its FlowModal draft in sessionStorage and App's createDraft are untouched), and one toast says why.
  const toast = useToast();
  const prevAuth = useRef(ctx.auth);
  useEffect(() => {
    const was = prevAuth.current;
    prevAuth.current = ctx.auth;
    if (sessionEnded(was, ctx.auth, loggingOut.current)) toast({ text: LOGGED_OUT_TOAST, tone: "info" });
    if (ctx.auth === "logged-out") { setStatus("init"); setNameState("off"); setUsername(null); loggingOut.current = false; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.auth]);

  // LOGIN1 (UX-29): logged out, the app is ONLY the login page -- no nav, landing, bet lists or overlay -- on every route.
  // The URL is untouched, so once signed in the same route (a /bet/<id> deep link, /my-bets, ...) renders. All hooks are above.
  // NAV1: the paused / shut-down banner shows here too, so a logged-out user still reads the refund message.
  // A1 (UIR1 §3.1): the app-state notice sits inside the login card, above the form.
  // TPL3: the "write it with your AI" guide is a public, static page (no nav, no account data), logged in or out.
  // TFIX2: test builds only (lib/testHooks; compiled out of mainnet): a forced render error for the crash-screen specs.
  if (e2eRenderCrash() === "app") throw new Error("e2e render crash (app)");
  if (route.name === "guide") return <GuidePage />;
  // DOCS1: Docs replaced About and are public: logged out they render on their own (slim header, no app nav); logged in, below.
  // GUEST1: logged out WITHOUT the guest flag is still only the login page (with "Browse as guest" below the form); a guest gets the
  // read-only shell below on Home, bets, Docs and not-found, and the login page on /new and /account (those are actions).
  if (route.name === "docs" && shell.loginPage && !loginAsked) return <DocsPage page={route.page} navigate={navigate} loggedOut />;
  if ((shell.loginPage && (routeRequiresLogin(route) || loginAsked)) || (shell.guest && !guestRoute(route))) return (
    <LoginPage line={loginLine ?? loginPageLine(route)}
      onGuest={() => { setLoginLine(null); setLoginAsked(false); setGuest(true); if (!guestRoute(route)) navigate("/"); }}
      notice={<StatusBanner paused={paused} shutdown={shutdown} offline={!online} outOfDate={live.outOfDate} />} />
  );
  // NAV1 (UX-31): Home / About / Account (F3: was Wallet; it shows the user's @username). /new (the create modal) sits over Home.
  // DOCS1: About is now Docs (/docs and its pages).
  const tab: "home" | "docs" | "account" | null = route.name === "home" || route.name === "new" ? "home" : route.name === "docs" ? "docs" : route.name === "account" ? "account" : null;
  const navTab = (id: "home" | "docs" | "account", label: string, to: string) => (
    <Button variant="ghost" data-testid={`nav-${id}`} aria-current={tab === id ? "page" : undefined} className={tab === id ? "nav-tab active" : "nav-tab"} onClick={() => navigate(to)}>{label}</Button>
  );

  return (
    <AppStateProvider ctx={ctx} fixes={fixes}>
    <MoneyStaleContext.Provider value={stale}>
    <div>
      <StatusBanner paused={paused} shutdown={shutdown} offline={!online} busySeconds={live.busySeconds} outOfDate={live.outOfDate} viewFailed={live.viewFailed} />
      <div data-testid="status">{status}</div>
      {shell.setupFailed && (
        <Notice variant="page" tone="bad" data-testid="wallet-error" title={walletErrorMessage(status)}
          action={<Button data-testid="wallet-retry" onClick={fixes.retry}>Try again</Button>} />
      )}
      {shell.registryDown && (
        // one fix per screen: the blocked action's GateNotice carries "Try again" (no second button here)
        <Notice variant="page" tone="warn" data-testid="registry-down-note" title={REGISTRY_DOWN_MESSAGE} />
      )}
      {shell.settingUp && <Notice variant="page" tone="info" data-testid="username-checking" title="Setting up your account…" />}
      <TopNav label="Main" className="app-nav"
        heading={<button type="button" className="brand" data-testid="nav-brand" aria-label="Praetorial, home" onClick={() => navigate("/")}><Brand /></button>}
        endContent={<>
          <Button variant="primary" data-testid="nav-create" onClick={onCreate} disabled={createDisabled}
            {...(createDisabled ? { "aria-describedby": PAGE_NOTICE_ID } : {})}>
            {COPY.navCreate}
          </Button>
          {shell.logout && <Button variant="ghost" data-testid="nav-logout" onClick={doLogout}>Log out</Button>}
          {/* GUEST1: "Log in" instead of Account; it clears the guest flag and shows the login page on this URL. */}
          {shell.guest && <Button variant="secondary" data-testid="nav-login" onClick={() => askLogin(null)}>Log in</Button>}
        </>}>
        {navTab("home", "Home", "/")}
        {navTab("docs", "Docs", "/docs")}
        {!shell.guest && navTab("account", ctx.username ? identityOf({ account: nearAddress ?? "", username: ctx.username, me: nearAddress, selfAsName: true }).label : "Account", "/account")}
      </TopNav>
      <AppNavHeight />
      {shell.guest && <p className="guest-banner" data-testid="guest-banner" role="status">{GUEST_BANNER}</p>}

      {/* NAV1 + F3: the account id, the balances and Log out live on the Account page. */}
      {/* F4: deposits on their way (compact tracker, toasts), on every page; the full tracker opens over the page. */}
      {nearAddress && <FundingWatcher account={nearAddress} hidden={route.name === "account"} onOpen={(id) => setAddMoney({ track: id })} />}
      {addMoney && nearAddress && <FundSheet account={nearAddress} trackId={addMoney.track ?? null} {...(addMoney.path ? parseAddMoneyPath(addMoney.path) : {})} onClose={() => setAddMoney(null)} onGo={(to) => { if (window.location.pathname !== to) navigate(to); }} />}

      {/* A1: ONE username sheet: by itself once on a first login with no name, or on demand (a bet action, the nav's Create). */}
      {nearAddress && registryUrl && shell.namePickable && ((nameState === "none" && nameModalOpen) || namePickOpen) && (
        <UsernameStep registryUrl={registryUrl} account={nearAddress} signRawHash={(a, h) => appSignRawHash(a, h)} onDone={onNameDone}
          onClose={() => { setNameModalOpen(false); setNamePickOpen(false); }} />
      )}
      <>
      {(route.name === "home" || route.name === "new") && (shell.signedIn || shell.guest) && (
        <HomePage me={nearAddress} navigate={navigate} onCreate={onCreate} createDisabled={createDisabled} guest={shell.guest} />
      )}
      {route.name === "docs" && <DocsPage page={route.page} navigate={navigate} loggedOut={false} />}
      {route.name === "account" && shell.ready && nearAddress && (
        <WalletPage account={nearAddress} search={window.location.search} registryUrl={registryUrl} signRawHash={(a, h) => appSignRawHash(a, h)}
          onBack={navigate} onLogout={authenticated ? doLogout : undefined} />
      )}

      {route.name === "new" && shell.signedIn && shell.create.held && <GateNotice action="create" testId="create-gate" />}
      {route.name === "new" && shell.signedIn && !shell.create.held && (
        <FlowModal
          key={createKey}
          isOpen
          title="Make a bet"
          steps={CREATE_STEPS}
          draftKey="create-bet"
          ownNav
          submitLabel="Open the bet"
          onClose={closeCreate}
          onSubmit={openBet}
          busyNote={openProgress ? <div data-testid="open-progress">{openProgress}</div> : null}
          renderResult={(r) => {
            if (r.phase === "success") return shared ? (
              <ShareScreen
                betId={shared.betId}
                bet={shared.bet}
                wallet={nearAddress ? { nearAddress, signRawHash: appSignRawHash } : null}
                onOpenBet={() => navigate(`/bet/${shared.betId}`)}
                onMakeAnother={() => { resetCreate(); setCreateKey((k) => k + 1); }}
              />
            ) : null;
            if (r.phase === "pending") return openResult ? <div><span data-testid="open-result" data-kind={openResult.kind}>{openResult.message}</span></div> : null;
            return <span data-testid="open-result" data-kind={openResult?.kind ?? "failed"}>{r.reason}</span>;
          }}
          renderStep={(step, api) => (<>
            <StepSync id={step.id as CreateStepId} onStep={(id) => setNewStep(id === "review" ? "review" : "create")} />
            {step.id !== "review" && (
              <CreateBetStep
                api={api}
                fallbackDraft={createDraft}
                onDraft={setCreateDraft}
                makerAccount={nearAddress}
                refereeRegistry={refRegistry}
                copyInfo={copyInfo}
                onSubmit={(o) => { dropApprovalUnlessFor(o); setOffer(o); api.goTo(stepIndexFor("review")); }}
              />
            )}
            {step.id === "review" && !offer && <ResumeToStake api={api} />}
            {step.id === "review" && offer && (() => {
              // C1 (UIR1 §3.4, familiarcow UX-37 #5): five lines + Full terms, the automatic source check as one status line, one primary button.
              const open = openButton({ checkState: sourceCheck, hasAttestation: !!attestation, leftMs: approvalLeftMs, address: nearAddress, gateAllowed: createGate.allowed,
                relay: openAction.status, busy: openBusy, flags: offer.flags.length, payNow: payNowLabel });
              return (
              <div className="k-stack" data-testid="review-step">
                <ReviewCard offer={offer} storage={reviewStorageNow()} storageUnavailable={storageUnavailable} />
                {preflightApplies(refereeAccount(offer.referee)) ? (
                  <SourcePreflight
                    state={sourceCheck}
                    failure={preflightFail}
                    plainMessage={sourceCheckMsg}
                    onFix={() => { setCreateDraft((d) => (d ? { ...d, step: "fill" } : d)); api.goTo(stepIndexFor("fill")); }}
                    onUsePerson={() => { setCreateDraft((d) => (d ? { ...d, step: "resolver" } : d)); api.goTo(stepIndexFor("resolver")); }}
                    leftMs={sourceCheck === "ok" ? approvalLeftMs : null}
                    onCheck={() => void runSourceCheck()}
                  />
                ) : (
                  <HumanNoPreflight failed={sourceCheck === "failed"} failure={preflightFail} onRetry={() => void runSourceCheck()}
                    recheck={sourceCheck === "expired" || (sourceCheck === "idle" && !!sourceCheckMsg)} message={sourceCheckMsg} />
                )}
                {openShort && <ShortNotice short={openShort} onAddMoney={() => toAddMoney(openShort.path)} />}
                {openResult?.kind === "declined" && <Banner status="warning" data-testid="open-result" data-kind="declined" role="alert">{openResult.message}</Banner>}
                <div className="k-actions create-footer" data-testid="review-footer">
                  <Button variant="ghost" data-testid="back-to-create" onClick={() => api.goTo(stepIndexFor("resolver"))}>Back</Button>
                  <Button variant="primary" data-testid="open-offer-btn" disabled={open.disabled} onClick={() => api.submit()}>{open.label}</Button>
                </div>
              </div>
              );
            })()}
          </>)}
        />
      )}

      {/* A1 (UIR1 §3.10): not-found is an EmptyState with the one way out. */}
      {route.name === "not-found" && (
        <EmptyState data-testid="not-found" title="Page not found" body="This link doesn't go anywhere. It may be mistyped or out of date."
          action={<Button data-testid="not-found-home" variant="primary" onClick={() => navigate("/")}>Go to Home</Button>} />
      )}

      {route.name === "bet" && (
        <div data-testid="bet-view">
          {/* A1 (UIR1 §3.11): on a bet page no tab is active, so a back link. */}
          <Button variant="ghost" size="sm" data-testid="bet-back-home" className="bet-back" onClick={() => navigate("/")}>← Home</Button>
          <BetPage
            betId={route.id}
            myAccountId={nearAddress}
            onNeedMoney={toAddMoney}
            onDuplicate={startDuplicate}
            wallet={nearAddress ? { nearAddress, signRawHash: appSignRawHash } : null}
          />
        </div>
      )}
      </>
    </div>
    </MoneyStaleContext.Provider>
    </AppStateProvider>
  );
}
