// Unit tests for the message/arg builders against the CURRENT contract's
// real arg schema (contracts/escrow/src/lib.rs, verified by reading it --
// see lib/escrowAdapter.ts's doc comments for the exact line references).
// Run with: node --test (via tsx) -- no network, no Playwright browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOpenMsg,
  buildTakeMsg,
  buildChallengeMsg,
  buildCancelArgs,
  buildEmergencyRefundArgs,
  makeTakerAllow,
  buildSubmitExhibitsArgs,
  currentDisputeRound,
  isFinalDisputeRound,
  roundLabel,
  appealDeadlineNs,
  appealWindowRemainingMs,
  termSheetSummary,
  TERMS_NOT_AVAILABLE,
  termsClaimText,
  ROUND_WINDOW_NS,
  MAX_DISPUTE_ROUNDS,
  type Bet,
} from "../lib/escrowAdapter";

// Minimal Bet fixture builder -- only the fields the dispute helpers
// above actually read, matching contracts/escrow/src/lib.rs's Bet shape.
function makeBet(overrides: Omit<Partial<Bet>, "envelope"> & { envelope?: Partial<Bet["envelope"]> } = {}): Bet {
  const { envelope: envelopeOverrides, ...rest } = overrides;
  return {
    envelope: {
      bet_id: 1,
      version: 1,
      maker: "alice.testnet",
      terms_hash: "abcdef0123456789abcdef0123456789",
      models_snapshot_hash: "x",
      outcomes: ["YES", "NO"],
      maker_side: "YES",
      maker_asset: "nep141:usdc.testnet",
      taker_asset: "nep141:usdc.testnet",
      stake_maker: "100",
      stake_taker: "100",
      taker_options: [],
      fee_bps: 100,
      reserve_per_side: "0",
      storage_charge_per_side: "0",
      keep_terms: false,
      terms: null,
      run_price: "0",
      max_paid_runs: 3,
      tier: 1,
      arbiter: null,
      arbiter_fee: "0",
      funding_deadline: 0,
      early_settle_outcome: null,
      finality_delay: 0,
      settlement_period: 24 * 3600 * 1_000_000_000,
      resolve_deadline: 0,
      consent_party_controlled: false,
      referee: null,
      ...envelopeOverrides,
    } as Bet["envelope"],
    status: "Open",
    taker: null,
    created_at: 0,
    taken_at: null,
    proposed_at: null,
    outcome: null,
    reserve_remaining: "0",
    bonds: [],
    exhibits: [],
    challenged_by: null,
    window_extension_ns: 0,
    ...rest,
  } as Bet;
}

test("buildOpenMsg: kind=Open, envelope passthrough, taker_allow=Any when no taker named", () => {
  const envelope: any = { bet_id: 1, maker: "alice.testnet", stake_maker: "10000000" };
  const attestation = { checked_at: "1700000000000000000", signature_hex: "aa".repeat(64) };
  const msg = JSON.parse(buildOpenMsg(envelope, attestation, null));
  assert.equal(msg.kind, "Open");
  assert.equal(msg.envelope.taker_allow, "Any");
  assert.equal(msg.envelope.bet_id, 1);
  assert.equal(msg.envelope.maker, "alice.testnet");
});

test("buildOpenMsg: direct challenge locks taker_allow to Account(taker)", () => {
  const envelope: any = { bet_id: 2, maker: "alice.testnet" };
  const attestation = { checked_at: "1700000000000000000", signature_hex: "aa".repeat(64) };
  const msg = JSON.parse(buildOpenMsg(envelope, attestation, "bob.testnet"));
  assert.deepEqual(msg.envelope.taker_allow, { Account: "bob.testnet" });
});

test("makeTakerAllow: trims whitespace, empty/whitespace-only -> Any", () => {
  assert.equal(makeTakerAllow("  "), "Any");
  assert.equal(makeTakerAllow(undefined), "Any");
  assert.equal(makeTakerAllow(null), "Any");
  assert.deepEqual(makeTakerAllow("  bob.testnet  "), { Account: "bob.testnet" });
});

