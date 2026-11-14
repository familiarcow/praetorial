// RC1: release-args generator. The escrow is not upgradeable (D-UPGRADE1): new() args are generated and
// checked by code. Spec: "Mainnet release config draft" sections 1, 3.1, 3.2. All keys/hashes here are fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate, validateArgs, ReleaseError, type ReleaseInput } from "../src/gen.js";

const here = dirname(fileURLToPath(import.meta.url));
const TESTS_RS = readFileSync(join(here, "..", "..", "..", "contracts", "escrow", "src", "tests.rs"), "utf8");

const NOW = 1_800_000_000_000; // injected clock (ms)
const MIN = 60_000;
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDT = "nep141:usdt.tether-token.near";
const BTC = "nep141:btc.omft.near";
const WNEAR = "nep141:wrap.near";
const ETH = "nep141:eth.omft.near";
const ZEC = "nep141:zec.omft.near";

const vol = (token_id: string, decimals: number, price: string, over: Record<string, unknown> = {}) => ({
  token_id, decimals, kind: "volatile" as const, price_usd: price, price_ts_ms: NOW - 5 * MIN,
  second_price_usd: price, second_price_ts_ms: NOW - 6 * MIN, ...over,
});
const stable = (token_id: string) => ({ token_id, decimals: 6, kind: "stable" as const });

function input(over: Partial<ReleaseInput> = {}): ReleaseInput {
  return {
    network: "mainnet",
    intents: "intents.near",
    usdc_token_id: USDC,
    outlayer: "outlayer.fake.near",
    operator: "operator.fake.near",
    guardian: "praetorial.near",
    registry: "registry.fake.near",
    fee_account: "fee.fake.near",
    keeper: "keeper.fake.near",
    max_offer_ttl_secs: 5_184_000,
    // STG1b: deploy-day NEAR price (two sources) for storage_per_kib
    near_price: { price_usd: "3.68", price_ts_ms: NOW - 5 * MIN, second_price_usd: "3.68", second_price_ts_ms: NOW - 6 * MIN },
    outcome_pubkey: "a1".repeat(32),
    attest_pubkey: "b2".repeat(32),
    resolver_wasm_hash: "c3".repeat(32),
    outlayer_config: {
      wasm_base_url: "https://fastfs.fake.example/uploader.near/outlayer.near",
      secrets_profile: "praetorial-resolver",
      secrets_account_id: "secrets.fake.near",
    },
    assets: [
      stable(USDC), stable(USDT),
      vol(BTC, 8, "75823"), vol(WNEAR, 24, "3.68"), vol(ETH, 18, "2235.04"), vol(ZEC, 8, "1260.95"),
    ],
    ...over,
  } as ReleaseInput;
}
const gen = (over: Partial<ReleaseInput> = {}, opts: { network?: "mainnet" | "testnet" } = {}) =>
  generate(input(over), { now_ms: NOW, ...opts });
const refuses = (fn: () => unknown, re: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof ReleaseError && re.test(e.message), String(re));
const limitOf = (args: any, id: string) => args.asset_limits.find((p: any) => p[0] === id)[1];

// ---- (a) stables exact, and equal to six_asset_v1_limits() in tests.rs
test("(a) stables are exactly the section 3.1 values", () => {
  const { args } = gen();
  for (const id of [USDC, USDT]) {
    assert.deepEqual(limitOf(args, id), {
      min_per_side: "10000000", max_per_side: "10000000000000000000000000000000000", min_fee_per_side: "500000",
      min_fee_cap_per_side: "2500000", run_price: "5000", min_bond: "5000000", min_objection: "1000000",
      storage_per_kib: "37684", // STG1b: 0.01024 NEAR/KiB at 3.68 USD/NEAR = 0.0376832 USD, rounded up
    });
  }
});

