// RED-first (D-UPGRADE1): tickMulti() end-to-end against a mocked chain
// with two contract versions -- one live, one shut down -- asserting
// the keeper actually calls emergency_refund(bet_id) for every open
// bet on the shut-down one, and normal policy actions still fire on
// the live one. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tickMulti } from "../src/runner.js";
import { TxLogger } from "@praetorial/common/logger.js";
import type { Bet, Envelope } from "@praetorial/common/types.js";

const NS = 1_000_000_000;
const NOW_NS = Date.now() * 1_000_000;

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    bet_id: 1, version: 1, maker: "maker.testnet", taker_allow: { Any: {} },
    terms_hash: "a".repeat(64),
    maker_asset: "usdc.fakes.testnet", taker_asset: "usdc.fakes.testnet",
    models_snapshot_hash: "d", outcomes: ["YES", "NO"], maker_side: "YES",
    stake_maker: "100", stake_taker: "100", fee_bps: 100, storage_charge_per_side: "1", keep_terms: true, max_paid_runs: 3,
    tier: 1, arbiter: null, funding_deadline: NOW_NS + 100_000 * NS, early_settle_outcome: null,
    finality_delay: 0, settlement_period: 48 * 3600 * NS, resolve_deadline: NOW_NS + 100_000 * NS, consent_party_controlled: false,
    ...overrides,
  };
}

function bet(overrides: Partial<Bet> = {}): Bet {
  return {
    envelope: envelope(overrides.envelope as any), status: "Taken", taker: "taker.testnet", created_at: 0,
    taken_at: 0, proposed_at: null, outcome: null, used_run_nos: [], runs_used: 0, bonds: [],
    pre_challenge_outcome: null, challenged_by: null, exhibits: [], rebuttals: [],
    objection_deposits: [], arbiter_submissions: [], amend_count: 0, pending_resolution_request: null,
    last_resolution_raw: null, pruned: false, next_expected_run_no: 1, all_results: [],
    window_extended: false, window_extension_ns: "0",
    ...overrides,
  };
}

function makeMockChainClient() {
  const chain: Record<string, Record<number, Bet | null>> = {
    "escrow-live.testnet": { 1: bet({ status: "Taken" }) }, // nothing due yet
    "escrow-dead.testnet": { 1: bet({ status: "Taken" }), 2: bet({ status: "Open" }), 3: bet({ status: "Settled" }) },
  };
  const calls: { contractId: string; method: string; betId?: number }[] = [];
  const client: any = {
    async view<T>(contractId: string, method: string, args: any): Promise<T> {
      if (method === "get_bet") return (chain[contractId]?.[args.bet_id] ?? null) as unknown as T;
      if (method === "pending_payouts_view") return [] as unknown as T;
      if (method === "is_shutdown") return (contractId === "escrow-dead.testnet") as unknown as T;
      throw new Error(`unexpected view: ${method} on ${contractId}`);
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

function tmpStatePath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keeper-multi-test-")), "keeper-state.json");
}

test("tickMulti calls emergency_refund for every open bet on a shut-down contract, leaves the live contract's bets alone", async () => {
  const { client, calls } = makeMockChainClient();
  const logger = new TxLogger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keeper-multi-test-")), "log.jsonl"));

  await tickMulti({
    client,
    contracts: [
      { id: "escrow-live.testnet", version: "v1" },
      { id: "escrow-dead.testnet", version: "v2" },
    ],
    logger,
    statePath: tmpStatePath(),
  });

  const refundCalls = calls.filter((c) => c.method === "emergency_refund");
  assert.deepEqual(
    refundCalls.map((c) => ({ contractId: c.contractId, betId: c.betId })).sort((a, b) => a.betId! - b.betId!),
    [
      { contractId: "escrow-dead.testnet", betId: 1 },
      { contractId: "escrow-dead.testnet", betId: 2 },
    ],
  );
  // The already-settled bet_id=3 on the dead contract must NOT get refunded.
  assert.ok(!refundCalls.some((c) => c.betId === 3));
  // No call at all went to the live contract (nothing was due).
  assert.ok(!calls.some((c) => c.contractId === "escrow-live.testnet"));
});

test("tickMulti persists per-contract max bet ids across restarts", async () => {
  const { client } = makeMockChainClient();
  const logger = new TxLogger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keeper-multi-test-")), "log.jsonl"));
  const statePath = tmpStatePath();
  const contracts = [{ id: "escrow-dead.testnet", version: "v2" }];

  await tickMulti({ client, contracts, logger, statePath });
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.maxBetIds["escrow-dead.testnet"], 3);
});