test("buildTakeMsg: kind=Take, bet_id + invite_sig passthrough (null for public offers); RF2 tip=false/referee_ack=null by default (D-REFUI4)", () => {
  const msg = JSON.parse(buildTakeMsg(42, null));
  assert.deepEqual(msg, { kind: "Take", bet_id: 42, invite_sig: null, tip: false, referee_ack: null });
});

test("buildTakeMsg: carries an invite_sig for InvitePubkey-gated offers", () => {
  const msg = JSON.parse(buildTakeMsg(42, "deadbeef"));
  assert.equal(msg.invite_sig, "deadbeef");
});

test("buildChallengeMsg: kind=Bond with bet_id + round (matches g4_lifecycle_matrix.ts::sendBond)", () => {
  const msg = JSON.parse(buildChallengeMsg(7, 1));
  assert.deepEqual(msg, { kind: "Bond", bet_id: 7, round: 1 });
});

test("buildCancelArgs: matches escrow::cancel(bet_id: u64) exactly", () => {
  assert.deepEqual(buildCancelArgs(99), { bet_id: 99 });
});

test("buildEmergencyRefundArgs: matches escrow::emergency_refund(bet_id: u64) exactly", () => {
  assert.deepEqual(buildEmergencyRefundArgs(123), { bet_id: 123 });
});

// 17e: D-SETTLE3 removed mutual_settle
test("mutual_settle is gone from the adapter and the bet page (D-SETTLE3)", async () => {
  const adapter = await import("../lib/escrowAdapter");
  assert.equal((adapter as Record<string, unknown>).buildMutualSettleArgs, undefined);
  const { readFileSync } = await import("node:fs");
  for (const f of ["../src/components/BetPage.tsx", "../src/main.tsx", "../lib/useRelayAction.ts", "../lib/escrowAdapter.ts"]) {
    const txt = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(!/mutual_settle|MutualSettle|mutual-settle|propose-settle/.test(txt), `${f} still references mutual settle`);
  }
});

test("buildSubmitExhibitsArgs: matches escrow::submit_exhibits(bet_id, hashes) exactly", () => {
  assert.deepEqual(buildSubmitExhibitsArgs(7, ["hash1", "hash2"]), { bet_id: 7, hashes: ["hash1", "hash2"] });
});

test("buildSubmitExhibitsArgs: rejects an empty hash list", () => {
  assert.throws(() => buildSubmitExhibitsArgs(7, []));
});

test("currentDisputeRound/isFinalDisputeRound/roundLabel: bonds.length IS the round count (D-AUDIT8)", () => {
  const noDispute = makeBet({ bonds: [] });
  const round1 = makeBet({ bonds: [{ holder: "a", amount: "1", round: 1, pre_challenge_outcome: null, asset: "x" }] });
  const round2 = makeBet({
    bonds: [
      { holder: "a", amount: "1", round: 1, pre_challenge_outcome: null, asset: "x" },
      { holder: "b", amount: "2", round: 2, pre_challenge_outcome: "YES", asset: "x" },
    ],
  });
  assert.equal(currentDisputeRound(noDispute), 0);
  assert.equal(currentDisputeRound(round1), 1);
  assert.equal(currentDisputeRound(round2), 2);
  assert.equal(isFinalDisputeRound(round1), false);
  assert.equal(isFinalDisputeRound(round2), true);
  assert.equal(MAX_DISPUTE_ROUNDS, 2);
  assert.equal(roundLabel(0), "No dispute yet");
  assert.match(roundLabel(1), /Round 1.*Review.*3-model/);
  assert.match(roundLabel(2), /Round 2.*Final appeal.*5-model/);
});

test("appealDeadlineNs: null with no proposal yet; proposed_at + min(settlement_period, 24h) + extension otherwise", () => {
  const noProposal = makeBet({ proposed_at: null });
  assert.equal(appealDeadlineNs(noProposal), null);

  // settlement_period (24h, from fixture default) is already <= ROUND_WINDOW_NS.
  const proposed = makeBet({ proposed_at: 1000 });
  assert.equal(appealDeadlineNs(proposed), 1000 + 24 * 3600 * 1_000_000_000);

  // A settlement_period longer than 24h is capped at ROUND_WINDOW_NS once a round is open.
  const longPeriod = makeBet({
    proposed_at: 1000,
    envelope: { settlement_period: 90 * 24 * 3600 * 1_000_000_000 },
  });
  assert.equal(appealDeadlineNs(longPeriod), 1000 + ROUND_WINDOW_NS);

  // window_extension_ns (one-time 24h bump from a near-deadline amend) adds on top.
  const extended = makeBet({ proposed_at: 1000, window_extension_ns: 500 });
  assert.equal(appealDeadlineNs(extended), 1000 + 24 * 3600 * 1_000_000_000 + 500);
});

