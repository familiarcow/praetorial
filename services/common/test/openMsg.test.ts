import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpenMsg, MAX_HORIZON_NS } from "../src/openMsg.js";

const baseEnv = {
  bet_id: 0, version: 1, maker: "m.testnet", taker_allow: { Any: {} },
  terms_hash: "a".repeat(64), models_snapshot_hash: "x", outcomes: ["YES", "NO"], maker_side: "YES",
  maker_asset: "nep141:usdc.test", taker_asset: "nep141:usdc.test",
  stake_maker: "1", stake_taker: "1", fee_bps: 100, storage_charge_per_side: "2",
  keep_terms: true, terms: "t", max_paid_runs: 1, tier: 1,
  funding_deadline: 1, early_settle_outcome: null, finality_delay: 0,
  settlement_period: 1, resolve_deadline: 2, consent_party_controlled: false,
};
const att = { checked_at: 1793934402624679936n, signature_hex: "b".repeat(128) };

test("buildOpenMsg emits the current Open interface: kind, envelope, attestation, no arbiter", () => {
  const msg = JSON.parse(buildOpenMsg({ ...baseEnv, arbiter: null } as any, att));
  assert.equal(msg.kind, "Open");
  assert.equal("arbiter" in msg.envelope, false);
  assert.equal(msg.envelope.maker_asset, "nep141:usdc.test");
  assert.equal(msg.attestation.signature_hex.length, 128);
});

test("buildOpenMsg keeps u64 checked_at exact (no float rounding)", () => {
  const raw = buildOpenMsg(baseEnv as any, att);
  assert.ok(raw.includes('"checked_at":1793934402624679936'), raw);
});

test("buildOpenMsg refuses an envelope missing maker_asset/taker_asset", () => {
  const { maker_asset, ...rest } = baseEnv;
  assert.throws(() => buildOpenMsg(rest as any, att), /maker_asset/);
});

test("buildOpenMsg refuses a missing/short attestation signature", () => {
  assert.throws(() => buildOpenMsg(baseEnv as any, undefined as any), /attestation/);
  assert.throws(() => buildOpenMsg(baseEnv as any, { checked_at: 1, signature_hex: "ab" }), /signature/);
});

// ---- H1b / D-HORIZON1a: resolve_deadline at most 1,461 days (4 years) after open ----
const DAY_NS = 86_400n * 1_000_000_000n;
const HORIZON_NS = 1_461n * DAY_NS;
const NOW_NS = 1_800_000_000_000_000_000n;
const hEnv = (rd: bigint) => ({ ...baseEnv, funding_deadline: Number(NOW_NS / 1000n), resolve_deadline: rd.toString() as unknown as number });

test("H1b: MAX_HORIZON_NS is pinned to 1,461 days", () => {
  assert.equal(MAX_HORIZON_NS, 1_461n * 86_400n * 1_000_000_000n);
});

test("H1b: buildOpenMsg accepts resolve_deadline exactly 1,461 days after now", () => {
  const msg = buildOpenMsg(hEnv(NOW_NS + HORIZON_NS), att, NOW_NS);
  assert.equal(JSON.parse(msg).kind, "Open");
});

test("H1b: 366 days and 2 years are now accepted (D-HORIZON1a ruling change)", () => {
  assert.equal(JSON.parse(buildOpenMsg(hEnv(NOW_NS + 366n * DAY_NS), att, NOW_NS)).kind, "Open");
  assert.equal(JSON.parse(buildOpenMsg(hEnv(NOW_NS + 730n * DAY_NS), att, NOW_NS)).kind, "Open");
});

test("H1b: buildOpenMsg refuses 1,461 days + 1s with a clear message", () => {
  assert.throws(
    () => buildOpenMsg(hEnv(NOW_NS + HORIZON_NS + 1_000_000_000n), att, NOW_NS),
    /Bets can last at most 4 years \(D-HORIZON1a\)/,
  );
});

test("H1b: buildOpenMsg refuses a 5-year deadline", () => {
  assert.throws(() => buildOpenMsg(hEnv(NOW_NS + 5n * 365n * DAY_NS), att, NOW_NS), /D-HORIZON1a/);
});