test("(a) stables equal six_asset_v1_limits() in tests.rs (USDC and USDT blocks)", () => {
  const fn = TESTS_RS.slice(TESTS_RS.indexOf("fn six_asset_v1_limits"));
  const grab = (block: string, field: string) => {
    if (field === "max_per_side" && /max_per_side:\s*U128\(cap3::CAP3_MAX\)/.test(block)) {
      // CAP3 (D-CAP3): the fixture's max is the shared constant in cap3.rs; read its literal.
      const k = /CAP3_MAX: u128 = ([0-9_]+);/.exec(readFileSync(join(here, "..", "..", "..", "contracts", "escrow", "src", "cap3.rs"), "utf8"));
      assert.ok(k, "CAP3_MAX literal missing in cap3.rs");
      return k![1].replace(/_/g, "");
    }
    const m = new RegExp(`${field}:\\s*U128\\(([0-9_]+)\\)`).exec(block);
    assert.ok(m, `${field} missing in tests.rs block`);
    return m![1].replace(/_/g, "");
  };
  const { args } = gen();
  for (const [tag, id] of [["V1_USDC.to_string()", USDC], ["V1_USDT.to_string()", USDT]] as const) {
    const start = fn.indexOf(tag);
    const block = fn.slice(start, fn.indexOf("),\n        ),", start));
    const g = limitOf(args, id);
    for (const f of ["min_per_side", "max_per_side", "min_fee_per_side", "run_price", "min_bond", "min_objection"]) {
      assert.equal(g[f], grab(block, f), `${id} ${f}`);
    }
  }
});

test("(a) volatile values equal the draft's indicative table (BTC, ETH, wNEAR, ZEC)", () => {
  const { args } = gen();
  assert.deepEqual(limitOf(args, BTC), {
    min_per_side: "13189", min_fee_per_side: "659", min_fee_cap_per_side: "3297", max_per_side: "10000000000000000000000000000000000",
    run_price: "7", min_bond: "6595", min_objection: "1319", storage_per_kib: "50",
  });
  const e = limitOf(args, ETH);
  assert.equal(e.min_per_side, "4474192855608849");
  assert.equal(e.min_fee_per_side, "223709642780442");
  assert.equal(e.max_per_side, "10000000000000000000000000000000000");
  assert.equal(e.run_price, "2237096427805");
  assert.equal(e.min_bond, "2237096427804425");
  assert.equal(e.min_objection, "447419285560885");
  const w = limitOf(args, WNEAR);
  assert.equal(w.min_per_side, "2717391304347826086956522");
  assert.equal(w.min_fee_per_side, "135869565217391304347826");
  assert.equal(w.max_per_side, "10000000000000000000000000000000000");
  assert.equal(w.run_price, "1358695652173913043479");
  assert.equal(w.min_bond, "1358695652173913043478261");
  assert.equal(w.min_objection, "271739130434782608695653");
  const z = limitOf(args, ZEC);
  assert.equal(z.min_per_side, "793053");
  assert.equal(z.min_fee_per_side, "39652");
  assert.equal(z.max_per_side, "10000000000000000000000000000000000");
  assert.equal(z.run_price, "397");
  assert.equal(z.min_bond, "396527");
  assert.equal(z.min_objection, "79306");
});

