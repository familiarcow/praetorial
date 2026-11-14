// RCB1 (D-STORAGE1 part 4, D-MINSTAKE1, GATE-05 K1): storage_per_kib is pinned at new() and cannot be fixed after
// deploy. The generator must prove, per asset, that the worst-case per-side storage charge stays within 10% of
// min_per_side and cannot overflow u128. Contract constants are PARSED from lib.rs, not copied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate, validateArgs, ReleaseError, type ReleaseInput } from "../src/gen.js";
import { parseContractConstants, loadContractConstants, maxEnvelopeBytes, storageCharge, TYPICAL_ENVELOPE_BYTES } from "../src/contractConstants.js";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const LIB_RS = join(here, "..", "..", "..", "contracts", "escrow", "src", "lib.rs");
const SRC = readFileSync(LIB_RS, "utf8");
const EXAMPLE = join(here, "..", "example");

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDT = "nep141:usdt.tether-token.near";
const BTC = "nep141:btc.omft.near";
const WNEAR = "nep141:wrap.near";
const ETH = "nep141:eth.omft.near";
const ZEC = "nep141:zec.omft.near";
const U128_MAX = (1n << 128n) - 1n;
const vol = (token_id: string, decimals: number, price: string) => ({
  token_id, decimals, kind: "volatile" as const, price_usd: price, price_ts_ms: NOW - 5 * MIN,
  second_price_usd: price, second_price_ts_ms: NOW - 6 * MIN,
});
const stable = (token_id: string) => ({ token_id, decimals: 6, kind: "stable" as const });
function input(over: Partial<ReleaseInput> = {}): ReleaseInput {
  return {
    network: "mainnet", intents: "intents.near", usdc_token_id: USDC,
    outlayer: "outlayer.fake.near", operator: "operator.fake.near", guardian: "praetorial.near",
    registry: "registry.fake.near", fee_account: "fee.fake.near", keeper: "keeper.fake.near",
    max_offer_ttl_secs: 5_184_000,
    near_price: { price_usd: "3.68", price_ts_ms: NOW - 5 * MIN, second_price_usd: "3.68", second_price_ts_ms: NOW - 6 * MIN },
    outcome_pubkey: "a1".repeat(32), attest_pubkey: "b2".repeat(32), resolver_wasm_hash: "c3".repeat(32),
    outlayer_config: { wasm_base_url: "https://fastfs.fake.example/u.near/o.near", secrets_profile: "praetorial-resolver", secrets_account_id: "secrets.fake.near" },
    assets: [stable(USDC), stable(USDT), vol(BTC, 8, "75823"), vol(WNEAR, 24, "3.68"), vol(ETH, 18, "2235.04"), vol(ZEC, 8, "1260.95")],
    ...over,
  } as ReleaseInput;
}
const gen = (over: Partial<ReleaseInput> = {}) => generate(input(over), { now_ms: NOW });
const refuses = (fn: () => unknown, re: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof ReleaseError && re.test(e.message), String(re));
const clone = (x: any) => JSON.parse(JSON.stringify(x));
const limitOf = (args: any, id: string) => args.asset_limits.find((p: any) => p[0] === id)[1];

// ---- constants come from lib.rs source
test("RCB1: constants are parsed from lib.rs and give the 11,584-byte worst-case envelope", () => {
  const c = loadContractConstants();
  assert.equal(c.maxTermsLen, 8192n);
  assert.equal(c.maxHashLen, 128n);
  assert.equal(c.maxAccountIdLen, 64n);
  assert.equal(c.eventOverheadBytes, 256n);
  // 8192 terms + 2*128 hashes + 3 filers*5 exhibits*(128+64) + 256 overhead
  assert.equal(maxEnvelopeBytes(c), 8192n + 256n + 15n * 192n + 256n);
  assert.equal(maxEnvelopeBytes(c), 11584n);
});

test("RCB1: parse FAILS (not silently defaults) when the source has no constants", () => {
  assert.throws(() => parseContractConstants(""), /MAX_TERMS_LEN/);
  assert.throws(() => parseContractConstants("pub const MAX_TERMS_LEN: usize = 8 * 1024;"), /MAX_HASH_LEN/);
  assert.throws(() => parseContractConstants(SRC.replace(/pub const STORAGE_EVENT_OVERHEAD_BYTES[^;]*;/, "")), /STORAGE_EVENT_OVERHEAD_BYTES/);
  assert.throws(() => parseContractConstants(SRC.replace(/let max_exhibit_bytes =[^;]*;/, "")), /exhibit/i);
  assert.throws(() => parseContractConstants(SRC.replace("/ 2048", "/ 4096").replace("+ 2047", "+ 4095")), /rate|2048|storage_for/i);
  assert.throws(() => loadContractConstants(join(tmpdir(), "does-not-exist-rcb1.rs")));
});

