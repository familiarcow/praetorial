// MODAL1c4: pure helpers for the cancel-offer and change-referee modals. No React.
import test from "node:test";
import assert from "node:assert/strict";
import { cancelOfferTerms, refereeChangeTerms, adminFlowPhase, OFFER_ADMIN_STEPS, OFFER_ADMIN_DRAFT_KEY } from "../lib/offerAdminFlows";

const USDC = "nep141:usdc.testnet";
const bet: any = {
  envelope: { bet_id: 7, maker: "maker.testnet", taker_allow: "Any", outcomes: ["YES", "NO"], maker_side: "YES", maker_asset: USDC, taker_asset: USDC,
    stake_maker: "10000000", stake_taker: "10000000", taker_options: [], fee_bps: 100, funding_deadline: 1e18, resolve_deadline: 2e18, settlement_period: 0,
    referee: { account: "ref.testnet", mode: "Human" }, terms: "{}" },
  status: "Open", taker: null, bonds: [], exhibits: [], outcome: null, storage_maker: "0",
};

test("one confirm step; draft key per kind and bet", () => {
  assert.deepEqual(OFFER_ADMIN_STEPS.map((s) => s.id), ["confirm"]);
  assert.equal(OFFER_ADMIN_DRAFT_KEY("cancel", 7), "offeradmin-cancel-7");
});

test("cancel: what is refunded, to where, and that there is no fee; storage is added exactly, never a float", () => {
  const t = cancelOfferTerms(bet);
  assert.equal(t.refundText, "10 USDC");
  assert.ok(t.lines.some((l) => l.includes("10 USDC") && /Escrow balance/.test(l)));
  assert.ok(t.lines.some((l) => /no fee/i.test(l)));
  const s = cancelOfferTerms({ ...bet, envelope: { ...bet.envelope, stake_maker: "10000000" }, storage_maker: "250000" });
  assert.equal(s.refundText, "10.25 USDC");
  assert.ok(s.lines.some((l) => l.includes("10.25 USDC") && l.includes("10 USDC") && /storage/i.test(l)));
});

test("referee change: maker alone applies at once, no money moves", () => {
  const t = refereeChangeTerms({ bet, mode: "maker-alone", account: "new.testnet", agreeing: false, me: "maker.testnet" });
  assert.equal(t.confirmLabel, "Change referee to new.testnet");
  assert.ok(t.lines.some((l) => l.includes("new.testnet") && l.includes("ref.testnet") && /right away/i.test(l)));
  assert.ok(t.lines.some((l) => /no (bet )?money moves/i.test(l) && /no fee/i.test(l)));
});

test("referee change: switching to the AI says tips are cleared", () => {
  const t = refereeChangeTerms({ bet, mode: "maker-alone", account: null, agreeing: false, me: "maker.testnet" });
  assert.equal(t.confirmLabel, "Switch to the AI");
  assert.ok(t.lines.some((l) => /AI/.test(l) && /right away/i.test(l)));
  assert.ok(t.lines.some((l) => /tip/i.test(l)));
});

test("referee change: a proposal changes nothing until the other side proposes the same; agreeing is immediate", () => {
  const taken = { ...bet, status: "Taken", taker: "taker.testnet" };
  const p = refereeChangeTerms({ bet: taken, mode: "propose", account: "new.testnet", agreeing: false, me: "maker.testnet" });
  assert.equal(p.confirmLabel, "Propose new.testnet");
  assert.ok(p.lines.some((l) => l.includes("taker.testnet") && /nothing changes until/i.test(l)));
  const a = refereeChangeTerms({ bet: taken, mode: "propose", account: "new.testnet", agreeing: true, me: "taker.testnet" });
  assert.equal(a.confirmLabel, "Agree: new.testnet decides");
  assert.ok(a.lines.some((l) => l.includes("maker.testnet") && /already proposed/i.test(l)));
  const ai = refereeChangeTerms({ bet: taken, mode: "propose", account: null, agreeing: false, me: "maker.testnet" });
  assert.equal(ai.confirmLabel, "Propose the AI");
});

test("phases: only what get_bet shows is a success; sent-but-unseen is pending; the rest is a failure", () => {
  for (const k of ["cancelled", "expired", "changed", "proposed"]) assert.equal(adminFlowPhase(k), "success");
  assert.equal(adminFlowPhase("pending"), "pending");
  for (const k of ["taken", "failed", "refused", "declined", "frozen", "x"]) assert.equal(adminFlowPhase(k), "failure");
});