test("args shape: contract field names, string U128s, max_rounds 2, no sunset, fee_bps not an arg", () => {
  const { args } = gen() as any;
  assert.deepEqual(Object.keys(args).sort(), [
    "asset_limits", "attest_pubkey", "beta_sunset_ns", "fee_account", "guardian", "intents", "judge_chain", "keeper", "limits",
    "operator", "outcome_pubkey", "outlayer", "outlayer_config", "registry", "resolver_wasm_hash", "usdc_token_id",
  ]);
  assert.equal(args.beta_sunset_ns, null);
  // JC1 (D-JUDGECHAIN1): built-in chain, primary pair first (backups are a TODO constant in gen.ts)
  assert.deepEqual(args.judge_chain[0], { model_a: "deepseek-ai/DeepSeek-V4.1-Flash-1017", model_b: "z-ai/glm-5.3-flash" });
  // JC1s: 4 pairs, all ids present in the live-model fixture, distinct families inside each pair, no model reused.
  assert.equal(args.judge_chain.length, 4);
  const live = new Set<string>(JSON.parse(readFileSync(new URL("../../../resolver/wasm-bin/fixtures/near_ai_models.json", import.meta.url), "utf8")).ids);
  const used = new Set<string>();
  for (const p of args.judge_chain) {
    assert.ok(live.has(p.model_a) && live.has(p.model_b), `${p.model_a}/${p.model_b} must be in /v1/models`);
    const fam = (m: string) => m.split("/")[0].toLowerCase().replace("deepseek-ai", "deepseek");
    assert.notEqual(fam(p.model_a), fam(p.model_b));
    for (const m of [p.model_a, p.model_b]) { assert.ok(!used.has(m)); used.add(m); }
  }
  assert.equal(args.limits.max_rounds, 2);
  assert.equal(args.limits.max_offer_ttl_secs, 5_184_000);
  assert.equal(args.limits.max_stake_per_side_near, limitOf(args, WNEAR).max_per_side);
  assert.match(args.limits.max_stake, /^[0-9]+$/);
  for (const [, l] of args.asset_limits) for (const v of Object.values(l)) assert.match(v as string, /^[1-9][0-9]*$/);
  assert.deepEqual(args.asset_limits.map((p: any) => p[0]), [USDC, USDT, BTC, WNEAR, ETH, ZEC]);
});

// ---- (b) min_fee_cap_per_side present and > 0
test("(b) every generated asset has min_fee_cap_per_side > 0 and >= min_fee_per_side", () => {
  const { args } = gen();
  for (const [id, l] of args.asset_limits) {
    assert.ok(BigInt(l.min_fee_cap_per_side) > 0n, id);
    assert.ok(BigInt(l.min_fee_cap_per_side) >= BigInt(l.min_fee_per_side), id);
  }
});

test("(b) validateArgs fails loudly on an absent or zero min_fee_cap_per_side", () => {
  const { args } = gen();
  const absent = structuredClone(args);
  delete (absent.asset_limits[2][1] as any).min_fee_cap_per_side;
  refuses(() => validateArgs(absent, "mainnet"), /min_fee_cap_per_side/);
  const zero = structuredClone(args);
  zero.asset_limits[0][1].min_fee_cap_per_side = "0";
  refuses(() => validateArgs(zero, "mainnet"), /min_fee_cap_per_side/);
});

// ---- (c) property test
test("(c) property: 20*min_fee <= min <= max, min_fee <= cap, all > 0, for random prices/decimals", () => {
  let seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 2 ** 32; };
  let n = 0;
  for (let i = 0; i < 1500; i++) {
    const decimals = [6, 8, 9, 12, 18, 24][Math.floor(rnd() * 6)];
    const mag = Math.floor(rnd() * 9) - 3; // 1e-3 .. 1e5
    const p = (rnd() * 9 + 1) * 10 ** mag;
    const price = p.toFixed(Math.max(0, 6 - mag));
    if (!(Number(price) > 0)) continue;
    let out;
    try { out = gen({ assets: [stable(USDC), vol("nep141:rand.fake.near", decimals, price)] }); }
    catch (e: unknown) { if (e instanceof ReleaseError) continue; throw e; } // loud refusal (e.g. dust-sized limits) is allowed
    n++;
    const l = limitOf(out.args, "nep141:rand.fake.near");
    const [min, max, fee, cap] = [l.min_per_side, l.max_per_side, l.min_fee_per_side, l.min_fee_cap_per_side].map(BigInt);
    assert.ok(fee > 0n && cap > 0n && min > 0n && max > 0n, `${price}/${decimals}`);
    assert.ok(20n * fee <= min, `20*fee<=min ${price}/${decimals}`);
    assert.ok(fee <= cap, `fee<=cap ${price}/${decimals}`);
    assert.ok(min <= max, `min<=max ${price}/${decimals}`);
    assert.ok(BigInt(l.run_price) > 0n && BigInt(l.min_bond) > 0n && BigInt(l.min_objection) > 0n);
  }
  assert.ok(n > 800, `only ${n} generated cases`);
});

