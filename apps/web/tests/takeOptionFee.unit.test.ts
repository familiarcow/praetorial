// FM1b (D-FEEMIN2): a taker_options choice uses fee_min_taker_options[i] (same index as taker_options[i]) for the protocol
// fee and the tip -- NOT the bet's single fee_min_taker (the primary's). Missing / length-mismatched array => that option is
// refused (no transfer built); the primary is unaffected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { prepareTake, takeChoices, takeTipOffer } from "../lib/takeScreen";
import { feeForSideUnits } from "../lib/escrowAdapter";

const here = dirname(fileURLToPath(import.meta.url));
const USDC = "nep141:usdc.testnet";
const WBTC = "nep141:wbtc.testnet";
const DAI = "nep141:dai.testnet";
const REF = { account: "ref.testnet", mode: "Human" };
const bet = (over: Record<string, any> = {}, env: Record<string, any> = {}): any => ({
  status: "Open", taker: null, storage_rates: new Proxy({}, { get: () => "457" }) as any, // STG1b fixture: ceil(3136*457/2048)=700
  fee_min_taker: "500000", fee_min_taker_options: ["500", "9000"],
  envelope: {
    maker: "maker.testnet", taker_asset: USDC, stake_taker: "10000000", storage_charge_per_side: "700",
    fee_bps: 100, resolve_deadline: 1, referee: REF, taker_allow: "Any",
    taker_options: [{ asset: WBTC, amount: "20000" }, { asset: DAI, amount: "50000" }], ...env,
  },
  ...over,
});
const same = (b: any) => async () => b;

test("option tip/fee use that option's own min (index-aligned), not the bet's primary fee_min_taker", () => {
  const [p, w, d] = takeChoices(bet());
  assert.equal(p.tipUnits, feeForSideUnits(10_000_000n, 500_000n));
  assert.equal(w.tipUnits, feeForSideUnits(20_000n, 500n)); // 1% = 200 -> min 500
  assert.equal(w.tipUnits, 500n);
  assert.equal(d.tipUnits, feeForSideUnits(50_000n, 9000n)); // 1% = 500 -> min 9000
  assert.equal(d.tipUnits, 9000n);
  assert.equal(takeTipOffer(bet(), DAI).tipUnits, 9000n);
});

test("fee+tip<=stake guard is per option using the option's min", () => {
  const b = bet({ fee_min_taker_options: ["500", "30000"] }); // DAI: 2*30000 > 50000
  const [, w, d] = takeChoices(b);
  assert.equal(w.problem, null);
  assert.match(d.problem ?? "", /exceeds the stake/);
});

test("a duplicate-asset option uses the FIRST matching option's index (contract find)", () => {
  const b = bet({ fee_min_taker_options: ["500", "9000", "7"] }, { taker_options: [{ asset: WBTC, amount: "20000" }, { asset: DAI, amount: "50000" }, { asset: WBTC, amount: "99999" }] });
  const cs = takeChoices(b);
  assert.deepEqual(cs.map((c) => c.asset), [USDC, WBTC, DAI]);
  assert.equal(cs[1].tipUnits, 500n);
});

for (const [name, over] of [
  ["field missing", { fee_min_taker_options: undefined }],
  ["array too short", { fee_min_taker_options: ["500"] }],
  ["array too long", { fee_min_taker_options: ["500", "9000", "1"] }],
] as Array<[string, any]>) {
  test(`option refused when ${name}; primary still fine`, async () => {
    const b = bet(over);
    const [p, w] = takeChoices(b);
    assert.equal(p.blocked, null);
    assert.match(w.blocked ?? "", /fee|minimum/i);
    for (const tip of [true, false]) {
      const r = await prepareTake({ betId: 7, shown: b, tip, inviteSig: null, asset: WBTC, readBet: same(b) });
      assert.ok(!r.ok, `tip=${tip}`);
      if (!r.ok) assert.match(r.message, /nothing was sent/i);
    }
    const rp = await prepareTake({ betId: 7, shown: b, tip: true, inviteSig: null, readBet: same(b) });
    assert.ok(rp.ok);
  });
}

test("prepareTake: option with its own min builds the take; option tip violating fee+tip<=stake is refused", async () => {
  const b = bet();
  const r = await prepareTake({ betId: 7, shown: b, tip: true, inviteSig: null, asset: DAI, readBet: same(b) });
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.tokenId, DAI); assert.equal(r.amount, "50700"); }
  const bad = bet({ fee_min_taker_options: ["500", "30000"] });
  const r2 = await prepareTake({ betId: 7, shown: bad, tip: true, inviteSig: null, asset: DAI, readBet: same(bad) });
  assert.ok(!r2.ok);
  if (!r2.ok) assert.match(r2.message, /exceeds the stake/);
});

test("JSON shape: contract Bet struct has fee_min_taker_options and the web Bet type mirrors it", () => {
  const rs = readFileSync(join(here, "../../../contracts/escrow/src/lib.rs"), "utf8");
  const i = rs.indexOf("pub struct Bet {");
  assert.ok(i >= 0);
  const body = rs.slice(i, rs.indexOf("\n}", i));
  assert.match(body, /^\s*pub fee_min_taker_options:\s*Vec<U128>,/m);
  const ad = readFileSync(join(here, "../lib/escrowAdapter.ts"), "utf8");
  assert.match(ad, /fee_min_taker_options\?:\s*string\[\]/);
});
