// SEAM AUDIT (2026-11-02): services/keeper/src/resolverSim.ts (TS)
// <-> contracts/escrow/src/lib.rs submit_outcome (Rust), the run_no
// handshake (invariant I-7 / FM-13, "strict run order, no result
// shopping"). See the seam audit v1 (internal notes) for the full writeup.
//
// Local only: imports the real resolverSim module and a stub NearClient
// (no RPC, no testnet, no services/data files touched).
import { test } from "node:test";
import assert from "node:assert/strict";
import { maybeSubmitOutcome } from "../../services/keeper/src/resolverSim.js";
import { generateResolverKeypair } from "../../services/common/src/resolverSign.js";
import type { Bet, Envelope, SubmittedResult } from "../../services/common/src/types.js";
import type { NearClient } from "../../services/common/src/nearClient.js";

const NS = 1_000_000_000;

function baseEnvelope(resolverPubkeyHex: string, overrides: Partial<Envelope> = {}): Envelope {
  return {
    bet_id: 1,
    version: 1,
    maker: "maker1.testnet",
    taker_allow: { Any: {} },
    terms_hash: "a".repeat(64),
    models_snapshot_hash: "d".repeat(10),
    outcomes: ["YES", "NO"],
    maker_side: "YES",
    stake_maker: "1000000",
    stake_taker: "1000000",
    fee_bps: 100,
    storage_charge_per_side: "10000",
    keep_terms: true,
    max_paid_runs: 3,
    tier: 1,
    arbiter: null,
    funding_deadline: 100 * NS,
    early_settle_outcome: null,
    finality_delay: 0,
    settlement_period: 48 * 3600 * NS,
    resolve_deadline: 10_000 * NS,
    consent_party_controlled: false,
    ...overrides,
  };
}

function baseBet(envelope: Envelope, overrides: Partial<Bet> = {}): Bet {
  return {
    envelope,
    status: "Taken",
    taker: "taker1.testnet",
    created_at: 0,
    taken_at: 1 * NS,
    proposed_at: null,
    outcome: null,
    used_run_nos: [],
    runs_used: 0,
    bonds: [],
    pre_challenge_outcome: null,
    challenged_by: null,
    exhibits: [],
    rebuttals: [],
    objection_deposits: [],
    arbiter_submissions: [],
    amend_count: 0,
    pending_resolution_request: null,
    last_resolution_raw: null,
    pruned: false,
    next_expected_run_no: 1,
    all_results: [],
    window_extended: false,
    window_extension_ns: "0",
    ...overrides,
  };
}

/** Captures the args passed to client.call without touching the network. */
function stubClient(): { client: NearClient; calls: { method: string; args: any }[] } {
  const calls: { method: string; args: any }[] = [];
  const client = {
    async call(_contract: string, method: string, args: any, _gasTgas?: number) {
      calls.push({ method, args });
      return "stub-tx-hash";
    },
  } as unknown as NearClient;
  return { client, calls };
}

test("SEAM: first submit_outcome on a fresh Taken bet uses next_expected_run_no (1), not runs_used (0)", async () => {
  const keypair = generateResolverKeypair();
  const envelope = baseEnvelope(keypair.publicKeyHex);
  const bet = baseBet(envelope); // runs_used: 0, next_expected_run_no: 1 (contract's real init values)
  const { client, calls } = stubClient();

  const outcome = await maybeSubmitOutcome(client, "escrow.testnet", 1, bet, keypair, {});

  assert.equal(outcome.submitted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "submit_outcome");
  const result: SubmittedResult = calls[0].args.result;
  assert.equal(
    result.run_no,
    bet.next_expected_run_no,
    `SEAM MISMATCH: resolverSim sent run_no=${result.run_no} but the contract's ` +
      `submit_outcome only accepts run_no == bet.next_expected_run_no (${bet.next_expected_run_no})`,
  );
  assert.notEqual(
    result.run_no,
    bet.runs_used,
    "run_no must not come from runs_used (0) on a bet's first submission -- that is the bug this test guards against",
  );
});

test("SEAM: resolverSim still computes run_no=2 correctly on a 'Resolving' re-run (runs_used=1, next_expected_run_no=2)", async () => {
  const keypair = generateResolverKeypair();
  const envelope = baseEnvelope(keypair.publicKeyHex);
  const bet = baseBet(envelope, {
    status: "Resolving", // one of the two statuses maybeSubmitOutcome accepts
    runs_used: 1,
    used_run_nos: [1],
    next_expected_run_no: 2,
    all_results: [
      { run_no: 1, outcome: "YES", element_results_hash: "e".repeat(64), checked_until: "1000000000" },
    ],
  });
  const { client, calls } = stubClient();

  await maybeSubmitOutcome(client, "escrow.testnet", 1, bet, keypair, {});

  const result: SubmittedResult = calls[0].args.result;
  assert.equal(result.run_no, 2, "second round must submit run_no=2 (next_expected_run_no), matching I-7");
});

// SEAM MISMATCH (separate finding, not fixed here -- see Seam audit v1.md
// "decision needed" row): the escrow contract's submit_outcome accepts a
// result while bet.status is Taken, Resolving, Challenged, OR Evidence
// (contracts/escrow/src/lib.rs submit_outcome's own `matches!` guard --
// the spec's challenge/evidence/re-judge ladder calls request_resolution
// again from those states). resolverSim.ts's maybeSubmitOutcome only
// proceeds when `bet.status === "Resolving" || bet.status === "Taken"`
// (resolverSim.ts line 31) -- so the testnet resolver simulator can never
// produce a re-judge result once a bet has been challenged, even though
// the contract is willing to accept one. This under-covers the escrow
// side's accepted-state set; it does not let anything invalid through
// (money-safe), but it means the dispute ladder's re-judge step cannot be
// exercised by this harness at all. Recorded as a MISMATCH, not silently
// fixed, because widening resolverSim's guard needs someone to also
// decide how it should pick which round's bond funds the next resolution
// call -- a design question, not a one-line fix.
test("SEAM MISMATCH: resolverSim does not submit for Challenged/Evidence bets, even though escrow's submit_outcome accepts those states", async () => {
  const keypair = generateResolverKeypair();
  const envelope = baseEnvelope(keypair.publicKeyHex);
  for (const status of ["Challenged", "Evidence"] as const) {
    const bet = baseBet(envelope, { status, runs_used: 1, next_expected_run_no: 2 });
    const { client } = stubClient();
    const outcome = await maybeSubmitOutcome(client, "escrow.testnet", 1, bet, keypair, {});
    assert.equal(
      outcome.submitted,
      false,
      `resolverSim currently refuses to submit for status=${status} -- contract would accept it (seam gap, not fixed here)`,
    );
  }
});
