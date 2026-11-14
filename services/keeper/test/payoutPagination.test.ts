// DR-SVC-1 (RED-first): `pending_payouts_view` pages over LIFETIME ledger
// ids including done ones. The keeper used to read only {from:0,limit:200},
// so once >200 lines had ever been scheduled, a new pending line was
// invisible and never drained. The keeper must page until exhausted.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tick, tickMulti } from "../src/runner.js";
import { TxLogger } from "@praetorial/common/logger.js";

const NS = 1_000_000_000;
const NOW_NS = Date.now() * 1_000_000;

function finalizedBet(): any {
  return {
    envelope: {
      bet_id: 1, version: 1, maker: "maker.testnet", taker_allow: { Any: {} }, terms_hash: "a".repeat(64),
      models_snapshot_hash: "d", outcomes: ["YES", "NO"], maker_side: "YES", stake_maker: "100", stake_taker: "100",
      fee_bps: 100, storage_charge_per_side: "1", keep_terms: true, max_paid_runs: 3, tier: 1, arbiter: null,
      funding_deadline: NOW_NS + 100_000 * NS, early_settle_outcome: null, finality_delay: 0,
      settlement_period: 48 * 3600 * NS, resolve_deadline: NOW_NS + 100_000 * NS, consent_party_controlled: false,
    },
    status: "Finalized", taker: "taker.testnet", created_at: 0, taken_at: 0, proposed_at: null, outcome: "YES",
    used_run_nos: [], runs_used: 0, bonds: [], pre_challenge_outcome: null, challenged_by: null, exhibits: [],
    rebuttals: [], objection_deposits: [], arbiter_submissions: [], amend_count: 0, pending_resolution_request: null,
    last_resolution_raw: null, pruned: false, next_expected_run_no: 1, all_results: [],
    window_extended: false, window_extension_ns: "0",
  };
}

// 250 done lines for other (long settled) bets, then ONE pending line for bet 1.
const LINES = [
  ...Array.from({ length: 250 }, (_, i) => ({ id: i + 1, bet_id: 1000 + i, done: true, in_flight: false })),
  { id: 251, bet_id: 1, done: false, in_flight: false },
];

function mockClient(deadId?: string) {
  const calls: { contractId: string; method: string; betId?: number }[] = [];
  const client: any = {
    async view<T>(contractId: string, method: string, args: any): Promise<T> {
      if (method === "get_bet") return (args.bet_id === 1 ? finalizedBet() : null) as T;
      if (method === "is_shutdown") return (contractId === deadId) as unknown as T;
      if (method === "pending_payouts_view") {
        // contract semantics: ids >= from, first `limit`, done lines included.
        return LINES.filter((l) => l.id >= args.from).slice(0, args.limit) as unknown as T;
      }
      throw new Error(`unexpected view ${method}`);
    },
    async call<T>(contractId: string, method: string, args: any): Promise<T> {
      calls.push({ contractId, method, betId: args?.bet_id });
      return {} as T;
    },
    async callPayable<T>(contractId: string, method: string, args: any): Promise<T> {
      calls.push({ contractId, method, betId: args?.bet_id });
      return {} as T;
    },
  };
  return { client, calls };
}

const tmp = (n: string) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keeper-pg-")), n);

test("tick(): pending line behind >200 done lines is still drained", async () => {
  const { client, calls } = mockClient();
  await tick({ client, escrowContract: "escrow.testnet", logger: new TxLogger(tmp("log.jsonl")), statePath: tmp("s.json") });
  assert.deepEqual(calls.filter((c) => c.method === "drain_payouts").map((c) => c.betId), [1]);
});

test("tickMulti(): pending line behind >200 done lines is drained (live and dead contract)", async () => {
  for (const dead of [undefined, "escrow-a.testnet"]) {
    const { client, calls } = mockClient(dead);
    await tickMulti({
      client,
      contracts: [{ id: "escrow-a.testnet", version: "v2" }],
      logger: new TxLogger(tmp("log.jsonl")),
      statePath: tmp("s.json"),
    });
    assert.deepEqual(
      calls.filter((c) => c.method === "drain_payouts").map((c) => c.betId),
      [1],
      `dead=${dead !== undefined}`,
    );
  }
});
