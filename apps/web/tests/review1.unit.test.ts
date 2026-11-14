// REVIEW1: freeze what the user reviewed. Suite versions of the SM1 scratch tests (spikes/sm1/tests/crt_create.test.ts,
// auth_stickyViewFailed.test.ts) plus the pure parts of each fix. Each test asserts the DESIRED behaviour.
//  #2  (CRT-1)  an edit after the source check must re-check; what is signed == what was reviewed
//  #3  (CRT-5)  the take race guard reports what changed (the modal compares against its snapshot: tests/take-bet-modal.spec.ts)
//  #10 (CRT-4/6/11) approval age and deadlines from chain + monotonic time, never the device clock; at most one automatic re-check
//  #8  (AUTH-1) a failed one-shot read recovers by itself; a "connection problem, retrying" banner while it does
//  LIFE-11      the concede modal re-reads the bet and stops if it changed
//  AUTH-2       Log out is reachable before the wallet / username are ready
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { offerKey, approvalFor, approvalGate, approvalTimeLeftMs, signedMatchesReview, recheckDecision, APPROVAL_SAFETY_MS, MAX_AUTO_RECHECKS, type Approval } from "../lib/openApproval";
import { createChainClock } from "../lib/chainClock";
import { buildOpenEnvelope } from "../lib/openEnvelope";
import { canonicalTerms, termsHash, eventTimes } from "../lib/templates";
import { toBaseUnits } from "../lib/assets";
import { fundingDeadlineSecs } from "../lib/offerExpiry";
import { requestSourceCheck, SOURCECHECK_FRESHNESS_NS } from "../lib/sourceCheckClient";
import { raceGuard } from "../lib/takeView";
import { concedeGuard } from "../lib/liveBet";
import { shellView } from "../lib/shell";
import { appCtx, gate } from "../lib/appState";
import { globalBanners, moneyBlocked, COPY } from "../lib/globalStates";
import { liveState } from "../lib/liveState";
import { viewChainId, viewFunction } from "../lib/rpc";
import { AI_CHOICE } from "../lib/referee";
import type { StructuredOffer } from "../src/components/ReviewCard";

const here = dirname(fileURLToPath(import.meta.url));
const cases: any[] = JSON.parse(readFileSync(join(here, "../../../resolver/core/tests/fixtures/template_cases.json"), "utf8"));
const NOW = Date.parse("2026-11-07T12:00:00Z");
const nws = (x_f: number) => ({ ...cases.find((c) => c.name === "nws_ok")!.ts, fields: { ...cases.find((c) => c.name === "nws_ok")!.ts.fields, x_f } });
const HOUR = 3_600_000;

function offerFor(sheet: any, over: Partial<StructuredOffer> = {}): StructuredOffer {
  const close = eventTimes(sheet).closeSecs; // same as CreateOffer
  const closes = fundingDeadlineSecs({ latestSecs: close, nowSecs: Math.floor(NOW / 1000), expirySecs: 86400 });
  return {
    termSheet: { claimText: "", sources: [], deadlineUtcIso: "" } as any, typedSheet: sheet, claimText: `High >= ${sheet.fields.x_f}F`, sources: ["NWS"], deadlineLabel: "",
    makerAssetSymbol: "USDC", makerAmount: 10, takerAssetSymbol: "USDC", takerAmount: 10, odds: 1, settlementPeriodLabel: "24h", settlementSecs: 24 * 3600,
    takerOptions: [], referee: AI_CHOICE, takerAccount: null, flags: [], priceWarning: null, customVenueNotes: [],
    offerExpirySecs: 86400, reviewedAtMs: NOW, offerClosesAtSecs: closes.secs, ...over,
  } as StructuredOffer;
}
function approvalFor0(offer: StructuredOffer, over: Partial<Approval> = {}): Approval {
  const sheet = offer.typedSheet;
  const terms = canonicalTerms(sheet);
  return { offerKey: offerKey(offer), sheet, termsHash: termsHash(terms), attestation: { checked_at: String(BigInt(NOW) * 1_000_000n), signature_hex: "33".repeat(64) }, requestedAtMono: 0, ...over };
}
const envelopeFor = (offer: StructuredOffer, appr: Approval, nowMs: number) => {
  const built: any = buildOpenEnvelope({
    maker: "me.testnet", sheet: appr.sheet, makerAsset: "nep141:usdc.testnet", takerAsset: "nep141:usdc.testnet",
    stakeMaker: toBaseUnits(offer.makerAssetSymbol, offer.makerAmount), stakeTaker: toBaseUnits(offer.takerAssetSymbol, offer.takerAmount),
    takerAccount: null, referee: null, nowMs, deadlineNowMs: offer.reviewedAtMs, settlementSecs: offer.settlementSecs, offerExpirySecs: offer.offerExpirySecs,
  });
  return built;
};

