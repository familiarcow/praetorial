// RED-first (D-UPGRADE1): discoverAllBetsMulti must scan every
// configured contract (mocked chain, no network) and tag each resulting
// bet with the contract id it came from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverAllBetsMulti } from "../src/discovery.js";
import type { Bet } from "../src/types.js";

function minimalBet(betId: number): Bet {
  return {
    envelope: {
      bet_id: betId, version: 1, maker: "maker.testnet", taker_allow: { Any: {} },
      terms_hash: "x",
      maker_asset: "usdc.fakes.testnet", taker_asset: "usdc.fakes.testnet",
      models_snapshot_hash: "m", outcomes: ["YES", "NO"], maker_side: "YES",
      stake_maker: "100", stake_taker: "100", fee_bps: 100, storage_charge_per_side: "1", keep_terms: true, max_paid_runs: 1,
      tier: 1, arbiter: null, funding_deadline: 100, early_settle_outcome: null,
      finality_delay: 0, settlement_period: 10, resolve_deadline: 1000, consent_party_controlled: false,
    },
    status: "Open", taker: null, created_at: 0, taken_at: null, proposed_at: null,
    outcome: null, used_run_nos: [], runs_used: 0, bonds: [],
    pre_challenge_outcome: null, challenged_by: null, exhibits: [], rebuttals: [],
    objection_deposits: [], arbiter_submissions: [], amend_count: 0,
    pending_resolution_request: null, last_resolution_raw: null, pruned: false,
    next_expected_run_no: 1, all_results: [], window_extended: false, window_extension_ns: "0",
  };
}

/** Mocked chain: two contracts, each with its own bet_id=1..n space. */
function makeMockClient() {
  const chain: Record<string, Record<number, Bet>> = {
    "escrow-v1.testnet": { 1: minimalBet(1), 2: minimalBet(2) },
    "escrow-v2.testnet": { 1: minimalBet(1) },
  };
  return {
    async view<T>(contractId: string, method: string, args: any): Promise<T> {
      if (method === "get_bet") {
        return (chain[contractId]?.[args.bet_id] ?? null) as unknown as T;
      }
      throw new Error(`unexpected view: ${method}`);
    },
  } as any;
}

test("discoverAllBetsMulti scans every configured contract and tags each bet with its contract id", async () => {
  const client = makeMockClient();
  const contracts = [
    { id: "escrow-v1.testnet", version: "v1" },
    { id: "escrow-v2.testnet", version: "v2" },
  ];
  const { bets, newMaxIds } = await discoverAllBetsMulti(client, contracts, {});

  assert.equal(bets.size, 3);
  assert.equal(bets.get("escrow-v1.testnet:1")?.contractId, "escrow-v1.testnet");
  assert.equal(bets.get("escrow-v1.testnet:1")?.version, "v1");
  assert.equal(bets.get("escrow-v1.testnet:2")?.betId, 2);
  assert.equal(bets.get("escrow-v2.testnet:1")?.contractId, "escrow-v2.testnet");
  assert.equal(bets.get("escrow-v2.testnet:1")?.version, "v2");
  assert.equal(newMaxIds["escrow-v1.testnet"], 2);
  assert.equal(newMaxIds["escrow-v2.testnet"], 1);
});

test("discoverAllBetsMulti respects per-contract known max ids on a second scan", async () => {
  const client = makeMockClient();
  const contracts = [{ id: "escrow-v1.testnet", version: "v1" }];
  const first = await discoverAllBetsMulti(client, contracts, {});
  const second = await discoverAllBetsMulti(client, contracts, first.newMaxIds);
  assert.equal(second.newMaxIds["escrow-v1.testnet"], 2);
});