test("appealWindowRemainingMs: positive before the deadline, non-positive after, null with no proposal", () => {
  const deadlineNs = 10_000_000_000; // 10s in ns
  const bet = makeBet({ proposed_at: 0, envelope: { settlement_period: deadlineNs } });
  assert.equal(appealWindowRemainingMs(bet, 5_000), 5_000); // 10s deadline, 5s elapsed -> 5s left
  assert.equal(appealWindowRemainingMs(bet, 10_000), 0);
  assert.ok(appealWindowRemainingMs(bet, 15_000)! < 0);
  assert.equal(appealWindowRemainingMs(makeBet({ proposed_at: null })), null);
});

test("termSheetSummary: prefers a parsed claimText from `terms`; never shows a hash (BROWSE1b, UX-27)", () => {
  const withTerms = termSheetSummary({ terms: JSON.stringify({ claimText: "BTC above 100k" }), terms_hash: "deadbeef" });
  assert.equal(withTerms, "BTC above 100k");

  const noTerms = termSheetSummary({ terms: null, terms_hash: "abcdef0123456789abcdef0123456789" });
  assert.equal(noTerms, TERMS_NOT_AVAILABLE);

  const malformedTerms = termSheetSummary({ terms: "not json", terms_hash: "short" });
  assert.equal(malformedTerms, TERMS_NOT_AVAILABLE);

  const blankClaim = termSheetSummary({ terms: JSON.stringify({ claimText: "   " }), terms_hash: "ced822da3f" + "0".repeat(48) + "3548ab" });
  assert.equal(blankClaim, TERMS_NOT_AVAILABLE);
  for (const s of [noTerms, malformedTerms, blankClaim]) assert.doesNotMatch(s, /hash|[0-9a-f]{6,}/i);
  assert.equal(TERMS_NOT_AVAILABLE, "Terms not available");
});

// C1 (D-CONCEDE1): concede(bet_id). Allowed after Taken and before
// Finalized/Settled, maker or taker only; mutual_settle stays removed.
test("buildConcedeArgs: matches escrow::concede(bet_id: u64) exactly", async () => {
  const adapter = (await import("../lib/escrowAdapter")) as Record<string, any>;
  assert.equal(typeof adapter.buildConcedeArgs, "function");
  assert.deepEqual(adapter.buildConcedeArgs(321), { bet_id: 321 });
});

test("canConcede: only maker/taker, only Taken..Rejudge statuses (D-CONCEDE1 / D-PM3)", async () => {
  const adapter = (await import("../lib/escrowAdapter")) as Record<string, any>;
  assert.equal(typeof adapter.canConcede, "function");
  const allowed = ["Taken", "Resolving", "Proposed", "Challenged", "Evidence", "Rejudge"];
  const refused = ["Open", "Finalized", "Settled", "Voided", "Cancelled", "Expired"];
  const maker = "maker.testnet";
  const taker = "taker.testnet";
  for (const status of allowed) {
    const bet = makeBet({ status: status as any, taker, envelope: { maker } });
    assert.equal(adapter.canConcede(bet, maker, false), true, `maker ${status}`);
    assert.equal(adapter.canConcede(bet, taker, false), true, `taker ${status}`);
    assert.equal(adapter.canConcede(bet, "stranger.testnet", false), false, `stranger ${status}`);
    assert.equal(adapter.canConcede(bet, null, false), false, `anon ${status}`);
    assert.equal(adapter.canConcede(bet, maker, true), false, `contract closed ${status}`);
  }
  for (const status of refused) {
    const bet = makeBet({ status: status as any, taker, envelope: { maker } });
    assert.equal(adapter.canConcede(bet, maker, false), false, `maker ${status}`);
    assert.equal(adapter.canConcede(bet, taker, false), false, `taker ${status}`);
  }
});

