// D-DSY1: version-check alerting + service alert raiser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runVersionCheck, ServiceAlertRaiser, alertForSingleRpc, alertForTerminalUnconfirmed } from "../src/serviceAlerts.js";
import type { Alert } from "../src/alerts.js";

function collector() {
  const sent: Alert[] = [];
  return { sent, channel: { async send(a: Alert) { sent.push(a); } } };
}
const clientOf = (v: string | "dead"): any => ({
  async view() { if (v === "dead") throw new Error("rpc down"); return v; },
});

test("version match -> no alert", async () => {
  const { sent, channel } = collector();
  const res = await runVersionCheck(clientOf("1.4.0"), [{ id: "e.testnet", version: "v1" }], new ServiceAlertRaiser(channel, 0));
  assert.equal(res[0].status, "match");
  assert.equal(sent.length, 0);
});

test("version mismatch -> contract_version_mismatch alert naming label and actual", async () => {
  const { sent, channel } = collector();
  await runVersionCheck(clientOf("2.0.0"), [{ id: "e.testnet", version: "v1" }], new ServiceAlertRaiser(channel, 0));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "contract_version_mismatch");
  assert.match(sent[0].detail, /v1/);
  assert.match(sent[0].detail, /2\.0\.0/);
});

test("unreadable version -> distinct contract_version_unchecked alert", async () => {
  const { sent, channel } = collector();
  await runVersionCheck(clientOf("dead"), [{ id: "e.testnet", version: "v1" }], new ServiceAlertRaiser(channel, 0));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "contract_version_unchecked");
});

test("raiser dedupes the same ongoing condition within the cooldown and re-fires after it", async () => {
  const { sent, channel } = collector();
  let now = 1_000;
  const r = new ServiceAlertRaiser(channel, 100, () => now);
  const a = alertForTerminalUnconfirmed("e.testnet", 7, "disagree", "x");
  await r.raise([a]);
  await r.raise([a]);
  assert.equal(sent.length, 1);
  now += 100;
  await r.raise([a]);
  assert.equal(sent.length, 2);
});

test("single-RPC alert has the documented message", () => {
  const a = alertForSingleRpc();
  assert.equal(a.kind, "terminal_single_rpc");
  assert.match(a.message, /single RPC: terminal outcomes unconfirmed/);
});

test("a throwing channel never throws out of raise()", async () => {
  const r = new ServiceAlertRaiser({ async send() { throw new Error("boom"); } }, 0);
  await r.raise([alertForSingleRpc()]);
});
