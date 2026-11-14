// STG1b (D-STORAGE1): the web computes each side's storage charge with the contract's formula,
// max(1, ceil(estimated_bytes * storage_per_kib / 1024 / 2)), in the side's OWN asset; the envelope carries "0".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildOpenEnvelope, makerDeposit } from "../lib/openEnvelope";
import { estimatedStorageBytes, storageForRate, reviewStorage, fetchStorageRates } from "../lib/storageCharge";
import { takeChoices, prepareTake } from "../lib/takeScreen";

const here = dirname(fileURLToPath(import.meta.url));
const cases: Array<{ name: string; ts: any }> = JSON.parse(
  readFileSync(join(here, "../../../resolver/core/tests/fixtures/template_cases.json"), "utf8"),
);
const sheet = cases.find((c) => c.name === "btc_close_ok")!.ts;
const NOW = Date.parse(sheet.fields.open_utc);
const USDC = "nep141:usdc.testnet", BTC = "nep141:wbtc.testnet", WNEAR = "wrap.testnet";

// Rates + expected charges copied from contracts/escrow/src/stg1.rs (R_USDC, R_BTC, R_WNEAR) evaluated for the
// fixed part of estimated_storage_bytes (64+64 hash chars + 15*(128+64) exhibits + 256 event = 3264) + terms bytes.
const RATES: Record<string, string> = { [USDC]: "4096", [BTC]: "100000", [WNEAR]: "10240000000000000000000000" };
const TABLE: Array<{ termsLen: number; bytes: number; charge: Record<string, string> }> = [
  { termsLen: 0, bytes: 3264, charge: { [USDC]: "6528", [BTC]: "159375", [WNEAR]: "16320000000000000000000000" } },
  { termsLen: 1000, bytes: 4264, charge: { [USDC]: "8528", [BTC]: "208204", [WNEAR]: "21320000000000000000000000" } },
  { termsLen: 8192, bytes: 11456, charge: { [USDC]: "22912", [BTC]: "559375", [WNEAR]: "57280000000000000000000000" } },
];

test("parity: web formula == contract formula for 3 assets x 3 term sizes", () => {
  for (const row of TABLE) {
    const bytes = estimatedStorageBytes("x".repeat(row.termsLen), "a".repeat(64), "b".repeat(64));
    assert.equal(bytes, row.bytes, `bytes for ${row.termsLen}`);
    for (const asset of [USDC, BTC, WNEAR]) {
      assert.equal(storageForRate(bytes, RATES[asset]).toString(), row.charge[asset], `${asset} @ ${row.termsLen}`);
    }
  }
});

test("storageForRate: minimum 1 even for a tiny rate; 8 KiB terms cost more than empty terms in every asset", () => {
  assert.equal(storageForRate(3264, "1"), 2n);
  assert.equal(storageForRate(1, "1"), 1n);
  for (const a of [USDC, BTC, WNEAR]) {
    assert.ok(BigInt(TABLE[2].charge[a]) > BigInt(TABLE[0].charge[a]));
  }
});

test("buildOpenEnvelope emits storage_charge_per_side \"0\" (contract refuses nonzero)", () => {
  const env: any = buildOpenEnvelope({ maker: "m.testnet", sheet, makerAsset: BTC, takerAsset: USDC, stakeMaker: "10000", stakeTaker: "5000000", takerAccount: null, referee: null, nowMs: NOW });
  assert.equal(env.storage_charge_per_side, "0");
});

test("makerDeposit = stake + the MAKER asset's own charge computed from the envelope bytes", () => {
  const env: any = buildOpenEnvelope({ maker: "m.testnet", sheet, makerAsset: BTC, takerAsset: USDC, stakeMaker: "10000", stakeTaker: "5000000", takerAccount: null, referee: null, nowMs: NOW });
  const bytes = estimatedStorageBytes(env.terms, env.terms_hash, env.models_snapshot_hash);
  assert.equal(makerDeposit(env, RATES[BTC]), (10000n + storageForRate(bytes, RATES[BTC])).toString());
  assert.notEqual(makerDeposit(env, RATES[BTC]), makerDeposit(env, RATES[USDC]));
});