test("(c) a price so high that a limit rounds to 0 is refused, not emitted", () => {
  refuses(() => gen({ assets: [stable(USDC), vol("nep141:dust.fake.near", 2, "1000000")] }), /> 0|zero|too small/i);
});

// ---- (d) price sanity
test("(d) two sources differing by > 2% are refused; exactly 2% is accepted", () => {
  refuses(() => gen({ assets: [stable(USDC), vol(BTC, 8, "75823", { second_price_usd: "77400" })] }), /differ|2%/i); // 2.08%
  refuses(() => gen({ assets: [stable(USDC), vol(BTC, 8, "75823", { second_price_usd: "74000" })] }), /differ|2%/i);
  gen({ assets: [stable(USDC), vol(BTC, 8, "100", { second_price_usd: "102" })] });
});

test("(d) a price older than 30 minutes is refused; exactly 30 minutes is accepted; future-dated refused", () => {
  refuses(() => gen({ assets: [stable(USDC), vol(BTC, 8, "75823", { price_ts_ms: NOW - 30 * MIN - 1 })] }), /30 min|stale|older/i);
  refuses(() => gen({ assets: [stable(USDC), vol(BTC, 8, "75823", { second_price_ts_ms: NOW - 31 * MIN })] }), /30 min|stale|older/i);
  refuses(() => gen({ assets: [stable(USDC), vol(BTC, 8, "75823", { price_ts_ms: NOW + 10 * MIN })] }), /future/i);
  gen({ assets: [stable(USDC), vol(BTC, 8, "75823", { price_ts_ms: NOW - 30 * MIN })] });
});

test("(d) missing, zero, negative, exponent-form or non-numeric prices are refused", () => {
  for (const bad of ["0", "-5", "1e5", "abc", ""]) {
    refuses(() => gen({ assets: [stable(USDC), vol(BTC, 8, bad)] }), /price/i);
  }
  refuses(() => gen({ assets: [stable(USDC), vol(BTC, 8, "75823", { second_price_usd: undefined })] }), /second|price/i);
});

// ---- (e) structural input checks
test("(e) usdc_token_id must be in the asset list", () => {
  refuses(() => gen({ usdc_token_id: "nep141:not.listed.near" }), /usdc_token_id/);
});
test("(e) 64-hex keys and hash", () => {
  for (const f of ["outcome_pubkey", "attest_pubkey", "resolver_wasm_hash"] as const) {
    refuses(() => gen({ [f]: "ab".repeat(31) } as any), new RegExp(f));
    refuses(() => gen({ [f]: "zz".repeat(32) } as any), new RegExp(f));
    refuses(() => gen({ [f]: "AB".repeat(32) } as any), new RegExp(f)); // lowercase hex only
  }
});
test("(e) wasm_base_url must be https with no trailing slash; secrets_profile 1-64 bytes", () => {
  const oc = input().outlayer_config;
  refuses(() => gen({ outlayer_config: { ...oc, wasm_base_url: "http://x.example/a" } }), /wasm_base_url/);
  refuses(() => gen({ outlayer_config: { ...oc, wasm_base_url: "https://x.example/a/" } }), /wasm_base_url/);
  refuses(() => gen({ outlayer_config: { ...oc, secrets_profile: "" } }), /secrets_profile/);
  refuses(() => gen({ outlayer_config: { ...oc, secrets_profile: "x".repeat(65) } }), /secrets_profile/);
});
test("(e) operator and keeper are distinct hot accounts, different from each other and from guardian/fee_account", () => {
  const i = input();
  refuses(() => gen({ keeper: i.fee_account }), /different|distinct/i);
  refuses(() => gen({ keeper: i.guardian }), /different|distinct/i);
  refuses(() => gen({ operator: i.guardian }), /different|distinct/i);
  refuses(() => gen({ operator: i.fee_account }), /different|distinct/i);
  refuses(() => gen({ operator: i.keeper }), /different|distinct/i);
});
test("(e) KEYS2 (D-KEYS2): fee_account may equal the guardian (praetorial.near is owner + guardian + fee account)", () => {
  const i = input();
  const out = gen({ fee_account: i.guardian });
  assert.equal((out.args as any).fee_account, i.guardian);
  assert.equal((out.args as any).guardian, i.guardian);
});
test("(e) duplicate token ids and stable decimals != 6 are refused", () => {
  refuses(() => gen({ assets: [stable(USDC), stable(USDC)] }), /duplicate/i);
  refuses(() => gen({ assets: [{ ...stable(USDC), decimals: 18 }] }), /stable/i);
});