// ---- G5F / D-FEEMIN1: per-side fee = min(stake, max(1% of stake, asset minimum)) ----
test("feeForSideUnits: $10 side pays the 500_000 minimum, $100 pays 1%, $50 boundary pays exactly 500_000", async () => {
  const { feeForSideUnits } = (await import("../lib/escrowAdapter")) as Record<string, any>;
  assert.equal(feeForSideUnits(10_000_000n, 500_000n), 500_000n);
  assert.equal(feeForSideUnits(100_000_000n, 500_000n), 1_000_000n);
  assert.equal(feeForSideUnits(50_000_000n, 500_000n), 500_000n);
  assert.equal(feeForSideUnits(49_990_000n, 500_000n), 500_000n);
  assert.equal(feeForSideUnits(300n, 500_000n), 300n, "never exceeds the stake");
});

test("feeForSideHuman: reads each side's own asset minimum from the asset table", async () => {
  const { feeForSideHuman } = (await import("../lib/escrowAdapter")) as Record<string, any>;
  assert.equal(feeForSideHuman(10, "USDC"), 0.5);
  assert.equal(feeForSideHuman(100, "USDC"), 1);
  assert.equal(feeForSideHuman(50, "USDT"), 0.5);
});

test("review card fee line shows max(1%, minimum) per side, not a flat 1% of pot", async () => {
  const { readFileSync } = await import("node:fs");
  // C1: the review card renders lib/reviewCard.ts, which computes the fee (units, the contract's side_fee mirror)
  const txt = readFileSync(new URL("../lib/reviewCard.ts", import.meta.url), "utf8");
  assert.ok(txt.includes("feeForSideUnits"), "the review model must use the per-side minimum-aware fee");
  assert.ok(!txt.includes("feeOnPot"), "the review model must not use the flat 1%-of-pot helper");
  assert.ok(!readFileSync(new URL("../src/components/ReviewCard.tsx", import.meta.url), "utf8").includes("feeOnPot"));
});

// WT1c: the contract's SourceCheckAttestation.checked_at is a u64 -- a JSON NUMBER. The web emitted a JSON string,
// so the escrow's serde parse failed and the deposit was silently refunded (testnet, tx 9H6eA3Wu...).
test("WT1c buildOpenMsg: attestation.checked_at is a JSON number with full u64 precision, not a string", () => {
  const envelope: any = { bet_id: 1, maker: "alice.testnet", stake_maker: "10000000" };
  const att = { checked_at: "1794111499928612864", signature_hex: "aa".repeat(64) };
  const raw = buildOpenMsg(envelope, att, null);
  assert.ok(raw.includes('"attestation":{"checked_at":1794111499928612864,'), raw.slice(-200));
  assert.equal(JSON.parse(raw).kind, "Open");
  assert.equal(JSON.parse(raw).attestation.signature_hex, att.signature_hex);
});
test("WT1c buildOpenMsg: refuses a non-integer checked_at or a non-128-hex signature", () => {
  const envelope: any = { bet_id: 1, maker: "alice.testnet" };
  assert.throws(() => buildOpenMsg(envelope, { checked_at: "12.5", signature_hex: "aa".repeat(64) }, null), /checked_at/);
  assert.throws(() => buildOpenMsg(envelope, { checked_at: "1", signature_hex: "zz" }, null), /signature_hex/);
});

test("termsClaimText (BROWSE1b): the claim text, or null -- never a hash", () => {
  assert.equal(termsClaimText({ terms: JSON.stringify({ claimText: "BTC above 100k" }), terms_hash: "deadbeef" }), "BTC above 100k");
  assert.equal(termsClaimText({ terms: null, terms_hash: "abcdef0123456789abcdef0123456789" }), null);
  assert.equal(termsClaimText({ terms: "not json", terms_hash: "short" }), null);
  assert.equal(termsClaimText({ terms: JSON.stringify({ claimText: "  " }), terms_hash: "x" }), null);
});
