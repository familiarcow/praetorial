// WT1 (3)+(4)+fee: the envelope the web builds has no stub values, derived deadlines capped by the horizon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildOpenEnvelope, makerDeposit } from "../lib/openEnvelope";
import { loadReleaseConfig } from "../lib/releaseConfig";
import { termsHash } from "../lib/templates";

const here = dirname(fileURLToPath(import.meta.url));
const cases: Array<{ name: string; codes: string[]; ts: any }> = JSON.parse(
  readFileSync(join(here, "../../../resolver/core/tests/fixtures/template_cases.json"), "utf8"),
);
const fx = (n: string) => cases.find((c) => c.name === n)!.ts;
const NOW = Date.parse("2026-11-07T12:00:00Z");
const base = (sheet: any, over: Record<string, unknown> = {}) =>
  buildOpenEnvelope({
    maker: "maker.testnet", sheet, makerAsset: "nep141:usdc.testnet", takerAsset: "nep141:usdc.testnet",
    stakeMaker: "1000000", stakeTaker: "1000000", takerAccount: null, referee: null, nowMs: NOW, ...over,
  });

test("(3) no 'stub-' value anywhere in a built envelope, for every launch fixture", () => {
  for (const n of ["btc_close_ok", "btc_touch_ok", "game_ok", "nws_ok"]) {
    const env = base(fx(n), { nowMs: Date.parse(fx(n).fields.open_utc ?? "2026-10-20T00:00:00Z") || NOW });
    assert.ok(!/stub-/i.test(JSON.stringify(env)), n);
  }
});

test("(3) models_snapshot_hash comes from the release config; no resolver hash/pubkey literals on the envelope (D-KEY1 pins them in the contract)", () => {
  const rel = loadReleaseConfig();
  const env: any = base(fx("btc_close_ok"), { nowMs: Date.parse(fx("btc_close_ok").fields.open_utc) });
  assert.equal(env.models_snapshot_hash, rel.models_snapshot_hash);
  assert.match(env.models_snapshot_hash, /^[0-9a-f]{64}$/);
  assert.match(rel.resolver_wasm_hash, /^[0-9a-f]{64}$/);
  assert.equal("resolver_wasm_hash" in env, false);
  assert.equal("resolver_pubkey" in env, false);
});

test("(2) terms_hash == sha256(envelope.terms) and keep_terms carries the canonical sheet", () => {
  const env: any = base(fx("btc_close_ok"), { nowMs: Date.parse(fx("btc_close_ok").fields.open_utc) });
  assert.equal(env.keep_terms, true);
  assert.equal(env.terms_hash, termsHash(env.terms));
  assert.deepEqual(JSON.parse(env.terms), fx("btc_close_ok"));
});

test("(4) btc_close_at_t: funding closes at T, resolve_deadline = T + 7d", () => {
  const ts = fx("btc_close_ok");
  const env: any = base(ts, { nowMs: Date.parse(ts.fields.open_utc) });
  const T = Date.parse(ts.fields.t_utc);
  assert.equal(BigInt(env.funding_deadline), BigInt(T) * 1_000_000n);
  assert.equal(BigInt(env.resolve_deadline), (BigInt(T) + 7n * 86_400_000n) * 1_000_000n);
});

test("(4) btc_touch: resolve_deadline = deadline + 7d", () => {
  const ts = fx("btc_touch_ok");
  const env: any = base(ts, { nowMs: Date.parse(ts.fields.open_utc) });
  const D = Date.parse(ts.fields.deadline_utc);
  assert.equal(BigInt(env.resolve_deadline), (BigInt(D) + 7n * 86_400_000n) * 1_000_000n);
  assert.ok(BigInt(env.funding_deadline) <= BigInt(env.resolve_deadline));
});

test("(4) horizon: 1,461-day touch + 7d recovery is refused; a touch inside 1,461d-7d opens", () => {
  const open = "2026-11-07T12:00:00Z";
  const mk = (days: number) => ({ template: { id: "btc_touch", version: 1 }, fields: { direction: "at_or_above", x_usd: 200000, open_utc: open, deadline_utc: new Date(Date.parse(open) + days * 86_400_000).toISOString().replace(".000Z", "Z") } });
  assert.throws(() => base(mk(1461), { nowMs: Date.parse(open) }), /OPEN_DEADLINE_TOO_FAR/);
  const env: any = base(mk(1454), { nowMs: Date.parse(open) });
  assert.ok(BigInt(env.resolve_deadline) - BigInt(Date.parse(open)) * 1_000_000n <= 1461n * 86_400n * 1_000_000_000n);
});

test("fee_bps is 100 (D-FEEPIN1) and a resolver-rejected sheet throws its named error", () => {
  const env: any = base(fx("btc_close_ok"), { nowMs: Date.parse(fx("btc_close_ok").fields.open_utc) });
  assert.equal(env.fee_bps, 100);
  assert.throws(() => base(fx("close_x_fraction")), /TPL_X_USD_NOT_WHOLE/);
});

test("(3) the open handler in App.tsx carries no 'stub-' literal and uses buildOpenEnvelope", () => {
  const app = readFileSync(join(here, "../src/App.tsx"), "utf8");
  assert.ok(!/stub-/.test(app), "App.tsx still contains a stub- literal");
  assert.ok(/buildOpenEnvelope\(/.test(app));
});

// WT1c (rewritten for STG1b / D-STORAGE1): the envelope carries storage_charge_per_side "0"; the deposit adds the maker asset's
// own charge, max(1, ceil(estimated_bytes * rate / 2048)), and 2x that covers the contract's estimated storage bytes at the
// 1 raw unit/byte-equivalent rate (rate 1024 per KiB).
function requiredStorageBytes(env: any): number {
  return env.terms.length + env.terms_hash.length + env.models_snapshot_hash.length + 3 * 5 * (128 + 64) + 256;
}
test("WT1c: deposit includes a storage charge that covers the contract's estimated storage bytes (both sides pay it)", () => {
  for (const n of ["btc_close_ok", "btc_touch_ok", "game_ok", "nws_ok"]) {
    const env: any = base(fx(n), { nowMs: Date.parse(fx(n).fields.open_utc ?? "2026-10-20T00:00:00Z") || NOW });
    assert.equal(env.storage_charge_per_side, "0");
    const charge = BigInt(makerDeposit(env, "1024")) - BigInt(env.stake_maker);
    assert.ok(charge * 2n >= BigInt(requiredStorageBytes(env)), `${n}: charge=${charge}`);
  }
});
test("WT1c: storage charge is deposited on top of the stake (deposit = stake + storage)", () => {
  const env: any = base(fx("btc_close_ok"), { nowMs: Date.parse(fx("btc_close_ok").fields.open_utc) });
  const d = BigInt(makerDeposit(env, "1024"));
  assert.equal(d, BigInt(env.stake_maker) + BigInt(Math.ceil(requiredStorageBytes(env) / 2)));
});
