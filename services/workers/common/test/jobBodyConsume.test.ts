// CF1e3: the dispatcher's service-bound pokes must consume (drain) the callee's response body. CF1e2 saw the OUTER service-bound
// POST /tick events of monitor/notifier end "canceled" (cpu 0, wall ~= the DO's) on 5/5 ticks while the DO events were ok: the caller
// checked r.ok and returned with the response body unread, so the runtime cancelled the still-open subrequest when scheduled() ended.
// The tick itself had run and persisted (DO ok), but its JSON result (alerts raised, errors, skipped) was dropped by the caller.
import { test } from "node:test";
import assert from "node:assert/strict";
import { monitorTickJob } from "../../monitor/src/job.js";
import { notifierTickJob } from "../../notifier/src/job.js";
import { indexerTickJob, indexerGovernanceJob } from "../../indexer/src/job.js";
import { relayerHeartbeatJob } from "../../relayer/src/job.js";

const jobs: [string, any, string][] = [
  ["monitor", monitorTickJob, "MONITOR_SERVICE"], ["notifier", notifierTickJob, "NOTIFIER_SERVICE"],
  ["indexer-tick", indexerTickJob, "INDEXER_SERVICE"], ["indexer-governance", indexerGovernanceJob, "INDEXER_SERVICE"],
  ["relayer-heartbeat", relayerHeartbeatJob, "RELAYER_SERVICE"],
];
for (const [name, job, binding] of jobs) {
  test(`CF1e3: ${name} poke drains the service response body (no "canceled" outer event)`, async () => {
    const res = new Response(JSON.stringify({ ok: true, skipped: false }), { status: 200 });
    const env: any = { [binding]: { fetch: async () => res } };
    await job.run(env, Date.now());
    assert.equal(res.bodyUsed, true, "response body left unread -> runtime cancels the subrequest");
  });
  test(`CF1e3: ${name} poke reports the callee's error body on failure`, async () => {
    const res = new Response(JSON.stringify({ ok: false, error: "boom-detail" }), { status: 500 });
    const env: any = { [binding]: { fetch: async () => res } };
    await assert.rejects(() => job.run(env, Date.now()), (e: any) => /500/.test(String(e.message)) && /boom-detail/.test(String(e.message)));
    assert.equal(res.bodyUsed, true);
  });
}