// ---- #2 (CRT-1) ----
test("#2 CRT-1: editing the offer after the source check invalidates the approval (Open must re-check)", () => {
  const checked = offerFor(nws(72));
  const appr = approvalFor0(checked);
  const edited = offerFor(nws(80));
  assert.notEqual(offerKey(edited), offerKey(checked));
  assert.equal(approvalFor(appr, edited), null, "an approval for the old offer is not an approval for the edited one");
  const g = approvalGate(edited, appr, NOW);
  assert.equal(g.ok, false);
  assert.equal((g as any).kind, "edited");
});

test("#2 CRT-1: stakes, referee, taker, tip and windows are part of what the approval is bound to", () => {
  const base = offerFor(nws(72));
  const k = offerKey(base);
  for (const over of [{ makerAmount: 11 }, { takerAmount: 9 }, { referee: { mode: "human", referee: "ref.testnet" } }, { takerAccount: "x.testnet" }, { tipMaker: true }, { offerExpirySecs: 7 * 86400 }, { settlementSecs: 3600 }, { inviteByLink: true }] as Partial<StructuredOffer>[]) {
    assert.notEqual(offerKey(offerFor(nws(72), over)), k, JSON.stringify(over));
  }
  // Display-only labels and the moment the review was rendered are not.
  assert.equal(offerKey(offerFor(nws(72), { claimText: "other words", reviewedAtMs: NOW + 5000, offerClosesLabel: "x" })), k);
});

test("#2 CRT-1: the same offer re-reviewed keeps its approval; signed args == reviewed args", () => {
  const offer = offerFor(nws(72));
  const appr = approvalFor0(offer);
  assert.equal(approvalFor(appr, offerFor(nws(72))), appr);
  const g = approvalGate(offer, appr, NOW + 10 * 60_000);
  assert.equal(g.ok, true);
  // The review was held 10 minutes; the closing time signed is still the one the review card showed (CRT-11).
  const env = envelopeFor(offer, appr, NOW + 10 * 60_000);
  assert.equal(env.funding_deadline, offer.offerClosesAtSecs! * 1e9);
  assert.equal(env.terms, canonicalTerms(appr.sheet));
  assert.deepEqual(signedMatchesReview(env, offer, appr, "nep141:usdc.testnet", "nep141:usdc.testnet"), []);
});

test("#2 CRT-1: an envelope that differs from the review in terms or stakes is caught before signing", () => {
  const offer = offerFor(nws(72));
  const appr = approvalFor0(offer);
  const env = envelopeFor(offer, appr, NOW);
  const otherTerms = canonicalTerms(nws(80));
  assert.ok(signedMatchesReview({ ...env, terms: otherTerms, terms_hash: termsHash(otherTerms) }, offer, appr, "nep141:usdc.testnet", "nep141:usdc.testnet").includes("terms"));
  assert.ok(signedMatchesReview({ ...env, stake_maker: "1" }, offer, appr, "nep141:usdc.testnet", "nep141:usdc.testnet").includes("your stake"));
  assert.ok(signedMatchesReview({ ...env, funding_deadline: env.funding_deadline + 60e9 }, offer, appr, "nep141:usdc.testnet", "nep141:usdc.testnet").includes("offer closing time"));
});

// ---- #10 (CRT-4, CRT-6, CRT-11) ----
test("#10 CRT-4: an approval whose checked_at is ahead of a device clock that is behind is NOT expired (device clock not used)", () => {
  const appr = approvalFor0(offerFor(nws(72)), { requestedAtMono: 1000 });
  // Chain time = checked_at + 3 s, 4 s of monotonic time since the request. The device clock (any value) is not an input.
  const left = approvalTimeLeftMs(appr, { mono: 5000, chainMs: NOW + 3000 });
  assert.equal(left, Number(SOURCECHECK_FRESHNESS_NS / 1_000_000n) - APPROVAL_SAFETY_MS - 4000);
});

