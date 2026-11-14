// CF1e3 / D-CF1E3a: the indexer tick CPU gate is what Cloudflare ENFORCES, measured on the DEPLOYED worker (testnet, free plan):
// a single-worker `wrangler tail praetorial-indexer-testnet` over >= 60 consecutive cron ticks must show zero exceededCpu and zero
// non-ok outcomes. The free plan tolerates occasional bursts over 10 ms; it only kills on exceededCpu. cpuTime p50/max are recorded
// (printed here, saved by e2e/live-CF1e3/count_outcomes.mjs into summary.txt). The keeper keeps its 7/8 ms local gate (its own file).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore plain ESM script shared with the CLI
import { summarizeTail } from "../../../e2e/live-CF1e3/count_outcomes.mjs";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../e2e/live-CF1e3");
const MIN_TICKS = 60;

test(`CF1e3 deployed: >= ${MIN_TICKS} consecutive indexer ticks on testnet, zero exceededCpu, zero non-ok`, () => {
  const file = path.join(DIR, "tail_indexer.json");
  assert.ok(fs.existsSync(file), "no deployed evidence: run the 60-tick wrangler tail (see e2e/live-CF1e3/README)");
  const s = summarizeTail(fs.readFileSync(file, "utf8"));
  console.log("CF1e3-DEPLOYED indexer " + JSON.stringify({ events: s.events, ticks: s.ticks, outcomes: s.outcomes, exceededCpu: s.exceededCpu, nonOk: s.nonOk, cpuP50: s.cpuP50, cpuMax: s.cpuMax }));
  assert.ok(s.ticks >= MIN_TICKS, `only ${s.ticks} POST /tick events (< ${MIN_TICKS})`);
  assert.equal(s.exceededCpu, 0, `${s.exceededCpu} exceededCpu events`);
  assert.equal(s.nonOk, 0, `${s.nonOk} non-ok events: ${JSON.stringify(s.outcomes)}`);
});
