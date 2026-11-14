// LH3b (keeper-archive-prod-adapters): the PRODUCTION archive client and
// getRawTerms source, and main() wiring them into tickMulti.
// No network, no chain: injected executors / factories / fake clients only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nacl from "tweetnacl";
import {
  OutLayerArchiveClient, archiveRequestArgs, extractOutlayerOutput, parseArchiveOutput,
  makeGetRawTerms, loadArchiveConfig, buildArchiveWiring,
} from "../src/archiveProd.js";
import { main } from "../src/runner.js";
import { ArchiveStore } from "../src/archiveJob.js";
import { buildArchiveMessage, sha256Hex, verifyArchiveSnapshotPinned } from "@praetorial/common/archiveSnapshot.js";

const RAW = JSON.stringify({ claim: "x", sources_allowed: [{ id: "S1", url: "https://a.example/1" }, { id: "S2", url: "https://b.example/2" }] });
const HASH = sha256Hex(RAW);
const CONTRACT = "escrow.testnet";
const WASM_HASH = "f".repeat(64);
const OUTLAYER = "outlayer.testnet";

// Same JSON shape resolver/wasm-bin main() prints for `mode:"archive"`
// (main.rs ~4900-4965): {bet_id, terms_hash, snapshots:[{source_type,
// source_id, captured_at, terms_hash, body, resolver_sig,
// resolver_pubkey_hex}], failed:[{id,reason}]}; signature is over
// archive_message (pinned byte-for-byte by archive_crosscheck.json).
function resolverOutput(betId: string, seed = 7) {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seed));
  const pk = Buffer.from(kp.publicKey).toString("hex");
  const mk = (id: string, body: string) => {
    const cap = "2026-11-08T10:00:00Z";
    const msg = buildArchiveMessage(betId, id, cap, HASH, sha256Hex(body));
    return {
      source_type: "archive_snapshot", source_id: id, captured_at: cap, terms_hash: HASH, body,
      resolver_sig: Buffer.from(nacl.sign.detached(Buffer.from(msg, "utf8"), kp.secretKey)).toString("hex"),
      resolver_pubkey_hex: pk,
    };
  };
  return { pk, out: { bet_id: betId, terms_hash: HASH, snapshots: [mk("S1", "one")], failed: [{ id: "S2", reason: "blocked: 403" }] } };
}

function txResultWith(output: unknown) {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  return {
    transaction: { hash: "H" },
    receipts_outcome: [
      { outcome: { executor_id: "keeper.testnet", status: { SuccessReceiptId: "x" } } },
      { outcome: { executor_id: OUTLAYER, status: { SuccessValue: b64(JSON.stringify(output)) } } },
    ],
  };
}

test("(b) request args: WasmUrl pinned source + input_data = {mode:archive, bet_id, terms: RAW}", () => {
  const a: any = archiveRequestArgs({ wasmBaseUrl: "https://fastfs.example/w", wasmHash: WASM_HASH, betId: "5", rawTerms: RAW });
  assert.deepEqual(a.source, { WasmUrl: { url: `https://fastfs.example/w/${WASM_HASH}.wasm`, hash: WASM_HASH, build_target: "wasm32-wasip2" } });
  assert.deepEqual(JSON.parse(a.input_data), { mode: "archive", bet_id: "5", terms: RAW });
  assert.equal(a.response_format, "Json");
  assert.ok(a.resource_limits.max_execution_seconds > 0);
});

test("(b) parseArchiveOutput maps the resolver's signed snapshot shape; signing_error / unsigned snapshots go to failed", () => {
  const { pk, out } = resolverOutput("5");
  (out.snapshots as any[]).push({ source_type: "archive_snapshot", source_id: "S3", captured_at: "c", terms_hash: HASH, body: "b", signing_error: "boom" });
  const r = parseArchiveOutput(out, "5");
  assert.equal(r.snapshots.length, 1);
  assert.equal(r.snapshots[0].sourceId, "S1");
  assert.equal(r.snapshots[0].betId, "5");
  assert.equal(r.snapshots[0].resolverPubkeyHex, pk);
  assert.ok(verifyArchiveSnapshotPinned(r.snapshots[0], pk, HASH), "round-trips through the pinned verifier");
  const ids = r.failed.map((f) => f.id).sort();
  assert.deepEqual(ids, ["S2", "S3"]);
  assert.match(r.failed.find((f) => f.id === "S3")!.reason, /boom|sign/);
});

