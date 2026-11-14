// MODAL1c3: pure helpers for the resolution flow modals (request result, challenge, concede, referee ruling). No React.
import test from "node:test";
import assert from "node:assert/strict";
import { requestResultTerms, challengeTerms, concedeTerms, ruleTerms, RESOLUTION_STEPS, flowPhase } from "../lib/resolutionFlows";

const USDC = "nep141:usdc.testnet";
const bet: any = {
  envelope: { bet_id: 7, maker: "maker.testnet", taker_allow: "Any", outcomes: ["YES", "NO"], maker_side: "YES", maker_asset: USDC, taker_asset: USDC,
    stake_maker: "10000000", stake_taker: "10000000", taker_options: [], fee_bps: 100, funding_deadline: 1e18, resolve_deadline: 2e18, settlement_period: 0,
    referee: { account: "ref.testnet", mode: "Human" }, terms: "{}" },
  status: "Taken", taker: "taker.testnet", bonds: [], exhibits: [], outcome: null, fee_min_maker: "500000", fee_min_taker: "500000", tip_maker: "0", tip_taker: "0",
};

test("one confirm step for every resolution flow", () => {
  assert.deepEqual(RESOLUTION_STEPS.map((s) => s.id), ["confirm"]);
});

test("request result: the exact NEAR deposit, the asset and the refund rule, from the contract numbers", () => {
  const t = requestResultTerms({ ...bet, envelope: { ...bet.envelope, referee: null } });
  assert.equal(t.depositYocto >= 20_062_500_000_000_000_000_000n, true);
  assert.match(t.nearText, /^\d+(\.\d+)? NEAR$/);
  assert.ok(t.lines.some((l) => l.includes(t.nearText) && /from your wallet/i.test(l)));
  assert.ok(t.lines.some((l) => /refunded/i.test(l)));
});

test("challenge: round, bond amount and asset in plain words before the confirm; never a float", () => {
  const t = challengeTerms({ ...bet, bonds: [] }, { amount: "4000000", asset: USDC });
  assert.equal(t.bondText, "4 USDC");
  assert.equal(t.roundLabel, "Round 1: Review");
  assert.ok(t.lines.some((l) => l.includes("4 USDC") && /get it back if you win/i.test(l)));
  assert.equal(challengeTerms({ ...bet, bonds: [{}] }, { amount: "1", asset: USDC }).roundLabel, "Round 2: Final appeal");
});

test("concede: who is paid, the exact payout (pot minus fee), the fee, and that it cannot be undone", () => {
  const t = concedeTerms(bet, "taker.testnet");
  assert.equal(t.winner, "maker.testnet");
  assert.equal(t.payoutText, "19 USDC");
  assert.equal(t.feeText, "1 USDC");
  assert.ok(t.lines.some((l) => l.includes("maker.testnet") && l.includes("19 USDC")));
  assert.ok(t.lines.some((l) => /cannot be undone/i.test(l)));
  assert.ok(t.lines.some((l) => /challenge bonds go back/i.test(l)));
  assert.equal(concedeTerms(bet, "maker.testnet").winner, "taker.testnet");
});

test("referee ruling: same confirm sentence as before, plus payout and fee; VOID refunds with no fee", () => {
  const y = ruleTerms(bet, "YES");
  assert.equal(y.sentence, "You're ruling YES: maker.testnet wins 19 USDC. This pays out immediately and can't be changed or challenged.");
  assert.equal(y.payoutText, "19 USDC"); assert.equal(y.feeText, "1 USDC");
  assert.equal(ruleTerms(bet, "NO").winner, "taker.testnet");
  const v = ruleTerms(bet, "VOID");
  assert.equal(v.winner, null); assert.equal(v.feeText, null);
  assert.match(v.sentence, /both bettors get their stake back/);
});

test("flow phase: only a seen on-chain result is success; pending stays pending; refusals are failures", () => {
  for (const k of ["conceded", "challenged", "ruled", "requested"]) assert.equal(flowPhase(k), "success");
  assert.equal(flowPhase("pending"), "pending");
  for (const k of ["refused", "declined", "failed", "anything-else"]) assert.equal(flowPhase(k), "failure");
});

