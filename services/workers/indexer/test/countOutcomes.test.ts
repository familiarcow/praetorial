// CF1e3: the deployed-tail summarizer (e2e/live-CF1e3/count_outcomes.mjs) on synthetic wrangler-tail output (pretty and one-line JSON).
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore plain ESM script
import { summarizeTail } from "../../../e2e/live-CF1e3/count_outcomes.mjs";

const ev = (outcome: string, cpu: number, path = "/tick", method = "POST") => ({ scriptName: "praetorial-indexer-testnet", outcome, cpuTime: cpu, wallTime: 50, event: { request: { method, url: "https://x.workers.dev" + path } }, logs: [], exceptions: [] });

test("summarizeTail counts events, outcomes, exceededCpu, non-ok, cpu p50/max", () => {
  const text = [ev("ok", 3), ev("ok", 11), ev("exceededCpu", 10), ev("ok", 7, "/health", "GET"), ev("exception", 1)].map((e, i) => (i % 2 ? JSON.stringify(e) : JSON.stringify(e, null, 2))).join("\n");
  const s = summarizeTail(text);
  assert.equal(s.events, 5); assert.equal(s.ticks, 4);
  assert.deepEqual(s.outcomes, { ok: 3, exceededCpu: 1, exception: 1 });
  assert.equal(s.exceededCpu, 1); assert.equal(s.nonOk, 2);
  assert.equal(s.cpuMax, 11); assert.equal(s.cpuP50, 7);
});

test("summarizeTail ignores braces inside strings and empty input", () => {
  const e = ev("ok", 2); (e as any).logs = [{ message: ["a } { b \" c"] }];
  const s = summarizeTail(JSON.stringify(e) + "\n" + JSON.stringify(ev("ok", 4)));
  assert.equal(s.events, 2); assert.equal(summarizeTail("").events, 0);
});