test("(b) parseArchiveOutput refuses output for a different bet or garbage", () => {
  const { out } = resolverOutput("5");
  assert.throws(() => parseArchiveOutput(out, "6"), /bet/i);
  assert.throws(() => parseArchiveOutput(null, "5"), /output/i);
  assert.throws(() => parseArchiveOutput({ snapshots: "no" }, "5"), /output|snapshots/i);
});

test("(b) extractOutlayerOutput reads the OutLayer receipt's SuccessValue JSON; null when absent", () => {
  const { out } = resolverOutput("5");
  assert.deepEqual(extractOutlayerOutput(txResultWith(out), OUTLAYER), out);
  assert.equal(extractOutlayerOutput({ receipts_outcome: [] }, OUTLAYER), null);
});

test("(b) OutLayerArchiveClient: resolves pinned wasm per contract, sends the job, parses the signed snapshots", async () => {
  const { out, pk } = resolverOutput("5");
  const sent: any[] = [];
  const client = new OutLayerArchiveClient({
    outlayerContract: OUTLAYER,
    resolveWasm: async (c) => { assert.equal(c, CONTRACT); return { baseUrl: "https://fastfs.example/w", hash: WASM_HASH }; },
    execute: async (args) => { sent.push(args); return txResultWith(out); },
  });
  const r = await client.runArchiveJob("5", RAW, CONTRACT);
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0].input_data).terms, RAW, "sends the raw term sheet");
  assert.equal(r.snapshots.length, 1);
  assert.ok(verifyArchiveSnapshotPinned(r.snapshots[0], pk, HASH));
  assert.deepEqual(r.failed, [{ id: "S2", reason: "blocked: 403" }]);
});

test("(b) OutLayerArchiveClient: no output (failed run) throws a named error -- never an empty success", async () => {
  const client = new OutLayerArchiveClient({
    outlayerContract: OUTLAYER,
    resolveWasm: async () => ({ baseUrl: "u", hash: WASM_HASH }),
    execute: async () => ({ receipts_outcome: [] }),
  });
  await assert.rejects(client.runArchiveJob("5", RAW, CONTRACT), /no output|failed run/i);
});

// ---- (c) getRawTerms ----
function viewClient(bet: any) {
  return { async view(_c: string, m: string) { if (m === "get_bet") return bet; throw new Error("unexpected " + m); } } as any;
}
const logs: any[] = [];
const logger = { log: (e: any) => logs.push(e) } as any;

test("(c) getRawTerms returns the exact raw terms when sha256 == envelope.terms_hash", async () => {
  const g = makeGetRawTerms(viewClient({ envelope: { terms_hash: HASH, keep_terms: true, terms: RAW } }), logger);
  assert.equal(await g(CONTRACT, 5), RAW);
});

test("(c) getRawTerms accepts a sha256:-prefixed terms_hash", async () => {
  const g = makeGetRawTerms(viewClient({ envelope: { terms_hash: "sha256:" + HASH, keep_terms: true, terms: RAW } }), logger);
  assert.equal(await g(CONTRACT, 5), RAW);
});

test("(c) hash mismatch -> logged + null (skipped), never returned", async () => {
  logs.length = 0;
  const g = makeGetRawTerms(viewClient({ envelope: { terms_hash: "0".repeat(64), keep_terms: true, terms: RAW } }), logger);
  assert.equal(await g(CONTRACT, 5), null);
  assert.ok(logs.some((l) => l.status === "error" && /terms_hash/.test(l.detail) && l.bet_id === 5), JSON.stringify(logs));
});

test("(c) hash-only bet (terms null) -> logged + null; missing bet -> null", async () => {
  logs.length = 0;
  const g = makeGetRawTerms(viewClient({ envelope: { terms_hash: HASH, keep_terms: false, terms: null } }), logger);
  assert.equal(await g(CONTRACT, 5), null);
  assert.ok(logs.some((l) => /hash-only|no raw/i.test(l.detail)));
  const g2 = makeGetRawTerms(viewClient(null), logger);
  assert.equal(await g2(CONTRACT, 9), null);
});