test("#10: age is the larger of chain age and monotonic time since the request; floors at 0", () => {
  const appr = approvalFor0(offerFor(nws(72)), { requestedAtMono: 0 });
  assert.equal(approvalTimeLeftMs(appr, { mono: 1000, chainMs: NOW + HOUR - 10_000 }), 0, "chain says 59:50 old -> inside the safety margin");
  assert.equal(approvalTimeLeftMs(appr, { mono: HOUR, chainMs: null }), 0, "an hour of monotonic time passed");
  assert.ok(approvalTimeLeftMs(appr, { mono: 1000, chainMs: null }) > HOUR - 20_000, "no chain time yet: monotonic bound only");
});

test("#10 CRT-4: requestSourceCheck with nowNs=null accepts an attestation stamped after the device clock's 'now'", async () => {
  const future = String((BigInt(Date.now()) + 600_000n) * 1_000_000n); // device clock 10 min behind the TEE
  (globalThis as any).fetch = async (_u: string, init: any) => {
    const { createHash } = await import("node:crypto");
    const spec_hash = createHash("sha256").update(JSON.parse(init.body).terms).digest("hex");
    return new Response(JSON.stringify({ ok: true, spec_hash, checked_at: future, unreachable: [], signing: { signature_hex: "33".repeat(64) } }), { status: 200 });
  };
  const { createHash } = await import("node:crypto");
  const att = await requestSourceCheck(createHash("sha256").update("t").digest("hex"), "t", "http://x/sc", 1000, null);
  assert.equal(att.checked_at, future);
});

test("#10 CRT-4: no paid re-check loop: one automatic re-check per reviewed offer, then a button", () => {
  assert.equal(MAX_AUTO_RECHECKS, 1);
  assert.equal(recheckDecision(0), "auto");
  assert.equal(recheckDecision(1), "button");
  assert.equal(recheckDecision(5), "button");
});

test("#10 CRT-6: a BTC review held past the open_utc window is refused at the gate with a plain reason (never silently)", () => {
  const btc = cases.find((c) => c.name === "btc_close_ok")!.ts;
  const t0 = Date.parse(btc.fields.open_utc);
  const offer = { ...offerFor(nws(72)), typedSheet: btc } as StructuredOffer;
  const appr = approvalFor0(offer);
  const g = approvalGate(offer, appr, t0 + 5 * 60_000);
  assert.equal(g.ok, false);
  assert.equal((g as any).kind, "reconfirm");
  assert.match((g as any).message, /start time/);
  assert.doesNotMatch((g as any).message, /open_utc|hash/);
});

test("#10: the chain clock moves with monotonic time, not the device clock; unknown until a block is read", async () => {
  let mono = 100;
  let reads = 0;
  const c = createChainClock({ readBlockMs: async () => { reads++; return 1_000_000; }, perfNow: () => mono });
  assert.equal(c.nowMs(), null);
  await c.sync();
  mono += 2500;
  assert.equal(c.nowMs(), 1_002_500);
  await c.ensure(60_000);
  assert.equal(reads, 1, "fresh enough: no second read");
  const failing = createChainClock({ readBlockMs: async () => { throw new Error("down"); }, perfNow: () => 0 });
  assert.equal(await failing.ensure(), null);
  assert.equal(failing.lastReadFailed(), true);
  const noTs = createChainClock({ readBlockMs: async () => null, perfNow: () => 0 });
  assert.equal(await noTs.ensure(), null);
  assert.equal(noTs.lastReadFailed(), false);
});

// ---- #3 (CRT-5) ----
const env = (ref: string | null) => ({ referee: ref ? { account: ref, mode: "Human" } : null, stake_maker: "1", stake_taker: "1", maker_asset: "a", taker_asset: "a", taker_options: [], funding_deadline: 1, resolve_deadline: 2, settlement_period: 3, terms_hash: "t", models_snapshot_hash: "m", terms: "x", fee_bps: 100, maker: "mk", maker_side: "YES", taker_allow: "Any" });
test("#3 CRT-5: against the reviewed snapshot, a referee swap is refused and named (old -> new)", () => {
  const reviewed = { envelope: env("alice.near"), status: "Open" } as any;
  const polledAfterAmend = { envelope: env("mallory.near"), status: "Open" } as any;
  const r: any = raceGuard(reviewed, polledAfterAmend);
  assert.equal(r.ok, false);
  assert.deepEqual(r.details, ["Referee: alice.near -> mallory.near"]);
  const toAi: any = raceGuard(reviewed, { envelope: env(null), status: "Open" } as any);
  assert.deepEqual(toAi.details, ["Referee: alice.near -> the AI"]);
});

