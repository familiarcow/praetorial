// LH3 (keeper-archive-wire): the archive job is WIRED into tickMulti, the
// store is file-backed, and a manifest (one-exhibit hash) is written.
// No network, no chain: mocked client, injected clock, temp dirs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nacl from "tweetnacl";
import { tickMulti } from "../src/runner.js";
import { ArchiveStore, ARCHIVE_PERIOD_NS, type ArchiveJobClient } from "../src/archiveJob.js";
import { TxLogger } from "@praetorial/common/logger.js";
import { buildArchiveMessage, sha256Hex, type ArchiveSnapshot } from "@praetorial/common/archiveSnapshot.js";
import type { Bet, Envelope } from "@praetorial/common/types.js";

const NS = 1_000_000_000;
const NOW_NS = Date.now() * 1_000_000;
const RAW_TERMS = JSON.stringify({ claim: "x", sources_allowed: [{ id: "S1", url: "https://a.example/1" }, { id: "S2", url: "https://b.example/2" }] });
const TERMS_HASH = sha256Hex(RAW_TERMS);
const CONTRACT = "escrow.testnet";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lh3-test-"));
}

function bet(status: Bet["status"] = "Taken", terms = TERMS_HASH): Bet {
  const envelope = {
    bet_id: 1, version: 1, maker: "m.testnet", taker_allow: { Any: {} }, terms_hash: terms,
    maker_asset: "u", taker_asset: "u", models_snapshot_hash: "d", outcomes: ["YES", "NO"], maker_side: "YES",
    stake_maker: "100", stake_taker: "100", fee_bps: 100, storage_charge_per_side: "1", keep_terms: true, max_paid_runs: 3,
    tier: 1, arbiter: null, funding_deadline: NOW_NS + 100_000 * NS, early_settle_outcome: null,
    finality_delay: 0, settlement_period: 48 * 3600 * NS, resolve_deadline: NOW_NS + 100_000 * NS, consent_party_controlled: false,
  } as Envelope;
  return {
    envelope, status, taker: "t.testnet", created_at: 0, taken_at: 0, proposed_at: null, outcome: null, used_run_nos: [],
    runs_used: 0, bonds: [], pre_challenge_outcome: null, challenged_by: null, exhibits: [], rebuttals: [],
    objection_deposits: [], arbiter_submissions: [], amend_count: 0, pending_resolution_request: null,
    last_resolution_raw: null, pruned: false, next_expected_run_no: 1, all_results: [], window_extended: false, window_extension_ns: "0",
  } as Bet;
}

function chain(attestPkHex: string, b: Bet = bet()) {
  const calls: { method: string; betId?: number }[] = [];
  const client: any = {
    async view(_c: string, method: string, args: any) {
      if (method === "get_bet") return args.bet_id === 1 ? b : null;
      if (method === "pending_payouts_view") return [];
      if (method === "is_shutdown") return false;
      if (method === "resolver_keys") return ["o".repeat(64), attestPkHex, "wasmhash"];
      throw new Error(`unexpected view ${method}`);
    },
    async call(_c: string, method: string, args: any) { calls.push({ method, betId: args?.bet_id }); return {}; },
    async callPayable(_c: string, method: string, args: any) { calls.push({ method, betId: args?.bet_id }); return {}; },
  };
  return { client, calls };
}

function snap(kp: nacl.SignKeyPair, sourceId: string, body: string, capturedAt = "2026-11-08T00:00:00Z", termsHash = TERMS_HASH): ArchiveSnapshot {
  const msg = Buffer.from(buildArchiveMessage("1", sourceId, capturedAt, termsHash, sha256Hex(body)), "utf8");
  return {
    betId: "1", sourceId, capturedAt, termsHash, body,
    resolverPubkeyHex: Buffer.from(kp.publicKey).toString("hex"),
    signatureHex: Buffer.from(nacl.sign.detached(msg, kp.secretKey)).toString("hex"),
  };
}