test("RCB1: a changed contract constant changes the bound (no copy in the generator)", () => {
  const c2 = parseContractConstants(SRC.replace("MAX_TERMS_LEN: usize = 8 * 1024", "MAX_TERMS_LEN: usize = 16 * 1024"));
  assert.equal(c2.maxTermsLen, 16384n);
  assert.equal(maxEnvelopeBytes(c2), 11584n + 8192n);
  // the generator honours an injected constants object end to end
  const big = generate(input(), { now_ms: NOW, constants: c2 });
  assert.ok(big.storage.every((r) => r.maxCharge > 0n));
  assert.equal(big.storage[0].maxBytes, 11584n + 8192n);
});

test("RCB1: storageCharge mirrors the contract formula max(1, ceil(bytes*rate/2048))", () => {
  const c = loadContractConstants();
  assert.equal(storageCharge(0n, 5n, c), 1n);
  assert.equal(storageCharge(3248n, 6305n, c), 10_000n); // STG1 fixture in lib.rs / stg1.rs
  assert.equal(storageCharge(2048n, 1n, c), 1n);
  assert.equal(storageCharge(2049n, 1n, c), 2n);
  assert.equal(TYPICAL_ENVELOPE_BYTES, 4096n);
});

// ---- (1) 10% bound
function boundaryRate(minPerSide: bigint, bytes: bigint): bigint {
  // largest rate with charge*10 <= min_per_side
  let r = (minPerSide / 10n) * 2048n / bytes;
  while (storageCharge(bytes, r + 1n, loadContractConstants()) * 10n <= minPerSide) r++;
  while (storageCharge(bytes, r, loadContractConstants()) * 10n > minPerSide) r--;
  return r;
}
test("RCB1 (1): validateArgs accepts the exact boundary rate and refuses boundary+1 (USDC, min 10 USDC)", () => {
  const c = loadContractConstants();
  const bytes = maxEnvelopeBytes(c);
  const r = boundaryRate(10_000_000n, bytes);
  assert.ok(storageCharge(bytes, r, c) * 10n <= 10_000_000n);
  assert.ok(storageCharge(bytes, r + 1n, c) * 10n > 10_000_000n);
  const { args } = gen();
  const ok = clone(args); limitOf(ok, USDC).storage_per_kib = r.toString();
  validateArgs(ok, "mainnet");
  const bad = clone(args); limitOf(bad, USDC).storage_per_kib = (r + 1n).toString();
  refuses(() => validateArgs(bad, "mainnet"), /storage.*10%|10%.*storage/i);
});

test("RCB1 (1): the refusal names the asset, the charge and min_per_side", () => {
  const { args } = gen();
  const bad = clone(args); limitOf(bad, BTC).storage_per_kib = "5000";
  refuses(() => validateArgs(bad, "mainnet"), new RegExp(BTC.replace(/\./g, "\\.") + ".*max storage charge"));
});

test("RCB1 (1): generate refuses an absurd NEAR price that makes storage eat the stake", () => {
  const np = { price_usd: "100000000", price_ts_ms: NOW - 5 * MIN, second_price_usd: "100000000", second_price_ts_ms: NOW - 5 * MIN };
  refuses(() => gen({ near_price: np } as any), /storage.*10%|10%.*storage/i);
});

// ---- (2) u128 overflow
test("RCB1 (2): validateArgs refuses a rate where estimated_storage_bytes(max) * rate overflows u128", () => {
  const c = loadContractConstants();
  const bytes = maxEnvelopeBytes(c);
  const over = U128_MAX / bytes + 1n;
  const { args } = gen();
  const bad = clone(args); limitOf(bad, USDC).storage_per_kib = over.toString();
  refuses(() => validateArgs(bad, "mainnet"), /overflow/i);
  // the largest non-overflowing rate is not an overflow error (it fails the 10% bound instead)
  const edge = clone(args); limitOf(edge, USDC).storage_per_kib = (U128_MAX / bytes).toString();
  refuses(() => validateArgs(edge, "mainnet"), /10%/);
});

test("RCB1 (2): the +2047 rounding add cannot overflow either", () => {
  const c = loadContractConstants();
  const bytes = maxEnvelopeBytes(c);
  // pick a rate where bytes*rate <= U128_MAX but bytes*rate + 2047 > U128_MAX, if one exists
  const r = U128_MAX / bytes; // the largest rate with bytes*rate <= U128_MAX
  if (bytes * r + 2047n <= U128_MAX) return; // no such window for these constants; (2) above covers it
  const { args } = gen();
  const bad = clone(args); limitOf(bad, USDC).storage_per_kib = r.toString();
  refuses(() => validateArgs(bad, "mainnet"), /overflow/i);
});

