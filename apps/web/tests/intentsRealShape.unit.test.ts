// INTENTS1: every call the web makes to the intents contract (and the NEP-141 deposit into it) must have the shape REAL
// mainnet intents.near accepts -- pinned in fixtures/intents_near/real_abi.json from the deployed source rev + free view
// probes. Before INTENTS1 open/take/challenge used mock-intents' `transfer_with_msg`, which intents.near does not have
// (MethodNotFound): every stake would have failed on mainnet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildStakeTransfer, STAKE_TRANSFER_METHOD } from "../lib/stakeTransfer";
import { buildWithdrawStep } from "../lib/withdraw";
import { buildMoveSteps } from "../lib/moveToBetting";
import { buildOpenMsg, buildTakeMsg, buildChallengeMsg } from "../lib/escrowAdapter";
import { ASSET_TABLE } from "../lib/assets";
import { NETWORKS } from "../lib/network";
import { gasForMethod } from "../lib/relayGas";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");
const REAL = JSON.parse(readFileSync(join(here, "../../../fixtures/intents_near/real_abi.json"), "utf8"));
type Method = { deposit_yocto?: string; args: Record<string, string>; required?: string[] };
const method = (name: string): Method => {
  const m = REAL.methods[name];
  assert.ok(m, `${name} is not a method of real intents.near (absent: ${Object.keys(REAL.absent_methods).join(", ")})`);
  return m;
};
/** args fit the real signature: only real arg names, every required one present, U128 as decimal strings, AccountId without ':' */
function assertRealCall(name: string, args: Record<string, unknown>, depositYocto: string) {
  const m = method(name);
  for (const k of Object.keys(args)) assert.ok(k in m.args, `${name}: arg "${k}" does not exist on real intents.near`);
  for (const k of m.required ?? []) assert.ok(args[k] !== undefined && args[k] !== null, `${name}: missing required arg "${k}"`);
  for (const [k, v] of Object.entries(args)) {
    const t = m.args[k];
    if (t === "U128") assert.match(String(v), /^\d+$/, `${name}.${k} must be a decimal string`), assert.equal(typeof v, "string", `${name}.${k} must be a JSON string`);
    if (t === "AccountId") assert.ok(typeof v === "string" && !v.includes(":"), `${name}.${k} must be a bare account id, got ${v}`);
    if (t === "TokenId") assert.match(String(v), /^nep(141|171|245):/, `${name}.${k} must be a prefixed token id`);
    if (t === "String") assert.equal(typeof v, "string", `${name}.${k} must be a string`);
  }
  assert.equal(depositYocto, m.deposit_yocto ?? "0", `${name}: real intents.near requires a deposit of exactly ${m.deposit_yocto} yocto`);
}

const ESC = NETWORKS.mainnet.escrow, INT = NETWORKS.mainnet.intents;
const ATT = { checked_at: "1794321266769460204", signature_hex: "ab".repeat(64) };

test("the stake transfer (open/take/challenge) is real intents.near mt_transfer_call with 1 yocto, never mock-only transfer_with_msg", () => {
  assert.equal(STAKE_TRANSFER_METHOD, "mt_transfer_call");
  const msgs = [
    buildOpenMsg({ maker: "alice.near" } as any, ATT, null),
    buildTakeMsg(7, null),
    buildChallengeMsg(7, 1),
  ];
  for (const msg of msgs) {
    const c = buildStakeTransfer({ tokenId: "nep141:wrap.near", amount: "3000000000000000000000000", msg, escrow: ESC, intents: INT });
    assert.equal(c.receiverId, "intents.near");
    assert.equal(c.methodName, "mt_transfer_call");
    assert.equal(c.args.receiver_id, ESC);
    assertRealCall(c.methodName, c.args, c.depositYocto);
    assert.ok(c.gasTgas === gasForMethod("mt_transfer_call") && c.gasTgas >= 30 + 15 + 10, "gas covers mt_on_transfer (escrow budget 30) + mt_resolve_transfer (15) + the call itself");
  }
});

test("buildStakeTransfer refuses shapes intents.near would reject (zero / non-decimal amount, unprefixed token)", () => {
  const base = { tokenId: "nep141:wrap.near", amount: "1", msg: "{}", escrow: ESC, intents: INT };
  assert.throws(() => buildStakeTransfer({ ...base, amount: "0" }));
  assert.throws(() => buildStakeTransfer({ ...base, amount: "1.5" }));
  assert.throws(() => buildStakeTransfer({ ...base, tokenId: "wrap.near" }));
  assert.throws(() => buildStakeTransfer({ ...base, msg: undefined as any }));
});

test("ft_withdraw matches real intents.near (bare token AccountId, 1 yocto)", () => {
  for (const symbol of ["USDC", "NEAR", "USDT"]) {
    const s = buildWithdrawStep({ symbol, account: "alice.near", amountUnits: "1000", network: "mainnet" });
    assert.equal(s.methodName, "ft_withdraw");
    assertRealCall(s.methodName, s.args, s.depositYocto);
  }
});

test("move-to-betting deposit msg is one intents.near's ft_on_transfer parses as the signer (DepositMessage)", () => {
  const steps = buildMoveSteps({ symbol: "NEAR", account: "alice.near", amountUnits: "1500000000000000000000000", source: "native", network: "mainnet" });
  assert.deepEqual(steps.map((s) => [s.receiverId, s.methodName, s.depositYocto]), [["wrap.near", "near_deposit", "1500000000000000000000000"], ["wrap.near", "ft_transfer_call", "1"]]);
  const t = steps[1];
  assert.equal(t.args.receiver_id, "intents.near");
  const msg = String(t.args.msg);
  // real DepositMessage::from_str: '{'-prefixed -> JSON with receiver_id (+ optional execute_intents); else a bare AccountId.
  const parsed = msg.startsWith("{") ? JSON.parse(msg) : { receiver_id: msg };
  assert.equal(parsed.receiver_id, "alice.near");
  for (const k of Object.keys(parsed)) assert.ok(["receiver_id", "execute_intents", "refund_if_fails"].includes(k), k);
});

test("mainnet asset ids are exactly the token ids intents.near holds (mt_supply non-null) with the real decimals", () => {
  for (const [symbol, id] of Object.entries(REAL.token_ids_confirmed)) {
    if (symbol.startsWith("_")) continue;
    const a = ASSET_TABLE.find((x) => x.symbol === symbol);
    assert.ok(a, symbol);
    assert.equal(a!.ids.mainnet, id, symbol);
    assert.equal(a!.decimals, REAL.token_decimals_confirmed[symbol], `${symbol} decimals`);
  }
  assert.equal(NETWORKS.mainnet.intents, REAL.contract);
});

test("no web source calls a method real intents.near does not have (transfer_with_msg / near_deposit_and_credit / mint)", () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f)) files.push(p); } };
  walk(join(web, "lib")); walk(join(web, "src"));
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of Object.keys(REAL.absent_methods)) if (new RegExp(`methodName:\\s*["'\`]${m}["'\`]`).test(src)) offenders.push(`${f.slice(web.length + 1)}: ${m}`);
  }
  assert.deepEqual(offenders, []);
});
