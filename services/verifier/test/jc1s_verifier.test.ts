// JC1s: the verifier checks B3 under the layout the record was signed with (versioned verification) and shows the judging pair.
import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import { generateResolverKeypair, signOutcome } from "../../common/src/resolverSign.js";
import { checkB3 } from "../src/run.js";

function evidence(result: any, sigHex: string, pubkeyHex: string, extra: any = {}) {
  return {
    escrow: "escrow.testnet", betId: 5,
    pins: { outcome_pubkey: pubkeyHex, attest_pubkey: "", resolver_wasm_hash: "" },
    bet: { envelope: { terms_hash: "t".repeat(64) }, judge_pair_index: extra.pair ?? null },
    submitted: [{ result, signatureHex: sigHex, pubkeyHex }],
    ...extra.top,
  } as any;
}
const res = { bet_id: 5, terms_hash: "t".repeat(64), outcome: "YES", element_results_hash: "e".repeat(64), run_no: 1, checked_until: "77" };

test("B3 passes a JC1s record and reports which pair judged", () => {
  const kp = generateResolverKeypair();
  const r = { ...res, judge_pair_index: 1 };
  const sig = signOutcome("escrow.testnet", r as any, kp.secretKey);
  const out = checkB3(evidence(r, sig, kp.publicKeyHex, { pair: 1 }));
  assert.equal(out.status, "PASS", out.reason);
  assert.match(out.reason, /judge pair 1/);
});

test("B3 fails when the recorded judge_pair_index was tampered after signing", () => {
  const kp = generateResolverKeypair();
  const sig = signOutcome("escrow.testnet", { ...res, judge_pair_index: 0 } as any, kp.secretKey);
  const out = checkB3(evidence({ ...res, judge_pair_index: 1 }, sig, kp.publicKeyHex));
  assert.equal(out.status, "FAIL");
});

test("B3 still verifies an old record (no judge_pair_index) under the legacy layout", async () => {
  const { buildLegacySubmitOutcomeMessage } = await import("../../common/src/resolverSign.js");
  const kp = generateResolverKeypair();
  const sig = Buffer.from(nacl.sign.detached(buildLegacySubmitOutcomeMessage("escrow.testnet", res as any), kp.secretKey)).toString("hex");
  const out = checkB3(evidence(res, sig, kp.publicKeyHex));
  assert.equal(out.status, "PASS", out.reason);
  assert.match(out.reason, /pre-JC1s/);
});

// ---- JC1x: observations are signed (B3) and E1 replays governance
import { governanceReplay } from "../src/run.js";

test("B3 verifies a record whose signature covers model_not_found, and rejects one with the observation dropped", () => {
  const kp = generateResolverKeypair();
  const r = { ...res, outcome: "RETRY", next_check_ns: "99", judge_pair_index: 0, model_not_found: [{ model: "a/b", observed_ns: "123" }] };
  const sig = signOutcome("escrow.testnet", r as any, kp.secretKey);
  assert.equal(checkB3(evidence(r, sig, kp.publicKeyHex, { pair: 0 })).status, "PASS");
  const dropped = { ...r, model_not_found: [] };
  assert.equal(checkB3(evidence(dropped, sig, kp.publicKeyHex, { pair: 0 })).status, "FAIL");
});

test("E1 governance replay reports an unproposed rotation", () => {
  const logs = [`EVENT_JSON:${JSON.stringify({ standard: "praetorial-escrow", version: "1.0.0", event: "guardian_rotated", data: [{ old_guardian: "g", guardian: "x" }] })}`];
  const out = governanceReplay({ governance: { initial: { guardian: "g", chain: [] }, logs } } as any)!;
  assert.ok(out.problems.length > 0);
  assert.equal(governanceReplay({} as any), null);
});

// ---- AS1: E1 replays the asset events and compares to the live asset-table / disabled views
test("AS1: E1 replays asset events and flags a view that disagrees with the replayed table", () => {
  const e = (event: string, data: any) => `EVENT_JSON:${JSON.stringify({ standard: "praetorial-escrow", version: "1.0.0", event, data: [data] })}`;
  const lim = { min_per_side: "1000" };
  const logs = [
    e("asset_proposed", { token_id: "eth", limit: lim, reenable: false, proposed_at_ns: 5, effective_at_ns: 5 + 86_400_000_000_000 }),
    e("asset_applied", { token_id: "eth", limit: lim, reenable: false, proposed_at_ns: 5, effective_at_ns: 5 + 86_400_000_000_000 }),
    e("asset_disabled", { token_id: "usdc" }),
  ];
  const initial = { guardian: "g", chain: [], assets: ["usdc"] };
  const ok = governanceReplay({ governance: { initial, logs, views: { assets: ["eth", "usdc"], disabled_assets: ["usdc"] } } } as any)!;
  assert.deepEqual(ok.problems, []);
  assert.match(ok.note, /2 asset\(s\) \(1 disabled\)/);
  const bad = governanceReplay({ governance: { initial, logs, views: { assets: ["usdc"], disabled_assets: [] } } } as any)!;
  assert.equal(bad.problems.length, 2);
  const forged = governanceReplay({ governance: { initial, logs: [e("asset_applied", { token_id: "eth", reenable: false })] } } as any)!;
  assert.ok(forged.problems.length > 0);
});