// ---- LIFE-11 ----
const cbet = (o: any = {}) => ({ envelope: { maker: "mk", referee: null, stake_maker: "1", stake_taker: "1", resolve_deadline: 5 }, status: "Taken", taker: "me", outcome: null, proposed_at: null, bonds: [], window_extension_ns: 0, ...o }) as any;
test("LIFE-11: the concede re-read stops when a ruling landed since the modal opened", () => {
  assert.deepEqual(concedeGuard(cbet(), cbet()), { ok: true });
  const r: any = concedeGuard(cbet(), cbet({ status: "Proposed", outcome: "NO", proposed_at: 9 }));
  assert.equal(r.ok, false);
  assert.match(r.message, /ruling/);
  assert.match(r.message, /Nothing was conceded/);
  assert.equal(concedeGuard(cbet(), null).ok, false);
  assert.equal(concedeGuard(cbet({ status: "Proposed", outcome: "YES", proposed_at: 1 }), cbet({ status: "Challenged", outcome: "YES", proposed_at: 1, bonds: [{}] })).ok, false);
});

// ---- AUTH-2 ----
test("AUTH-2: Log out shows in the shell while the wallet is set up, failed, or the username is being checked (A1: lib/shell)", () => {
  const logout = (p: Parameters<typeof appCtx>[0]) => { const c = appCtx(p); return shellView(c, gate("create", c)).logout; };
  assert.equal(logout({ auth: "setting-up" }), true);
  assert.equal(logout({ auth: "setup-failed" }), true);
  assert.equal(logout({ auth: "ready", account: "checking" }), true);
  assert.equal(logout({ auth: "ready", account: "has" }), false, "ready: the Account page has Log out");
  assert.equal(logout({ auth: "logged-out" }), false);
});

// ---- #8 (AUTH-1) ----
test("#8: while a read is being retried, a 'connection problem, retrying' banner shows (not with offline, which says why)", () => {
  assert.deepEqual(globalBanners({ paused: false, shutdown: false, offline: false, viewFailed: true }).map((b) => b.kind), ["connection"]);
  assert.match(COPY.connection, /Connection problem\. Retrying/);
  assert.deepEqual(globalBanners({ paused: false, shutdown: false, offline: true, viewFailed: true }).map((b) => b.kind), ["offline"]);
});

const okView = (v: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { result: [...new TextEncoder().encode(JSON.stringify(v))] } }), { status: 200 });
async function until(f: () => boolean, ms: number) { const end = Date.now() + ms; while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 25)); return f(); }

test("#8 AUTH-1: a transient failure of the one-shot startup read does not stick: the app recovers without a reload", async () => {
  liveState.reset();
  liveState.setBackoff({ baseMs: 50, maxMs: 200 });
  let offline = true;
  (globalThis as any).fetch = async (_u: string, init: any) => {
    if (offline) throw new TypeError("Failed to fetch");
    const body = JSON.parse(init.body);
    if (body.method === "status") return new Response(JSON.stringify({ result: { chain_id: "mainnet" } }), { status: 200 });
    return okView(false);
  };
  assert.equal(await viewChainId(), null); // App's one-shot read at load, network blip (after its own quick retries)
  assert.equal(liveState.get().viewFailed, true);
  offline = false;
  assert.equal(await viewFunction("bets.praetorial.near", "is_paused", {}), false);
  assert.ok(await until(() => liveState.get().viewFailed === false, 3000), "recovered by itself");
  const s = liveState.get();
  assert.equal(moneyBlocked({ offline: false, viewFailed: s.viewFailed, outOfDate: s.outOfDate }), false);
});

test("#8: a failed read keeps being retried with backoff even when nothing else is read, and clears once it answers", async () => {
  liveState.reset();
  liveState.setBackoff({ baseMs: 50, maxMs: 200 });
  let calls = 0;
  let up = false;
  (globalThis as any).fetch = async () => { calls++; if (!up) throw new TypeError("Failed to fetch"); return okView(7); };
  await assert.rejects(viewFunction("bets.praetorial.near", "bet_count", {}));
  assert.equal(liveState.get().viewFailed, true);
  const before = calls;
  assert.ok(await until(() => calls > before, 3000), "retried in the background");
  up = true;
  assert.ok(await until(() => liveState.get().viewFailed === false, 5000), "cleared once the read answered");
});

test("#8: a read error the RPC answers (unknown account) is an answer, not a connection problem", async () => {
  liveState.reset();
  (globalThis as any).fetch = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } }), { status: 200 });
  await assert.rejects(viewFunction("nobody.near", "x", {}), /UNKNOWN_ACCOUNT/);
  assert.equal(liveState.get().viewFailed, false);
});
