// D-AUDIT5: the keeper is meant to run with a function-call-scoped
// access key, which NEAR protocol forbids from attaching ANY deposit
// to any action, on any method, full stop. `request_resolution`
// accounts for this via the contract's prepaid `keeper_credit` pool
// (drawn when deposit == 0 && payer == self.keeper), but `tick()`
// defaulted `attachedNearYocto` to 0.01 NEAR and always called via
// `callPayable`, so a scoped-key keeper would have every
// `request_resolution` rejected by the NEAR runtime before it ever
// reached the contract. Default must be credit mode (0 attached,
// plain `call`), with an explicit opt-in for a full-access-key /
// BYO-wallet keeper that wants to attach NEAR directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tick } from "../src/runner.js";
import { TxLogger } from "@praetorial/common/logger.js";
import type { Bet, Envelope } from "@praetorial/common/types.js";

const NS = 1_000_000_000;
// tick() uses the real wall clock (Date.now()), unlike policy.ts unit
// tests which inject a synthetic nowNs — so this fixture's deadlines
// must be anchored to actual "now", not a small fake epoch.
const NOW_NS = Date.now() * 1_000_000;

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    bet_id: 1, version: 1, maker: "maker1.testnet", taker_allow: { Any: {} },
    terms_hash: "a".repeat(64),
    maker_asset: "usdc.fakes.testnet", taker_asset: "usdc.fakes.testnet",
    models_snapshot_hash: "d", outcomes: ["YES", "NO"], maker_side: "YES",
    stake_maker: "1000000", stake_taker: "1000000", fee_bps: 100, storage_charge_per_side: "10000", keep_terms: true, max_paid_runs: 3,
    tier: 1, arbiter: null, funding_deadline: NOW_NS - 100 * NS, early_settle_outcome: null,
    finality_delay: 0, settlement_period: 100 * NS, resolve_deadline: NOW_NS + 10_000 * NS, consent_party_controlled: false,
    ...overrides,
  };
}

function betDueForResolution(): Bet {
  return {
    envelope: envelope(), status: "Taken", taker: "taker1.testnet", created_at: 0, taken_at: 0,
    proposed_at: null, outcome: null, used_run_nos: [], runs_used: 0, bonds: [], pre_challenge_outcome: null, challenged_by: null, exhibits: [], rebuttals: [],
    objection_deposits: [], arbiter_submissions: [], amend_count: 0, pending_resolution_request: null,
    last_resolution_raw: null, pruned: false,
    next_expected_run_no: 1, all_results: [], window_extended: false, window_extension_ns: "0",
  };
}

/** Minimal fake NearClient: one bet due for request_resolution, no
 * pending payouts. Records every call/callPayable invocation so the
 * test can assert which path (and what deposit) the keeper used. */
function makeFakeClient() {
  const calls: { kind: "call" | "callPayable"; method: string; attached?: bigint }[] = [];
  const client: any = {
    async view<T>(_contract: string, method: string, args: any): Promise<T> {
      if (method === "get_bet") {
        return (args.bet_id === 1 ? betDueForResolution() : null) as unknown as T;
      }
      if (method === "pending_payouts_view") return [] as unknown as T;
      throw new Error(`unexpected view: ${method}`);
    },
    async call<T>(_contract: string, method: string, _args: any): Promise<T> {
      calls.push({ kind: "call", method });
      return {} as T;
    },
    async callPayable<T>(_contract: string, method: string, _args: any, attached: bigint): Promise<T> {
      calls.push({ kind: "callPayable", method, attached });
      return {} as T;
    },
  };
  return { client, calls };
}

function tmpStatePath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keeper-test-")), "keeper-state.json");
}

test("tick() defaults request_resolution to zero-deposit credit mode (scoped-key safe)", async () => {
  const { client, calls } = makeFakeClient();
  const logger = new TxLogger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keeper-test-")), "log.jsonl"));

  await tick({
    client,
    escrowContract: "escrow.testnet",
    logger,
    statePath: tmpStatePath(),
    // No attachedNearYocto override: this is the scoped-key keeper's
    // default posture and must never require an attached deposit.
  });

  const rr = calls.filter((c) => c.method === "request_resolution");
  assert.equal(rr.length, 1, "expected exactly one request_resolution call");
  assert.equal(rr[0].kind, "call", "zero-deposit request_resolution must go via plain call(), not callPayable()");
});

test("tick() still supports an explicit opt-in attached deposit for full-access-key keepers", async () => {
  const { client, calls } = makeFakeClient();
  const logger = new TxLogger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keeper-test-")), "log.jsonl"));

  await tick({
    client,
    escrowContract: "escrow.testnet",
    logger,
    statePath: tmpStatePath(),
    attachedNearYocto: BigInt("10000000000000000000000"), // 0.01 NEAR, explicit opt-in
  });

  const rr = calls.filter((c) => c.method === "request_resolution");
  assert.equal(rr.length, 1);
  assert.equal(rr[0].kind, "callPayable");
  assert.equal(rr[0].attached, BigInt("10000000000000000000000"));
});