// ---- (f) network guard
test("(f) --network mainnet refuses intents != intents.near; testnet allows a mock", () => {
  refuses(() => gen({ intents: "intents-mock.fake.testnet" }, { network: "mainnet" }), /intents\.near/);
  const out = gen({ intents: "intents-mock.fake.testnet", network: "testnet" }, { network: "testnet" });
  assert.equal((out.args as any).intents, "intents-mock.fake.testnet");
});
test("(f) input.network disagreeing with the CLI/option network is refused", () => {
  refuses(() => generate(input({ network: "testnet" } as any), { now_ms: NOW, network: "mainnet" }), /network/);
});

// ---- (g) the asset list is an input
test("(g) five-asset list without ZEC", () => {
  const assets = input().assets.filter((a: { token_id: string }) => a.token_id !== ZEC);
  const { args } = gen({ assets });
  assert.deepEqual(args.asset_limits.map((p: any) => p[0]), [USDC, USDT, BTC, WNEAR, ETH]);
});
test("(g) a wBTC variant instead of omni BTC is accepted as an input", () => {
  const WBTC = "nep141:2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near";
  const { args } = gen({ assets: [stable(USDC), stable(USDT), vol(WBTC, 8, "75823")] });
  assert.equal(limitOf(args, WBTC).min_per_side, "13189");
});
test("(g) USDC-only list and a list without wNEAR still produce valid args", () => {
  const a = gen({ assets: [stable(USDC)] });
  assert.equal(a.args.asset_limits.length, 1);
  const b = gen({ assets: [stable(USDC), vol(BTC, 8, "75823")] });
  assert.ok(BigInt((b.args as any).limits.max_stake_per_side_near) > 0n);
});

// ---- human-readable table
test("table: USD value of each limit, stable and volatile, with price source and timestamp", () => {
  const { table } = gen();
  assert.match(table, /\| *Asset/);
  assert.ok(table.includes(BTC));
  assert.match(table, /\$10\.00/); // min_per_side
  assert.ok(table.includes("10000000000000000000000000000000000")); // max_per_side (CAP3: no $ cap)
  assert.match(table, /\$0\.50/);
  assert.match(table, /\$2\.50/);
  assert.match(table, /75823/);
  assert.match(table, /2027-|2026-|2025-/); // price timestamp as ISO date
});

test("generate is deterministic (same input, same bytes)", () => {
  assert.equal(JSON.stringify(gen().args), JSON.stringify(gen().args));
});

// ---- STG1b (D-STORAGE1): storage_per_kib per asset = 0.01024 NEAR per KiB in the asset, deploy-day prices, rounded UP, min 1
const NEAR_PRICE = "3.68";
test("STG1b: wNEAR storage_per_kib is exactly 0.01024 NEAR (10240000000000000000000)", () => {
  assert.equal(limitOf(gen().args, WNEAR).storage_per_kib, "10240000000000000000000");
});

test("STG1b: every asset has storage_per_kib > 0 (decimal string)", () => {
  for (const [id, l] of gen().args.asset_limits as [string, any][]) {
    assert.match(l.storage_per_kib, /^[0-9]+$/, id);
    assert.ok(BigInt(l.storage_per_kib) > 0n, id);
  }
});

test("STG1b: BTC/USDC/ETH/ZEC values equal 0.01024 * NEAR price / asset price * 10^decimals rounded up (independent rational)", () => {
  const { args } = gen();
  const want: Record<string, string> = { [USDC]: "37684", [USDT]: "37684", [BTC]: "50", [ETH]: "16860190421648", [ZEC]: "2989" };
  for (const [id, v] of Object.entries(want)) assert.equal(limitOf(args, id).storage_per_kib, v, id);
});

