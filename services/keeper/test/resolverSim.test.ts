// D3 (D-AUDIT3, 2026-11-02): resolverSim's status guard widened from
// Taken|Resolving to Taken|Resolving|Challenged|Evidence so a re-judge
// round (challenge -> evidence -> fresh request_resolution, which lands
// the bet back in Resolving but the simulator may be asked to act while
// it still reads Challenged/Evidence between steps) can be exercised
// end to end. These are pure status-gate checks -- no real contract call
// ever happens for a status outside the allowed set (verified by making
// the mock client throw if `call` is invoked at all).
import { test } from "node:test";
import assert from "node:assert/strict";
import { maybeSubmitOutcome } from "../src/resolverSim.js";
import { generateResolverKeypair } from "@praetorial/common/resolverSign.js";
import type { Bet, BetStatus, Envelope } from "@praetorial/common/types.js";
import type { NearClient } from "@praetorial/common/nearClient.js";

const NS = 1_000_000_000;

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    bet_id: 1, version: 1, maker: "maker1.testnet", taker_allow: { Any: {} },
    terms_hash: "a".repeat(64),
    maker_asset: "usdc.fakes.testnet", taker_asset: "usdc.fakes.testnet",
    models_snapshot_hash: "d", outcomes: ["YES", "NO"], maker_side: "YES",
    stake_maker: "1000000", stake_taker: "1000000", fee_bps: 100, storage_charge_per_side: "10000", keep_terms: true, max_paid_runs: 3,
    tier: 1, arbiter: null, funding_deadline: 100 * NS, early_settle_outcome: null,
    finality_delay: 0, settlement_period: 100 * NS, resolve_deadline: 10_000 * NS, consent_party_controlled: false,
    ...overrides,
  };
}

function bet(status: BetStatus, overrides: Partial<Bet> = {}): Bet {
  return {
    envelope: envelope({}),
    status,
    taker: "taker1.testnet",
    outcome: null,
    next_expected_run_no: 1,
    runs_used: 0,
    ...overrides,
  } as Bet;
}

function throwingClient(): NearClient {
  return {
    call: async () => {
      throw new Error("must not call the contract for a non-resolvable status");
    },
    view: async () => {
      throw new Error("must not view resolver_keys for a non-resolvable status");
    },
  } as unknown as NearClient;
}

/** D-KEY1: the trusted key is the contract's own `resolver_keys()` view
 * (outcome_pubkey), never a bet envelope field -- Envelope no longer has
 * a resolver_pubkey at all. `viewOutcomePubkey` stands in for whatever
 * the contract's pinned `outcome_pubkey` actually is. */
function clientWith(viewOutcomePubkey: string, onCall?: (method: string) => void): NearClient {
  return {
    call: async (_contract: string, method: string) => {
      onCall?.(method);
      return "ok";
    },
    view: async () => [viewOutcomePubkey, "a".repeat(64), "b".repeat(64)],
  } as unknown as NearClient;
}

for (const status of ["Taken", "Resolving", "Challenged", "Evidence"] as BetStatus[]) {
  test(`resolverSim accepts status=${status} (D3 widened guard) and calls submit_outcome`, async () => {
    const keypair = generateResolverKeypair();
    const b = bet(status);
    let called = false;
    const client = clientWith(keypair.publicKeyHex, (method) => { called = method === "submit_outcome"; });
    const result = await maybeSubmitOutcome(client, "escrow.testnet", 1, b, keypair, {});
    assert.equal(result.submitted, true, `status ${status} should be accepted`);
    assert.equal(called, true, "submit_outcome must actually be attempted");
  });
}

for (const status of ["Open", "Proposed", "Settled", "Voided", "Cancelled", "Expired"] as BetStatus[]) {
  test(`resolverSim rejects status=${status} without ever calling the contract`, async () => {
    const keypair = generateResolverKeypair();
    const b = bet(status);
    const result = await maybeSubmitOutcome(throwingClient(), "escrow.testnet", 1, b, keypair, {});
    assert.equal(result.submitted, false, `status ${status} must be rejected`);
  });
}

// D-KEY1: this is the RED test that proves the fix. Before the fix,
// maybeSubmitOutcome trusted `bet.envelope.resolver_pubkey` (now removed
// from Envelope entirely); a bet claiming our keypair's pubkey would be
// enough to submit, regardless of the contract's actual pinned key. Now
// it must consult resolver_keys() and refuse when the contract's real
// outcome_pubkey differs from ours, even though the bet object below
// (pre-fix) would have "claimed" a match if such a field still existed.
test("resolverSim rejects submission when resolver_keys().outcome_pubkey does not match our key, even for a resolvable status", async () => {
  const keypair = generateResolverKeypair();
  const other = generateResolverKeypair();
  const b = bet("Resolving");
  let called = false;
  const client = clientWith(other.publicKeyHex, () => { called = true; });
  const result = await maybeSubmitOutcome(client, "escrow.testnet", 1, b, keypair, {});
  assert.equal(result.submitted, false, "must refuse when our key isn't the contract's pinned outcome_pubkey");
  assert.equal(called, false, "submit_outcome must never be attempted with the wrong key");
});