// ---- (d) config: enabled by default (ops runbook says the keeper archives during the bet) ----
test("(d) loadArchiveConfig: enabled by default; KEEPER_ARCHIVE_ENABLED=0 disables", () => {
  assert.equal(loadArchiveConfig({}).enabled, true);
  assert.equal(loadArchiveConfig({ KEEPER_ARCHIVE_ENABLED: "0" }).enabled, false);
  assert.equal(loadArchiveConfig({ KEEPER_ARCHIVE_ENABLED: "false" }).enabled, false);
  const c = loadArchiveConfig({ ARCHIVE_ATTEST_KEY_FILE: "/k.json", ARCHIVE_DIR: "/d", ARCHIVE_ATTACH_NEAR_YOCTO: "7" });
  assert.equal(c.attestKeyFile, "/k.json");
  assert.equal(c.dir, "/d");
  assert.equal(c.attachYocto, 7n);
  assert.equal(loadArchiveConfig({}).dir, "./data/archive");
});

test("(d) buildArchiveWiring: disabled -> undefined; enabled but no attest key -> undefined + loud log (inert, never crashes)", () => {
  logs.length = 0;
  const f = { makeClient: () => { throw new Error("must not build"); }, makeStore: () => { throw new Error("must not build"); } } as any;
  assert.equal(buildArchiveWiring({ KEEPER_ARCHIVE_ENABLED: "0" }, viewClient(null), logger, f), undefined);
  assert.equal(buildArchiveWiring({}, viewClient(null), logger, f), undefined);
  assert.ok(logs.some((l) => l.action === "archive" && /ARCHIVE_ATTEST_KEY_FILE/.test(l.detail)));
});

// ---- (a) main() wires both adapters into tickMulti ----
test("(a) main(): archive enabled -> factories build client + store, tickMulti receives archive {client, store, getRawTerms}", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh3b-"));
  const keyFile = path.join(dir, "k.json");
  fs.writeFileSync(keyFile, JSON.stringify({ account_id: "keeper.testnet", public_key: "ed25519:x", private_key: "ed25519:y" }));
  const env = {
    ESCROW_CONTRACT_ID: CONTRACT, INTENTS_CONTRACT_ID: "intents.testnet", KEEPER_KEY_FILE: keyFile,
    KEEPER_RUN_ONCE: "1", KEEPER_LOG_FILE: path.join(dir, "log.jsonl"), KEEPER_STATE_FILE: path.join(dir, "s.json"),
    ARCHIVE_ATTEST_KEY_FILE: path.join(dir, "attest.json"), ARCHIVE_ATTEST_ACCOUNT_ID: "attest1.testnet", ARCHIVE_DIR: path.join(dir, "arch"),
  };
  const built: any = {};
  const fakeClientInstance = { async view() { return "v1"; } } as any;
  let tickOpts: any;
  await main({
    env,
    makeNearClient: async () => fakeClientInstance,
    tickMulti: async (o: any) => { tickOpts = o; return []; },
    archiveFactories: {
      makeClient: (cfg: any) => { built.client = { runArchiveJob: async () => ({ snapshots: [], failed: [] }), cfg }; return built.client; },
      makeStore: (d: string) => { built.store = new ArchiveStore({ dir: d }); built.dir = d; return built.store; },
    },
  } as any);
  assert.ok(tickOpts.archive, "tickMulti got an archive wiring");
  assert.equal(tickOpts.archive.client, built.client);
  assert.equal(tickOpts.archive.store, built.store);
  assert.equal(built.dir, path.join(dir, "arch"));
  assert.equal(typeof tickOpts.archive.getRawTerms, "function");
});

test("(a) main(): KEEPER_ARCHIVE_ENABLED=0 -> tickMulti gets no archive and no factory is invoked", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh3b-"));
  const keyFile = path.join(dir, "k.json");
  fs.writeFileSync(keyFile, JSON.stringify({ account_id: "keeper.testnet", public_key: "ed25519:x", private_key: "ed25519:y" }));
  let tickOpts: any;
  await main({
    env: { ESCROW_CONTRACT_ID: CONTRACT, INTENTS_CONTRACT_ID: "i.testnet", KEEPER_KEY_FILE: keyFile, KEEPER_RUN_ONCE: "1",
      KEEPER_LOG_FILE: path.join(dir, "log.jsonl"), KEEPER_STATE_FILE: path.join(dir, "s.json"), KEEPER_ARCHIVE_ENABLED: "0" },
    makeNearClient: async () => ({ async view() { return "v1"; } }) as any,
    tickMulti: async (o: any) => { tickOpts = o; return []; },
    archiveFactories: { makeClient: () => { throw new Error("no"); }, makeStore: () => { throw new Error("no"); } },
  } as any);
  assert.equal(tickOpts.archive, undefined);
});