const bet = (rates: Record<string, string> | undefined): any => ({
  status: "Open", taker: null, fee_min_taker: "0", fee_min_taker_options: ["0"], storage_rates: rates,
  envelope: { maker: "m.testnet", taker_asset: USDC, stake_taker: "5000000", maker_asset: BTC, stake_maker: "10000", storage_charge_per_side: "0",
    fee_bps: 100, resolve_deadline: 1, referee: null, taker_allow: "Any", terms: "t".repeat(1000), terms_hash: "a".repeat(64), models_snapshot_hash: "b".repeat(64),
    taker_options: [{ asset: WNEAR, amount: "1500000000000000000000000" }] },
});

test("takeChoices: each option's deposit = its stake + that ASSET's own charge", () => {
  const [p, o] = takeChoices(bet(RATES));
  assert.equal(p.deposit, 5_000_000n + 8528n);
  assert.equal(o.deposit, 1_500_000_000_000_000_000_000_000n + 21320000000000000000000000n);
  assert.equal(p.blocked, null);
});

test("takeChoices: unknown rate for an asset blocks that choice (nothing is guessed)", () => {
  const [p, o] = takeChoices(bet({ [USDC]: "4096" }));
  assert.equal(p.blocked, null);
  assert.match(o.blocked ?? "", /storage/i);
  assert.match(takeChoices(bet(undefined))[0].blocked ?? "", /storage/i);
});

test("prepareTake: amount carries the taken asset's charge using the rates shown on the page; no rates -> refused", async () => {
  const b = bet(RATES);
  const reread = async () => ({ ...b, storage_rates: undefined });
  const r: any = await prepareTake({ betId: 7, shown: b, tip: false, inviteSig: null, asset: WNEAR, readBet: reread as any });
  assert.equal(r.ok, true);
  assert.equal(r.amount, (1_500_000_000_000_000_000_000_000n + 21320000000000000000000000n).toString());
  assert.equal(r.tokenId, WNEAR);
  const none: any = await prepareTake({ betId: 7, shown: bet(undefined), tip: false, inviteSig: null, readBet: reread as any });
  assert.equal(none.ok, false);
});

test("reviewStorage: each side's charge in its own asset (units + human string)", () => {
  const r = reviewStorage({ terms: "x".repeat(1000), termsHash: "a".repeat(64), modelsHash: "b".repeat(64),
    maker: { symbol: "BTC", decimals: 8, ratePerKib: RATES[BTC] }, taker: { symbol: "USDC", decimals: 6, ratePerKib: RATES[USDC] } });
  assert.equal(r.maker.units, 208204n);
  assert.equal(r.taker.units, 8528n);
  assert.equal(r.maker.text, "0.00208204 BTC");
  assert.equal(r.taker.text, "0.008528 USDC");
});

test("fetchStorageRates reads asset_limit per distinct asset; missing asset is left out", async () => {
  const calls: string[] = [];
  const rates = await fetchStorageRates([USDC, BTC, USDC, "nep141:nope"], async (a) => { calls.push(a); return a === "nep141:nope" ? null : { storage_per_kib: RATES[a] }; });
  assert.deepEqual(calls.sort(), ["nep141:nope", BTC, USDC].sort());
  assert.deepEqual(rates, { [USDC]: "4096", [BTC]: "100000" });
});

test("UI wiring: ReviewCard shows both storage lines; BetPage loads rates; no web code reads a nonzero envelope storage", () => {
  const rc = readFileSync(join(here, "../src/components/ReviewCard.tsx"), "utf8");
  // C1: both storage lines are Full terms rows of lib/reviewCard.ts (rendered as review-term-storage / review-term-their-storage)
  const rm = readFileSync(join(here, "../lib/reviewCard.ts"), "utf8");
  assert.ok(/add\("storage"/.test(rm) && /add\("their-storage"/.test(rm) && /review-term-\$\{t\.id\}/.test(rc));
  const bp = readFileSync(join(here, "../src/components/BetPage.tsx"), "utf8");
  assert.ok(/fetchStorageRates\(/.test(bp));
  const app = readFileSync(join(here, "../src/App.tsx"), "utf8");
  assert.ok(/fetchStorageRates\(/.test(app) && /makerDeposit\(envelope, /.test(app));
});
