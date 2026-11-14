// MON4b: feed MON4's SourceCheckTracker from LH3b archive-run results, and raise nearai_credit_exhausted from
// OutLayer run results (run_diagnostics.http_status 402 / credit-quota body; 429 never). Offline, recorded fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nacl from "tweetnacl";
import { tickMulti } from "../src/runner.js";
import { ArchiveStore, ARCHIVE_PERIOD_NS, type ArchiveJobClient } from "../src/archiveJob.js";
import { SourceCheckFeed } from "../src/sourceFeed.js";
import { alertForRunResult, SourceCheckTracker, RUNBOOK_SOURCE, RUNBOOK_NEARAI } from "../../monitor/src/opsAlerts.js";
import { ServiceAlertRaiser } from "../../monitor/src/serviceAlerts.js";
import { TxLogger } from "@praetorial/common/logger.js";
import { buildArchiveMessage, sha256Hex, type ArchiveSnapshot } from "@praetorial/common/archiveSnapshot.js";

const fx = (n: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));
const NS = 1_000_000_000;
const NOW_NS = Date.now() * 1_000_000;
const RAW = JSON.stringify({ claim: "x", sources_allowed: [{ id: "S1", url: "https://a.example/1" }] });
const TH = sha256Hex(RAW);
const CONTRACT = "escrow.testnet";

// ---- pure feed ----
const ctx = { contractId: CONTRACT, betId: 1 };
const bad = { stored: [], failed: [{ id: "S1", reason: "fetch failed: connection refused" }] };
const good = { stored: [{} as ArchiveSnapshot], failed: [] };
function feed() {
  const sent: any[] = [];
  let t = 0; // clock moves 1h per read, so the 15-min raiser cooldown never masks the feed's own dedupe
  const raiser = new ServiceAlertRaiser({ async send(a) { sent.push(a); } }, 15 * 60 * NS, () => (t += 3600 * NS));
  return { sent, f: new SourceCheckFeed(new SourceCheckTracker(3), raiser) };
}

test("3 failing archive runs -> exactly one source_unreachable warning naming the runbook", async () => {
  const { sent, f } = feed();
  await f.observeRun(ctx, bad, 1); await f.observeRun(ctx, bad, 2);
  assert.equal(sent.length, 0);
  await f.observeRun(ctx, bad, 3);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "source_unreachable");
  assert.equal(sent[0].severity, "warning");
  assert.ok(sent[0].detail.includes(RUNBOOK_SOURCE));
});
test("dedupe: further failing runs do not re-alert", async () => {
  const { sent, f } = feed();
  for (let i = 1; i <= 7; i++) await f.observeRun(ctx, bad, i);
  assert.equal(sent.length, 1);
});
test("recovery: a good run after the alert sends one info recovery; another good run sends none", async () => {
  const { sent, f } = feed();
  for (let i = 1; i <= 3; i++) await f.observeRun(ctx, bad, i);
  await f.observeRun(ctx, good, 4); await f.observeRun(ctx, good, 5);
  assert.deepEqual(sent.map((a) => a.severity), ["warning", "info"]);
  assert.ok(sent[1].key.endsWith(":recovered"));
});
test("recovery re-arms: three more failures alert again", async () => {
  const { sent, f } = feed();
  for (let i = 1; i <= 3; i++) await f.observeRun(ctx, bad, i);
  await f.observeRun(ctx, good, 4);
  for (let i = 5; i <= 7; i++) await f.observeRun(ctx, bad, i);
  assert.equal(sent.filter((a) => a.severity === "warning").length, 2);
});
test("a good run in the middle resets the streak", async () => {
  const { sent, f } = feed();
  await f.observeRun(ctx, bad, 1); await f.observeRun(ctx, bad, 2); await f.observeRun(ctx, good, 3);
  await f.observeRun(ctx, bad, 4); await f.observeRun(ctx, bad, 5);
  assert.equal(sent.length, 0);
});
test("unsigned / signing_error entries and thrown runs count as failures", async () => {
  const { sent, f } = feed();
  await f.observeRun(ctx, { stored: [], failed: [{ id: "S1", reason: "snapshot unsigned: signing_error" }] }, 1);
  await f.observeRun(ctx, new Error("OutLayer archive run returned no output (failed run)"), 2);
  await f.observeRun(ctx, bad, 3);
  assert.equal(sent.length, 1);
});
test("429 (source rate limit) is neither a failure nor a success: no alert", async () => {
  const { sent, f } = feed();
  const rl = { stored: [], failed: [{ id: "S1", reason: "HTTP 429 Too Many Requests" }] };
  for (let i = 1; i <= 6; i++) await f.observeRun(ctx, rl, i);
  await f.observeRun(ctx, new Error("HTTP 429"), 7);
  assert.equal(sent.length, 0);
});
test("a run with some good and some failed sources is a failure check", async () => {
  const { sent, f } = feed();
  const mixed = { stored: [{} as ArchiveSnapshot], failed: [{ id: "S2", reason: "timeout" }] };
  for (let i = 1; i <= 3; i++) await f.observeRun(ctx, mixed, i);
  assert.equal(sent.length, 1);
});
test("bets are tracked independently", async () => {
  const { sent, f } = feed();
  await f.observeRun(ctx, bad, 1); await f.observeRun({ ...ctx, betId: 2 }, bad, 2); await f.observeRun(ctx, bad, 3);
  assert.equal(sent.length, 0);
});

