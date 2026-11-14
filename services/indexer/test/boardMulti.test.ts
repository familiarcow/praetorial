// RED-first (D-UPGRADE1): the multi-contract board/history builders tag
// every entry with the contract id/version it came from, and bets from
// different contracts never collide even if they share a bet_id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpenOffersBoardMulti, buildHistoryMulti } from "../src/board.js";
import type { TaggedBet } from "@praetorial/common/discovery.js";
import type { Bet } from "@praetorial/common/types.js";

function bet(overrides: Partial<Bet>): Bet {
  return {
    envelope: {
      bet_id: 1, version: 1, maker: "maker1.testnet", taker_allow: { Any: {} },
      terms_hash: "x",
      maker_asset: "usdc.fakes.testnet", taker_asset: "usdc.fakes.testnet",
      models_snapshot_hash: "m", outcomes: ["YES", "NO"], maker_side: "YES",
      stake_maker: "100", stake_taker: "100", fee_bps: 100, storage_charge_per_side: "1", keep_terms: true, max_paid_runs: 1,
      tier: 1, arbiter: null, funding_deadline: 100, early_settle_outcome: null,
      finality_delay: 0, settlement_period: 100, resolve_deadline: 1000, consent_party_controlled: false,
    },
    status: "Open", taker: null, created_at: 0, taken_at: null, proposed_at: null,
    outcome: null, used_run_nos: [], runs_used: 0, bonds: [],
    pre_challenge_outcome: null, challenged_by: null, exhibits: [], rebuttals: [],
    objection_deposits: [], arbiter_submissions: [], amend_count: 0,
    pending_resolution_request: null, last_resolution_raw: null, pruned: false,
    next_expected_run_no: 1, all_results: [], window_extended: false, window_extension_ns: "0",
    ...overrides,
  };
}

function tagged(contractId: string, version: string, betId: number, b: Bet): TaggedBet {
  return { betId, bet: b, contractId, version };
}

test("board includes open bets from both contract versions, tagged with contract id", () => {
  const bets = new Map<string, TaggedBet>([
    ["a:1", tagged("escrow-v1.testnet", "v1", 1, bet({ status: "Open" }))],
    ["b:1", tagged("escrow-v2.testnet", "v2", 1, bet({ status: "Open" }))], // same bet_id, different contract
    ["a:2", tagged("escrow-v1.testnet", "v1", 2, bet({ status: "Taken", taker: "t.testnet" }))],
  ]);
  const board = buildOpenOffersBoardMulti(bets);
  assert.equal(board.length, 2);
  assert.deepEqual(
    board.map((o) => `${o.contract_id}:${o.bet_id}`).sort(),
    ["escrow-v1.testnet:1", "escrow-v2.testnet:1"],
  );
  assert.ok(board.every((o) => o.contract_version));
});

test("history across contracts filters by account across both versions", () => {
  const bets = new Map<string, TaggedBet>([
    ["a:1", tagged("escrow-v1.testnet", "v1", 1, bet({ envelope: { ...bet({}).envelope, maker: "alice.testnet" } }))],
    ["b:1", tagged("escrow-v2.testnet", "v2", 1, bet({ envelope: { ...bet({}).envelope, maker: "bob.testnet" } }))],
  ]);
  const h = buildHistoryMulti(bets, "alice.testnet");
  assert.equal(h.length, 1);
  assert.equal(h[0].contract_id, "escrow-v1.testnet");
});
