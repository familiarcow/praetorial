import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEscrowEvents, replayGovernance } from "../src/escrowEvents.js";

const ev = (event: string, data: any, standard = "praetorial-escrow") => `EVENT_JSON:${JSON.stringify({ standard, version: "1.0.0", event, data: [data] })}`;
const init = { guardian: "g.testnet", chain: [{ model_a: "a/1", model_b: "b/1" }, { model_a: "a/2", model_b: "b/2" }] };

test("parser keeps only praetorial-escrow EVENT_JSON lines and tolerates garbage", () => {
  const out = parseEscrowEvents(["open bet_id=1", "EVENT_JSON:{nope", ev("x", {}, "other"), ev("guardian_proposed", { guardian: "g.testnet", proposed: "n.testnet" })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].event, "guardian_proposed");
});

test("guardian rotation replays: propose then accept; an unaccepted proposal keeps the old guardian", () => {
  const a = replayGovernance(init, parseEscrowEvents([ev("guardian_proposed", { guardian: "g.testnet", proposed: "n.testnet" })]));
  assert.equal(a.guardian, "g.testnet"); assert.equal(a.pendingGuardian, "n.testnet"); assert.deepEqual(a.problems, []);
  const b = replayGovernance(init, parseEscrowEvents([ev("guardian_proposed", { guardian: "g.testnet", proposed: "n.testnet" }), ev("guardian_rotated", { old_guardian: "g.testnet", guardian: "n.testnet" })]));
  assert.equal(b.guardian, "n.testnet"); assert.deepEqual(b.problems, []);
});

test("a rotation nobody proposed, or to a different account, is a problem", () => {
  assert.ok(replayGovernance(init, parseEscrowEvents([ev("guardian_rotated", { old_guardian: "g.testnet", guardian: "x.testnet" })])).problems.length > 0);
  assert.ok(replayGovernance(init, parseEscrowEvents([ev("guardian_proposed", { guardian: "g.testnet", proposed: "n.testnet" }), ev("guardian_rotated", { old_guardian: "g.testnet", guardian: "x.testnet" })])).problems.length > 0);
});

test("judge chain replays appends and flags an apply without a proposal", () => {
  const p = { model_a: "c/3", model_b: "d/3" };
  const ok = replayGovernance(init, parseEscrowEvents([ev("judge_pair_proposed", p), ev("judge_pair_applied", p)]));
  assert.equal(ok.chain.length, 3); assert.deepEqual(ok.problems, []);
  assert.ok(replayGovernance(init, parseEscrowEvents([ev("judge_pair_applied", p)])).problems.length > 0);
});

// AS1 (D-ASSET1): asset events replay.
const DAY_NS = 86_400_000_000_000;
const lim = { min_per_side: "1000", max_per_side: "9", min_fee_per_side: "10", min_fee_cap_per_side: "50", run_price: "5", min_bond: "1", min_objection: "1", storage_per_kib: "1" };
const prop = (id: string, reenable = false, at = 100) => ev("asset_proposed", { token_id: id, limit: lim, reenable, proposed_at_ns: at, effective_at_ns: at + DAY_NS });
const appl = (id: string, reenable = false) => ev("asset_applied", { token_id: id, limit: lim, reenable, proposed_at_ns: 100, effective_at_ns: 100 + DAY_NS });
const ainit = { ...init, assets: ["usdc", "btc"] };
const run = (...lines: string[]) => replayGovernance(ainit, parseEscrowEvents(lines));

test("AS1: propose then apply appends an asset; cancel clears the pending one; disable then re-enable via the 24h path", () => {
  const a = run(prop("eth"), appl("eth"));
  assert.deepEqual(a.problems, []); assert.deepEqual(a.assets, ["usdc", "btc", "eth"]); assert.equal(a.pendingAsset, null);
  const b = run(prop("eth"));
  assert.equal(b.pendingAsset?.token_id, "eth");
  const c = run(prop("eth"), ev("asset_cancelled", { token_id: "eth" }), prop("zec"), appl("zec"));
  assert.deepEqual(c.problems, []); assert.deepEqual(c.assets, ["usdc", "btc", "zec"]);
  const d = run(ev("asset_disabled", { token_id: "btc" }), prop("btc", true), appl("btc", true));
  assert.deepEqual(d.problems, []); assert.deepEqual(d.disabledAssets, []); assert.deepEqual(d.assets, ["usdc", "btc"]);
  const e = run(ev("asset_disabled", { token_id: "btc" }));
  assert.deepEqual(e.disabledAssets, ["btc"]); assert.deepEqual(e.problems, []);
});

test("AS1: every inconsistency is a problem (no removal, no replacement, no skipped delay, no second pending)", () => {
  const bad = (...l: string[]) => assert.ok(run(...l).problems.length > 0, l.join(" | "));
  bad(appl("eth"));                                             // apply with nothing pending
  bad(prop("eth"), appl("zec"));                                // apply a different asset
  bad(prop("eth"), prop("zec"));                                // two pending
  bad(prop("btc"));                                             // replacing an enabled table asset
  bad(prop("eth", true));                                       // re-enable of an unknown asset
  bad(prop("btc", true));                                       // re-enable of an enabled asset
  bad(ev("asset_cancelled", {}));                               // cancel nothing
  bad(ev("asset_disabled", { token_id: "nope" }));              // disable unknown
  bad(ev("asset_disabled", { token_id: "btc" }), ev("asset_disabled", { token_id: "btc" }));
  bad(ev("asset_proposed", { token_id: "eth", limit: lim, reenable: false, proposed_at_ns: 100, effective_at_ns: 100 + DAY_NS - 1 })); // short delay
  bad(ev("asset_proposed", { token_id: "eth", limit: lim, reenable: false, proposed_at_ns: 100, effective_at_ns: 100 + 7 * DAY_NS }));  // 7d is not the 24h contract
});