// ---- M1 (UIR1 §3.6, PEOPLE RULE): every resolution confirm is a ConfirmSheet: KeyValue rows + one risk sentence + a SHORT label
// (the amount is in the body, never the button); people are @usernames / "you", never a raw account id.
import { resolutionSheet } from "../lib/resolutionFlows";
const NAMES = { "maker.testnet": "mia", "taker.testnet": "tom", "ref.testnet": "kim" };
const RAW = /maker\.testnet|taker\.testnet|ref\.testnet/;
const text = (s: { rows: { label: string; value: string }[]; risk: string; confirmLabel: string; sentence?: string | null }) =>
  [...s.rows.flatMap((r) => [r.label, r.value]), s.risk, s.confirmLabel, s.sentence ?? ""].join(" | ");

test("M1 concede sheet: who is paid as @username, exact payout + fee in rows, short 'Concede' label, cannot be undone", () => {
  const s = resolutionSheet.concede(bet, "taker.testnet", NAMES);
  assert.equal(s.confirmLabel, "Concede");
  assert.ok(s.danger);
  const all = text(s);
  assert.doesNotMatch(all, RAW);
  assert.match(all, /@mia/);
  assert.deepEqual(s.rows.map((r) => r.id), ["paid", "fee", "bonds"]);
  assert.match(s.rows[0].value, /19 USDC/);
  assert.match(s.rows[1].value, /1 USDC/);
  assert.match(s.risk, /cannot be undone/i);
});

test("M1 concede sheet: an unnamed winner is 'Unnamed account', never the id", () => {
  const s = resolutionSheet.concede(bet, "taker.testnet", {});
  assert.doesNotMatch(text(s), RAW);
  assert.match(text(s), /Unnamed account/);
});

test("M1 rule sheet: YES names the winner as @username; the referee is 'you'; short 'Confirm YES'; VOID refunds with no fee", () => {
  const y = resolutionSheet.rule(bet, "YES", "ref.testnet", NAMES);
  assert.equal(y.confirmLabel, "Confirm YES");
  assert.doesNotMatch(text(y), RAW);
  assert.equal(y.sentence, "You're ruling YES: @mia wins 19 USDC.");
  assert.match(y.risk, /pays out immediately and can't be changed or challenged/);
  const n = resolutionSheet.rule(bet, "NO", "ref.testnet", NAMES);
  assert.match(n.sentence!, /@tom wins 19 USDC/);
  const v = resolutionSheet.rule(bet, "VOID", "ref.testnet", NAMES);
  assert.equal(v.confirmLabel, "Confirm VOID");
  assert.match(v.sentence!, /both bettors get their stake back/i);
  assert.ok(v.rows.some((r) => /20 USDC/.test(r.value)));
});

test("M1 challenge sheet: round + exact bond in rows, short label 'Post bond & challenge'", () => {
  const s = resolutionSheet.challenge({ ...bet, bonds: [] }, { amount: "4000000", asset: USDC });
  assert.equal(s.confirmLabel, "Post bond & challenge");
  assert.equal(s.title, "Challenge this ruling");
  assert.ok(s.rows.some((r) => r.id === "round" && r.value === "Round 1: Review"));
  assert.ok(s.rows.some((r) => r.id === "bond" && /^4 USDC/.test(r.value)));
  assert.match(text(s), /back if you win/i);
});

test("M1 request-result sheet: the exact NEAR deposit is a row (refund rule), short label 'Request the result'", () => {
  const s = resolutionSheet.requestResult({ ...bet, envelope: { ...bet.envelope, referee: null } });
  assert.equal(s.confirmLabel, "Request the result");
  const dep = s.rows.find((r) => r.id === "deposit")!;
  assert.match(dep.value, /^\d+(\.\d+)? NEAR/);
  assert.match(dep.value, /refunded/);
  assert.match(s.risk, /No bet money moves/);
});

test("M1: no sheet label is longer than 24 characters (nothing cut off on a 375 px phone)", () => {
  const labels = [
    resolutionSheet.concede(bet, "taker.testnet", NAMES).confirmLabel,
    resolutionSheet.rule(bet, "VOID", "ref.testnet", NAMES).confirmLabel,
    resolutionSheet.challenge(bet, { amount: "123456789012", asset: USDC }).confirmLabel,
    resolutionSheet.requestResult(bet).confirmLabel,
  ];
  for (const l of labels) assert.ok(l.length <= 24, l);
});
