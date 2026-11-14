// CF1f: the deployed-tail summarizer (e2e/live-CF1f/count_outcomes.mjs) on synthetic wrangler-tail output.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore plain ESM script
import { summarizeTail } from "../../../e2e/live-CF1f/count_outcomes.mjs";
const ev = (outcome: string, cpu: number, path = "/health", method = "GET") => ({ scriptName: "praetorial-registry-testnet", outcome, cpuTime: cpu, event: { request: { method, url: "https://x.workers.dev" + path } } });
test("summarizeTail counts events, claims, routes, exceededCpu, non-ok, cpu p50/max", () => {
  const text = [ev("ok", 3), ev("ok", 9, "/claim", "POST"), ev("exceededCpu", 10, "/search?q=a"), ev("ok", 7, "/lookup/account/a.testnet"), ev("exception", 1)].map((e, i) => (i % 2 ? JSON.stringify(e) : JSON.stringify(e, null, 2))).join("\n");
  const s = summarizeTail(text);
  assert.equal(s.events, 5); assert.equal(s.claims, 1);
  assert.deepEqual(s.outcomes, { ok: 3, exceededCpu: 1, exception: 1 });
  assert.equal(s.exceededCpu, 1); assert.equal(s.nonOk, 2); assert.equal(s.cpuMax, 10); assert.equal(s.cpuP50, 7);
  assert.equal((s.byRoute as Record<string, number>)["GET /lookup/account"], 1);
  assert.equal(summarizeTail("").events, 0);
});
