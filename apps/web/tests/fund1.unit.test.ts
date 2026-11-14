// FUND1: "I can see some NEAR in my account but I can't use it to fund my bet."
// Every state where NEAR is visible but there is no working way to move it, and the plain "what's missing" guide.
import test from "node:test";
import assert from "node:assert/strict";
import { movableReport, movableHoldings, NEAR_SPENDABLE_RESERVE_YOCTO, MIN_NATIVE_MOVE_YOCTO } from "../lib/moveToBetting";
import { fundingGuide } from "../lib/fundingGuide";

const NEAR = 10n ** 24n;
const near = (s: string) => BigInt(Math.round(Number(s) * 1e6)) * 10n ** 18n;
const ME = "03c105e3c8dc8eccd940900a70fe34350a17fd72974289642e39c70e7168a5b5";

const view = (o: { wnear?: bigint; usdc?: bigint | "throw" } = {}) => async (c: string, _m: string) => {
  if (c === "usdc.testnet") { if (o.usdc === "throw") throw new Error('{"cause":{"name":"CONTRACT_EXECUTION_ERROR"}}'); return String(o.usdc ?? 0n); }
  if (c === "wrap.testnet") return String(o.wnear ?? 0n);
  throw new Error("unexpected contract " + c);
};

test("0.5 / 2 / 10 NEAR in the account: the whole amount above the 0.05 reserve is movable", async () => {
  for (const [have, move] of [["0.5", "0.45"], ["2", "1.95"], ["10", "9.95"]] as const) {
    const h = await movableHoldings(ME, "testnet", view(), async () => near(have));
    assert.deepEqual(h, [{ symbol: "NEAR", source: "native", amountUnits: near(move).toString() }], `${have} NEAR`);
  }
});

test("wNEAR only: movable as a token holding", async () => {
  const h = await movableHoldings(ME, "testnet", view({ wnear: near("1.5") }), async () => null);
  assert.deepEqual(h, [{ symbol: "NEAR", source: "token", amountUnits: near("1.5").toString() }]);
});

test("ROOT CAUSE 1: a failed USDC read must not hide the NEAR the user can see", async () => {
  const h = await movableHoldings(ME, "testnet", view({ usdc: "throw" }), async () => near("2"));
  assert.equal(h.length, 1);
  assert.equal(h[0].symbol, "NEAR");
  const r = await movableReport(ME, "testnet", view({ usdc: "throw" }), async () => near("2"));
  assert.deepEqual(r.readFailed, ["USDC"]);
});

test("ROOT CAUSE 1b: a failed NEAR balance read is reported (section says so), not silently empty", async () => {
  const r = await movableReport(ME, "testnet", view(), async () => { throw new Error("rpc down"); });
  assert.equal(r.native.state, "unreadable");
  assert.deepEqual(r.holdings, []);
  assert.ok(r.readFailed.includes("NEAR"));
});

test("ROOT CAUSE 2: NEAR visible but too small to move (<= reserve, or dust above it) is reported with the reason", async () => {
  const under = await movableReport(ME, "testnet", view(), async () => near("0.04"));
  assert.equal(under.native.state, "too-small");
  assert.deepEqual(under.holdings, []);
  const dust = await movableReport(ME, "testnet", view(), async () => NEAR_SPENDABLE_RESERVE_YOCTO + 1_000_000_000_000_000_000_000n); // +0.001 (< wrap's 0.00125 fee)
  assert.equal(dust.native.state, "too-small");
  const edge = await movableReport(ME, "testnet", view(), async () => NEAR_SPENDABLE_RESERVE_YOCTO + MIN_NATIVE_MOVE_YOCTO);
  assert.equal(edge.native.state, "ok");
  assert.equal(edge.holdings.length, 1);
});

test("empty / not-yet-created account is 'empty'", async () => {
  assert.equal((await movableReport(ME, "testnet", view(), async () => null)).native.state, "empty");
  assert.equal((await movableReport(ME, "testnet", view(), async () => 0n)).native.state, "empty");
});

const rep = async (have: bigint | null, wnear = 0n) => movableReport(ME, "testnet", view({ wnear }), async () => have);

test("guide: nothing to move, empty wallet, testnet -> exact missing amount + Get test NEAR", async () => {
  const g = fundingGuide({ need: { symbol: "NEAR", amount: "3" }, balanceUnits: "0", report: await rep(null), network: "testnet" });
  assert.equal(g.missingText, "3 NEAR");
  assert.equal(g.showFaucet, true);
  assert.match(g.headline, /You need 3 NEAR more/);
});

test("guide: 2 NEAR in wallet, bet needs 3 -> move 1.95, then still 1.05 missing; faucet offered (can't cover)", async () => {
  const g = fundingGuide({ need: { symbol: "NEAR", amount: "3" }, balanceUnits: "0", report: await rep(near("2")), network: "testnet" });
  assert.equal(g.missingText, "3 NEAR");
  assert.equal(g.afterMoveMissingText, "1.05 NEAR");
  assert.equal(g.coveredByMoving, false);
  assert.equal(g.showFaucet, true);
});

test("guide: 10 NEAR in wallet covers a 3 NEAR need by moving; no faucet", async () => {
  const g = fundingGuide({ need: { symbol: "NEAR", amount: "3" }, balanceUnits: "0", report: await rep(near("10")), network: "testnet" });
  assert.equal(g.coveredByMoving, true);
  assert.equal(g.afterMoveMissingText, null);
  assert.equal(g.showFaucet, false);
});

test("guide: balance already covers -> nothing missing", async () => {
  const g = fundingGuide({ need: { symbol: "NEAR", amount: "3" }, balanceUnits: near("3").toString(), report: await rep(null), network: "testnet" });
  assert.equal(g.missingText, null);
  assert.match(g.headline, /enough/);
});

test("guide: mainnet never shows the test faucet", async () => {
  const g = fundingGuide({ need: { symbol: "NEAR", amount: "3" }, balanceUnits: "0", report: await rep(null), network: "mainnet" });
  assert.equal(g.showFaucet, false);
});

test("guide: NEAR visible but too small -> plain reason line", async () => {
  const g = fundingGuide({ need: { symbol: "NEAR", amount: "3" }, balanceUnits: "0", report: await rep(near("0.04")), network: "testnet" });
  assert.match(g.notes.join(" "), /0\.05 NEAR stays in your NEAR account/);
  assert.equal(g.showFaucet, true);
});

test("guide: need is USDC but the user only holds NEAR -> says NEAR can't pay a USDC bet (no silent mismatch)", async () => {
  const g = fundingGuide({ need: { symbol: "USDC", amount: "5" }, balanceUnits: "0", report: await rep(near("2")), network: "testnet" });
  assert.equal(g.missingText, "5.00 USDC");
  assert.equal(g.coveredByMoving, false);
  assert.match(g.notes.join(" "), /NEAR can't be used for a USDC bet/);
});