// ---- (3) wNEAR exact
test("RCB1 (3): wNEAR storage_per_kib is exactly 10240000000000000000000 at any NEAR price, and passes the bound", () => {
  for (const p of ["3.68", "0.5", "8"]) {
    const np = { price_usd: p, price_ts_ms: NOW - 5 * MIN, second_price_usd: p, second_price_ts_ms: NOW - 5 * MIN };
    const w = vol(WNEAR, 24, p);
    const r = gen({ near_price: np, assets: [stable(USDC), w] } as any);
    assert.equal(limitOf(r.args, WNEAR).storage_per_kib, "10240000000000000000000", p);
  }
});

test("RCB1 (1): a NEAR price of $50 (storage 29% of a $10 side) is refused by the generator", () => {
  const np = { price_usd: "50", price_ts_ms: NOW - 5 * MIN, second_price_usd: "50", second_price_ts_ms: NOW - 5 * MIN };
  refuses(() => gen({ near_price: np, assets: [stable(USDC), vol(WNEAR, 24, "50")] } as any), /10%/);
});

test("RCB1 (3): validateArgs refuses a wNEAR storage_per_kib other than exactly 0.01024 NEAR", () => {
  const { args } = gen();
  for (const v of ["10240000000000000000001", "10239999999999999999999", "1"]) {
    const bad = clone(args); limitOf(bad, WNEAR).storage_per_kib = v;
    refuses(() => validateArgs(bad, "mainnet"), /wNEAR.*10240000000000000000000|storage_per_kib.*exactly/i);
  }
});

// ---- (4) per-asset table
test("RCB1 (4): result carries a per-asset storage report; values match the contract formula", () => {
  const r = gen();
  const c = loadContractConstants();
  assert.equal(r.storage.length, 6);
  for (const row of r.storage) {
    const l = limitOf(r.args, row.token_id);
    assert.equal(row.rate, BigInt(l.storage_per_kib));
    assert.equal(row.typicalCharge, storageCharge(4096n, row.rate, c));
    assert.equal(row.maxCharge, storageCharge(maxEnvelopeBytes(c), row.rate, c));
    assert.equal(row.minPerSide, BigInt(l.min_per_side));
    assert.ok(row.maxCharge * 10n <= row.minPerSide, row.token_id);
  }
  const usdc = r.storage.find((x) => x.token_id === USDC)!;
  assert.equal(usdc.typicalCharge, 75_368n);
  assert.equal(usdc.maxCharge, 213_151n); // ceil(11584*37684/2048)
});

test("RCB1 (4): the printed table lists rate, ~4 KB charge, max charge and % of min_per_side per asset", () => {
  const t = gen().table;
  assert.match(t, /Storage charge per side/);
  assert.match(t, /rate \(storage_per_kib\)/);
  assert.match(t, /~4 KB charge/);
  assert.match(t, /max charge/);
  assert.match(t, /% of min_per_side/);
  for (const id of [USDC, USDT, BTC, WNEAR, ETH, ZEC]) {
    const line = t.split("\n").find((l) => l.startsWith("| `" + id + "`") && /%\s*\|$/.test(l));
    assert.ok(line, `storage row for ${id}`);
  }
  assert.match(t, /\| 2\.13% \|/); // USDC 213151/10000000
  assert.match(t, /\| 2\.15% \|/); // BTC 283/13189
});

test("RCB1 (4): the CLI prints the per-asset storage table on success", () => {
  const d = mkdtempSync(join(tmpdir(), "rcb1-"));
  writeFileSync(join(d, "in.json"), JSON.stringify(input()));
  const r = spawnSync(process.execPath, ["--import", "tsx", join(here, "..", "src", "cli.ts"), "gen-new-args", "--input", join(d, "in.json"), "--out", join(d, "a.json"), "--network", "mainnet", "--now-ms", String(NOW)], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Storage charge per side/);
  assert.match(r.stdout, /% of min_per_side/);
});

// ---- the committed indicative example must itself pass (a generator-refused example must never be merged)
test("RCB1: example/args.indicative.json passes validateArgs, and regenerating from input.indicative.json matches it", () => {
  const args = JSON.parse(readFileSync(join(EXAMPLE, "args.indicative.json"), "utf8"));
  validateArgs(args, "mainnet");
  const inp = JSON.parse(readFileSync(join(EXAMPLE, "input.indicative.json"), "utf8"));
  const tbl = readFileSync(join(EXAMPLE, "limits-table.indicative.md"), "utf8");
  const ts = Date.parse(tbl.match(/generated at ([0-9T:.\-Z]+)\)/)![1]);
  const r = generate(inp, { now_ms: ts, network: "mainnet" });
  assert.deepEqual(r.args, args);
  assert.equal(r.table, tbl);
});

// ---- the draft's deploy-day values (storage 0.01024 NEAR/KiB, $10 minimum, D-MINSTAKE1) keep storage <= 10% on every asset
test("RCB1: indicative draft values: every asset's max charge is within 10% of min_per_side", () => {
  const r = gen();
  for (const row of r.storage) assert.ok(row.maxCharge * 10n <= row.minPerSide, `${row.token_id} ${row.maxCharge}/${row.minPerSide}`);
});
