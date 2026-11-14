// FUND1b (3): the @live indexer wait is derived from the indexer's documented tick cadence, not a guess.
// Cadence (services/workers/indexer/README.md + keeper wrangler.toml): keeper cron "* * * * *" pokes POST /tick every 60 s;
// each tick reads INDEXER_BATCH_BETS = 12 bets per contract from a sweep cursor; INDEXER_MIN_TICK_INTERVAL_MS = 20 s.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { INDEXER_TICK_MS, INDEXER_BATCH_BETS, indexWaitMs } from "./lib/indexerCadence";

test("constants match the documented cadence (keeper cron + indexer default batch)", () => {
  const root = new URL("../../../services/workers/", import.meta.url);
  assert.match(readFileSync(new URL("keeper/wrangler.toml", root), "utf8"), /crons = \["\* \* \* \* \*"\]/);
  assert.equal(INDEXER_TICK_MS, 60_000);
  assert.match(readFileSync(new URL("indexer/src/env.ts", root), "utf8"), /INDEXER_BATCH_BETS, 12\)/);
  assert.equal(INDEXER_BATCH_BETS, 12);
});

test("wait = a full sweep to reach the bet id (ceil(id/batch) ticks) + 2 ticks of cron/lock slack, never below 3 ticks", () => {
  assert.equal(indexWaitMs(1), 3 * 60_000);
  assert.equal(indexWaitMs(12), 3 * 60_000);
  assert.equal(indexWaitMs(13), 4 * 60_000);
  assert.equal(indexWaitMs(40), 6 * 60_000);
});

test("the wait is a real bound: unknown/zero id still waits the floor", () => {
  assert.equal(indexWaitMs(0), 3 * 60_000);
});
