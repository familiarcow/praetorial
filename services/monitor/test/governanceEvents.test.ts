import { test } from "node:test";
import assert from "node:assert/strict";
import { governanceAlerts } from "../src/governanceEvents.js";

const ev = (event: string, data: any) => `EVENT_JSON:${JSON.stringify({ standard: "praetorial-escrow", version: "1.0.0", event, data: [data] })}`;

test("guardian and judge-chain events become alerts; unrelated lines and events are ignored", () => {
  const a = governanceAlerts(["open bet_id=1", ev("guardian_proposed", { guardian: "g", proposed: "n" }), ev("guardian_rotated", { old_guardian: "g", guardian: "n" }), ev("judge_pair_applied", { model_a: "a/1", model_b: "b/1" }), ev("bet_opened", { bet_id: 1 })]);
  assert.deepEqual(a.map((x) => x.event), ["guardian_proposed", "guardian_rotated", "judge_pair_applied"]);
  assert.equal(a[1].severity, "critical");
});

test("AS1 asset events become alerts; a disable is critical", () => {
  const d = { token_id: "nep141:x.near", reenable: false };
  const a = governanceAlerts([ev("asset_proposed", d), ev("asset_applied", d), ev("asset_cancelled", d), ev("asset_disabled", d)]);
  assert.deepEqual(a.map((x) => x.event), ["asset_proposed", "asset_applied", "asset_cancelled", "asset_disabled"]);
  assert.equal(a[0].severity, "warning");
  assert.equal(a[3].severity, "critical");
  assert.match(a[0].message, /24h/);
});