test("STG1b price sanity: the per-KiB charge is worth the same USD on every asset (within 1 unit of rounding)", () => {
  const { args } = gen();
  const usd = (id: string, dec: number, price: number) => Number(BigInt(limitOf(args, id).storage_per_kib)) / 10 ** dec * price;
  const target = 0.01024 * Number(NEAR_PRICE);
  assert.ok(Math.abs(usd(USDC, 6, 1) - target) < 1e-6);
  assert.ok(Math.abs(usd(BTC, 8, 75823) - target) < 75823 / 1e8 + 1e-9, "BTC within one sat of target");
  assert.ok(Math.abs(usd(ZEC, 8, 1260.95) - target) < 1260.95 / 1e8 + 1e-9);
});

test("STG1b: rounding is UP (exact values stay exact, fractions go up)", () => {
  const np = (price_usd: string) => ({ price_usd, price_ts_ms: NOW - 5 * MIN, second_price_usd: price_usd, second_price_ts_ms: NOW - 5 * MIN });
  // 0.01024 NEAR * 3.125 USD = 0.032 USD = exactly 32000 USDC units
  assert.equal(limitOf(gen({ near_price: np("3.125") } as any).args, USDC).storage_per_kib, "32000");
  // 0.01024 * 3.126 = 0.03201024 -> 32010.24 -> up
  assert.equal(limitOf(gen({ near_price: np("3.126") } as any).args, USDC).storage_per_kib, "32011");
});

test("STG1b: the NEAR price input is required, two-source checked (2%) and not stale", () => {
  refuses(() => gen({ near_price: undefined } as any), /near_price/i);
  const np = (o: Record<string, unknown>) => ({ price_usd: "3.68", price_ts_ms: NOW - 5 * MIN, second_price_usd: "3.68", second_price_ts_ms: NOW - 5 * MIN, ...o });
  refuses(() => gen({ near_price: np({ second_price_usd: "3.80" }) } as any), /differ|2%/i);
  refuses(() => gen({ near_price: np({ price_ts_ms: NOW - 31 * MIN }) } as any), /30 min|stale|older/i);
  refuses(() => gen({ near_price: np({ price_usd: "0" }) } as any), /> 0|price/i);
  // a list with no wNEAR asset (USDC only) still gets a storage rate from near_price
  assert.equal(limitOf(gen({ assets: [stable(USDC)] }).args, USDC).storage_per_kib, "37684");
});

test("STG1b: validateArgs refuses missing / 0 / non-decimal storage_per_kib", () => {
  for (const bad of [undefined, "0", "-1", "1.5", 5]) {
    const { args } = gen() as any;
    const a = JSON.parse(JSON.stringify(args));
    if (bad === undefined) delete a.asset_limits[0][1].storage_per_kib; else a.asset_limits[0][1].storage_per_kib = bad;
    refuses(() => validateArgs(a, "mainnet"), /storage_per_kib/);
  }
});

test("STG1b: the generated table lists storage_per_kib", () => {
  assert.match(gen().table, /storage_per_kib/);
});

// ---- JC1x: initial chain is 2..=4 pairs of ASCII org/model ids
import { isValidModelId, validateArgs as jc1xValidate, BUILT_IN_JUDGE_CHAIN as jc1xChain } from "../src/gen.js";
test("JC1x: model id rule mirrors the contract", () => {
  assert.equal(isValidModelId("deepseek-ai/DeepSeek-V4.1-Flash-1017"), true);
  for (const bad of ["nomodel", "a/b/c", "/b", "a/", "a/bé", "a/b c", "a/" + "m".repeat(127)]) assert.equal(isValidModelId(bad), false, bad);
  assert.equal(isValidModelId("o/" + "m".repeat(126)), true);
});
test("JC1x: the built-in chain has 2..=4 pairs", () => {
  assert.ok(jc1xChain.length >= 2 && jc1xChain.length <= 4);
  assert.equal(typeof jc1xValidate, "function");
});