function readLog(p: string): any[] {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

function rig(opts: { clientImpl?: ArchiveJobClient["runArchiveJob"]; b?: Bet; dir?: string } = {}) {
  const kp = nacl.sign.keyPair();
  const dir = opts.dir ?? tmp();
  const { client, calls } = chain(Buffer.from(kp.publicKey).toString("hex"), opts.b);
  const logPath = path.join(dir, "log.jsonl");
  const logger = new TxLogger(logPath);
  const runs: Array<{ betId: string; rawTerms: string }> = [];
  let nowMs = Date.parse("2026-11-08T00:00:00Z");
  const archClient: ArchiveJobClient = {
    async runArchiveJob(betId, rawTerms) {
      runs.push({ betId, rawTerms });
      if (opts.clientImpl) return opts.clientImpl(betId, rawTerms);
      return { snapshots: [snap(kp, "S1", "body-one"), snap(kp, "S2", "body-two")], failed: [] };
    },
  };
  const store = new ArchiveStore({ dir: path.join(dir, "archive") });
  const tickOnce = () =>
    tickMulti({
      client, contracts: [{ id: CONTRACT, version: "v1" }], logger, statePath: path.join(dir, "state.json"),
      archive: { client: archClient, store, getRawTerms: async () => RAW_TERMS, nowMs: () => nowMs },
    });
  return { kp, dir, calls, runs, store, tickOnce, logPath, advance: (ns: bigint) => { nowMs += Number(ns / 1_000_000n); } };
}

test("(a) runner archives a Taken bet on first sight, then only every 6h (fake clock)", async () => {
  const r = rig();
  await r.tickOnce();
  assert.equal(r.runs.length, 1, "first sight -> archive");
  assert.equal(r.runs[0].rawTerms, RAW_TERMS);
  await r.tickOnce();
  assert.equal(r.runs.length, 1, "same instant -> not due");
  r.advance(ARCHIVE_PERIOD_NS - 1_000_000n); // 1 ms short (clock is ms)
  await r.tickOnce();
  assert.equal(r.runs.length, 1, "just under 6h -> not due");
  r.advance(1_000_000n);
  await r.tickOnce();
  assert.equal(r.runs.length, 2, "6h elapsed -> archive again");
});

test("(a) schedule state survives a restart: no re-archive straight after reboot", async () => {
  const r = rig();
  await r.tickOnce();
  // second tickMulti call == restart (fresh in-memory state, same files)
  await r.tickOnce();
  assert.equal(r.runs.length, 1);
});

test("(a) non-live bets (Open) are never archived; no submit_exhibits is ever called during Taken", async () => {
  const open = rig({ b: bet("Open") });
  await open.tickOnce();
  assert.equal(open.runs.length, 0);
  const taken = rig();
  await taken.tickOnce();
  assert.equal(taken.runs.length, 1);
  assert.ok(!taken.calls.some((c) => c.method === "submit_exhibits"), "contract refuses submit_exhibits during Taken");
});

test("(b) snapshots survive a keeper restart (file-backed store)", async () => {
  const r = rig();
  await r.tickOnce();
  const reloaded = new ArchiveStore({ dir: path.join(r.dir, "archive") });
  const got = reloaded.get("1");
  assert.deepEqual(got.map((s) => s.sourceId).sort(), ["S1", "S2"]);
  assert.equal(got.find((s) => s.sourceId === "S1")!.body, "body-one");
});

test("(b) store dedupes an identical snapshot stored twice", () => {
  const kp = nacl.sign.keyPair();
  const pk = Buffer.from(kp.publicKey).toString("hex");
  const store = new ArchiveStore({ dir: path.join(tmp(), "a") });
  const s = snap(kp, "S1", "b");
  store.store("1", pk, TERMS_HASH, [s]);
  store.store("1", pk, TERMS_HASH, [s]);
  assert.equal(new ArchiveStore({ dir: (store as any).dir }).get("1").length, 1);
});

test("(c) wrong resolver key or wrong terms hash is dropped AND never reaches disk", () => {
  const good = nacl.sign.keyPair();
  const evil = nacl.sign.keyPair();
  const pk = Buffer.from(good.publicKey).toString("hex");
  const dir = path.join(tmp(), "a");
  const store = new ArchiveStore({ dir });
  const kept = store.store("1", pk, TERMS_HASH, [
    snap(evil, "S1", "evil"),
    snap(good, "S2", "wrong-terms", "2026-11-08T00:00:00Z", "f".repeat(64)),
    snap(good, "S3", "fine"),
  ]);
  assert.deepEqual(kept.map((s) => s.sourceId), ["S3"]);
  assert.deepEqual(new ArchiveStore({ dir }).get("1").map((s) => s.sourceId), ["S3"]);
});

test("(d) manifest: bet id, source ids, sha256 per snapshot, captured_at; own sha256 logged and matches the file", async () => {
  const r = rig();
  await r.tickOnce();
  const m = r.store.writeManifest("1");
  assert.ok(m);
  const bytes = fs.readFileSync(m!.path);
  assert.equal(sha256Hex(bytes.toString("utf8")), m!.sha256, "manifest sha256 is the sha256 of the file bytes");
  const parsed = JSON.parse(bytes.toString("utf8"));
  assert.equal(parsed.bet_id, "1");
  assert.deepEqual(
    parsed.snapshots.map((s: any) => [s.source_id, s.sha256, s.captured_at]),
    [
      ["S1", sha256Hex("body-one"), "2026-11-08T00:00:00Z"],
      ["S2", sha256Hex("body-two"), "2026-11-08T00:00:00Z"],
    ],
  );
  // deterministic: rewriting yields the same hash
  assert.equal(r.store.writeManifest("1")!.sha256, m!.sha256);
  // the keeper printed it so a party can submit it
  const entry = readLog(r.logPath).find((e) => e.action === "archive_manifest");
  assert.ok(entry, "archive_manifest log line");
  assert.match(entry.detail, new RegExp(m!.sha256));
});

test("(d) writeManifest returns null for a bet with no snapshots", () => {
  assert.equal(new ArchiveStore({ dir: path.join(tmp(), "a") }).writeManifest("9"), null);
});

test("(e) one source failing is logged; the other source is kept", async () => {
  const k = nacl.sign.keyPair();
  const dir = tmp();
  const { client, calls } = chain(Buffer.from(k.publicKey).toString("hex"));
  const logPath = path.join(dir, "log.jsonl");
  const store = new ArchiveStore({ dir: path.join(dir, "archive") });
  await tickMulti({
    client, contracts: [{ id: CONTRACT, version: "v1" }], logger: new TxLogger(logPath), statePath: path.join(dir, "s.json"),
    archive: {
      client: { async runArchiveJob() { return { snapshots: [snap(k, "S1", "ok")], failed: [{ id: "S2", reason: "403 blocked" }] }; } },
      store, getRawTerms: async () => RAW_TERMS, nowMs: () => 1,
    },
  });
  assert.deepEqual(store.get("1").map((s) => s.sourceId), ["S1"]);
  const errs = readLog(logPath).filter((e) => e.action === "archive" && e.status === "error");
  assert.equal(errs.length, 1);
  assert.match(errs[0].detail, /S2.*403 blocked/);
  void calls;
});

test("(e) archive job THROWING never stops the keeper's other duties (expire still fires)", async () => {
  const k = nacl.sign.keyPair();
  const dir = tmp();
  // Taken bet whose resolve_deadline is long past + a due-for-request_resolution shape
  const b = bet("Taken");
  (b.envelope as any).settlement_period = 100 * NS;
  (b.envelope as any).resolve_deadline = NOW_NS + 10_000 * NS;
  (b.envelope as any).funding_deadline = NOW_NS - 100 * NS;
  const { client, calls } = chain(Buffer.from(k.publicKey).toString("hex"), b);
  const logPath = path.join(dir, "log.jsonl");
  await tickMulti({
    client, contracts: [{ id: CONTRACT, version: "v1" }], logger: new TxLogger(logPath), statePath: path.join(dir, "s.json"),
    archive: {
      client: { async runArchiveJob() { throw new Error("outlayer down"); } },
      store: new ArchiveStore({ dir: path.join(dir, "archive") }), getRawTerms: async () => RAW_TERMS, nowMs: () => 1,
    },
  });
  assert.ok(readLog(logPath).some((e) => e.action === "archive" && e.status === "error" && /outlayer down/.test(e.detail)));
  assert.ok(calls.some((c) => c.method === "request_resolution"), "request_resolution still executed");
});

test("(e) an unreadable resolver_keys view is logged, not thrown", async () => {
  const k = nacl.sign.keyPair();
  const dir = tmp();
  const { client } = chain(Buffer.from(k.publicKey).toString("hex"));
  const orig = client.view;
  client.view = async (c: string, m: string, a: any) => { if (m === "resolver_keys") throw new Error("rpc down"); return orig(c, m, a); };
  const logPath = path.join(dir, "log.jsonl");
  await tickMulti({
    client, contracts: [{ id: CONTRACT, version: "v1" }], logger: new TxLogger(logPath), statePath: path.join(dir, "s.json"),
    archive: {
      client: { async runArchiveJob() { return { snapshots: [], failed: [] }; } },
      store: new ArchiveStore({ dir: path.join(dir, "archive") }), getRawTerms: async () => RAW_TERMS, nowMs: () => 1,
    },
  });
  assert.ok(readLog(logPath).some((e) => e.action === "archive" && e.status === "error" && /rpc down/.test(e.detail)));
});

test("(f) typed template: raw typed sheet is handed to the resolver job UNCHANGED (resolver materializes the venue URLs); keeper never skips it", async () => {
  const typed = JSON.stringify({ template: "btc_close_at_t", fields: { t_utc: "2026-12-01T00:00:00Z", op: "gte", x_usd: 90000 } });
  const k = nacl.sign.keyPair();
  const dir = tmp();
  const { client } = chain(Buffer.from(k.publicKey).toString("hex"), bet("Taken", sha256Hex(typed)));
  const seen: string[] = [];
  const store = new ArchiveStore({ dir: path.join(dir, "archive") });
  await tickMulti({
    client, contracts: [{ id: CONTRACT, version: "v1" }], logger: new TxLogger(path.join(dir, "l.jsonl")), statePath: path.join(dir, "s.json"),
    archive: {
      client: {
        async runArchiveJob(_b, raw) {
          seen.push(raw);
          return { snapshots: ["S_CB", "S_BS", "S_KR"].map((id) => snap(k, id, `candles-${id}`, "2026-11-08T00:00:00Z", sha256Hex(typed))), failed: [] };
        },
      },
      store, getRawTerms: async () => typed, nowMs: () => 1,
    },
  });
  assert.deepEqual(seen, [typed]);
  assert.deepEqual(store.get("1").map((s) => s.sourceId).sort(), ["S_BS", "S_CB", "S_KR"]);
});
