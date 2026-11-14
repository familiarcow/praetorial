// RED-first (theme: desync). Keeper behaviour under dead contract / crash / lag.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tickMulti } from "../src/runner.js";
import { TxLogger } from "@praetorial/common/logger.js";

const NS = 1_000_000_000;
const NOW = Date.now() * 1_000_000;
function bet(over: any = {}): any {
  return {
    envelope: { maker: "m.testnet", funding_deadline: NOW - 10 * NS, resolve_deadline: NOW + 1e5 * NS, settlement_period: 1, early_settle_outcome: null, max_paid_runs: 3 },
    status: "Taken", taker: "t.testnet", proposed_at: null, outcome: null, runs_used: 0, pending_resolution_request: null, ...over,
  };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "keeper-desync-"));
const logger = () => new TxLogger(path.join(tmp(), "log.jsonl"));

test("a dead/removed contract in the list must not stop request_resolution on the live one", async () => {
  const calls: any[] = [];
  const client: any = {
    async view(c: string, m: string, a: any) {
      if (c === "old.testnet") throw new Error("account does not exist");
      if (m === "get_bet") return a.bet_id === 1 ? bet() : null;
      if (m === "pending_payouts_view") return [];
      throw new Error("no view");
    },
    async call(c: string, m: string, a: any) { calls.push({ c, m, id: a.bet_id }); return {}; },
  };
  await tickMulti({ client, contracts: [{ id: "old.testnet", version: "v1" }, { id: "new.testnet", version: "v2" }], logger: logger(), statePath: path.join(tmp(), "s.json") });
  assert.deepEqual(calls, [{ c: "new.testnet", m: "request_resolution", id: 1 }]);
});

test("a corrupt/truncated keeper state file (crash mid-write) must not brick the keeper", async () => {
  const sp = path.join(tmp(), "s.json");
  fs.writeFileSync(sp, '{"maxBetIds": {"new.testn');
  const calls: any[] = [];
  const client: any = {
    async view(_c: string, m: string, a: any) { return m === "get_bet" ? (a.bet_id === 1 ? bet() : null) : []; },
    async call(c: string, m: string, a: any) { calls.push({ c, m, id: a.bet_id }); return {}; },
  };
  await tickMulti({ client, contracts: [{ id: "new.testnet", version: "v1" }], logger: logger(), statePath: sp });
  assert.equal(calls.length, 1);
  JSON.parse(fs.readFileSync(sp, "utf8")); // rewritten as valid JSON
});

test("lastAttempt is durable BEFORE the tx is sent (crash mid-action must not re-fire on restart)", async () => {
  const sp = path.join(tmp(), "s.json");
  let onDiskDuringCall: any = null;
  const client: any = {
    async view(_c: string, m: string, a: any) { return m === "get_bet" ? (a.bet_id === 1 ? bet() : null) : []; },
    async call() { onDiskDuringCall = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, "utf8")) : null; return {}; },
  };
  await tickMulti({ client, contracts: [{ id: "new.testnet", version: "v1" }], logger: logger(), statePath: sp });
  assert.ok(onDiskDuringCall?.lastAttempt?.["new.testnet:request_resolution:1"], "attempt marker must be on disk during the call");
});

// BLOCKED regression: a lagging RPC keeps showing the bet as unresolved (pending
// request not yet visible). Proves the 30s persisted rate limit stops re-sent
// request_resolution across ticks AND across a keeper restart (fresh tickMulti, same state file).
test("lagging RPC: request_resolution is not re-sent within the rate limit, even across restart", async () => {
  const sp = path.join(tmp(), "s.json");
  const calls: any[] = [];
  const client: any = {
    async view(_c: string, m: string, a: any) { return m === "get_bet" ? (a.bet_id === 1 ? bet() : null) : []; },
    async call(c: string, m: string, a: any) { calls.push({ c, m, id: a.bet_id }); return {}; },
  };
  const opts = { client, contracts: [{ id: "new.testnet", version: "v1" }], logger: logger(), statePath: sp };
  await tickMulti(opts);
  await tickMulti(opts);
  await tickMulti({ ...opts, logger: logger() });
  assert.equal(calls.length, 1);
});

// BLOCKED regression: same bet_id on two contracts are independent actions (no bet_id-only keying).
test("same bet_id on two contracts gets an action on each; rate-limit keys are per-contract", async () => {
  const calls: any[] = [];
  const client: any = {
    async view(_c: string, m: string, a: any) { return m === "get_bet" ? (a.bet_id === 1 ? bet() : null) : []; },
    async call(c: string, m: string, a: any) { calls.push({ c, m, id: a.bet_id }); return {}; },
  };
  await tickMulti({ client, contracts: [{ id: "a.testnet", version: "v1" }, { id: "b.testnet", version: "v2" }], logger: logger(), statePath: path.join(tmp(), "s.json") });
  assert.deepEqual(calls.map((x) => x.c).sort(), ["a.testnet", "b.testnet"]);
});