// ---- nearai_credit_exhausted from run results ----
test("run_diagnostics.http_status 402 -> nearai_credit_exhausted (critical, runbook)", () => {
  const a = alertForRunResult("keeper", fx("outlayer_run_402"));
  assert.ok(a);
  assert.equal(a!.kind, "nearai_credit_exhausted");
  assert.equal(a!.severity, "critical");
  assert.ok(a!.detail.includes(RUNBOOK_NEARAI));
});
test("credit/quota body rule on a 4xx is a credit failure", () => {
  assert.equal(alertForRunResult("keeper", fx("outlayer_run_body_credit"))?.kind, "nearai_credit_exhausted");
});
test("429 and healthy runs never alert", () => {
  assert.equal(alertForRunResult("keeper", fx("outlayer_run_429")), null);
  assert.equal(alertForRunResult("keeper", fx("outlayer_run_ok")), null);
  assert.equal(alertForRunResult("keeper", null), null);
  assert.equal(alertForRunResult("keeper", { run_diagnostics: [{ http_status: null }] }), null);
});
test("archive run result carrying a 402 diagnostic raises nearai_credit_exhausted through the feed", async () => {
  const { sent, f } = feed();
  await f.observeRun(ctx, { stored: [{} as ArchiveSnapshot], failed: [], raw: fx("outlayer_run_402").output } as any, 1);
  assert.deepEqual(sent.map((a) => a.kind), ["nearai_credit_exhausted"]);
});

// ---- wired through tickMulti ----
function snap(kp: nacl.SignKeyPair): ArchiveSnapshot {
  const capturedAt = "2026-11-08T00:00:00Z";
  const msg = Buffer.from(buildArchiveMessage("1", "S1", capturedAt, TH, sha256Hex("b")), "utf8");
  return { betId: "1", sourceId: "S1", capturedAt, termsHash: TH, body: "b", resolverPubkeyHex: Buffer.from(kp.publicKey).toString("hex"), signatureHex: Buffer.from(nacl.sign.detached(msg, kp.secretKey)).toString("hex") };
}
function wired(impl: (n: number) => Promise<{ snapshots: ArchiveSnapshot[]; failed: any[] }>) {
  const kp = nacl.sign.keyPair();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mon4b-"));
  const b: any = {
    envelope: { bet_id: 1, version: 1, maker: "m", taker_allow: { Any: {} }, terms_hash: TH, maker_asset: "u", taker_asset: "u", models_snapshot_hash: "d", outcomes: ["YES", "NO"], maker_side: "YES", stake_maker: "1", stake_taker: "1", fee_bps: 1, storage_charge_per_side: "1", keep_terms: true, max_paid_runs: 3, tier: 1, arbiter: null, funding_deadline: NOW_NS + 1e5 * NS, early_settle_outcome: null, finality_delay: 0, settlement_period: 48 * 3600 * NS, resolve_deadline: NOW_NS + 1e5 * NS, consent_party_controlled: false },
    status: "Taken", taker: "t", created_at: 0, taken_at: 0, proposed_at: null, outcome: null, used_run_nos: [], runs_used: 0, bonds: [], pre_challenge_outcome: null, challenged_by: null, exhibits: [], rebuttals: [], objection_deposits: [], arbiter_submissions: [], amend_count: 0, pending_resolution_request: null, last_resolution_raw: null, pruned: false, next_expected_run_no: 1, all_results: [], window_extended: false, window_extension_ns: "0",
  };
  const client: any = {
    async view(_c: string, m: string, a: any) {
      if (m === "get_bet") return a.bet_id === 1 ? b : null;
      if (m === "pending_payouts_view") return [];
      if (m === "is_shutdown") return false;
      if (m === "resolver_keys") return ["o".repeat(64), Buffer.from(kp.publicKey).toString("hex"), "h"];
      throw new Error(`unexpected view ${m}`);
    },
    async call() { return {}; }, async callPayable() { return {}; },
  };
  let n = 0; let nowMs = Date.parse("2026-11-08T00:00:00Z");
  const archClient: ArchiveJobClient = { async runArchiveJob() { n++; return impl(n); } };
  const sent: any[] = [];
  const raiser = new ServiceAlertRaiser({ async send(a) { sent.push(a); } }, 15 * 60 * NS, () => nowMs * 1e6);
  const sourceFeed = new SourceCheckFeed(new SourceCheckTracker(3), raiser);
  const store = new ArchiveStore({ dir: path.join(dir, "archive") });
  const logger = new TxLogger(path.join(dir, "l.jsonl"));
  return {
    sent, kp,
    tick: async () => { await tickMulti({ client, contracts: [{ id: CONTRACT, version: "v1" }], logger, statePath: path.join(dir, "s.json"), archive: { client: archClient, store, getRawTerms: async () => RAW, nowMs: () => nowMs }, sourceFeed } as any); nowMs += Number(ARCHIVE_PERIOD_NS / 1_000_000n); },
  };
}
const failImpl = async () => ({ snapshots: [], failed: [{ id: "S1", reason: "fetch failed: ECONNREFUSED" }] });

test("tickMulti: 3 failing 6h archive runs -> one source_unreachable; further runs deduped", async () => {
  const w = wired(failImpl);
  for (let i = 0; i < 5; i++) await w.tick();
  assert.deepEqual(w.sent.map((a) => a.kind), ["source_unreachable"]);
});
test("tickMulti: a signed snapshot after the alert -> recovery", async () => {
  let kpRef: nacl.SignKeyPair;
  const w = wired(async (n) => (n <= 3 ? failImpl() : { snapshots: [snap(kpRef)], failed: [] }));
  kpRef = w.kp;
  for (let i = 0; i < 4; i++) await w.tick();
  assert.deepEqual(w.sent.map((a) => a.severity), ["warning", "info"]);
});
test("tickMulti: 429 failures raise nothing", async () => {
  const w = wired(async () => ({ snapshots: [], failed: [{ id: "S1", reason: "HTTP 429 Too Many Requests" }] }));
  for (let i = 0; i < 5; i++) await w.tick();
  assert.equal(w.sent.length, 0);
});
