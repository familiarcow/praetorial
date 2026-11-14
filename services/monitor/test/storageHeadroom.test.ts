// RED-first (MON1 / D-RTGAS1): escrow NEAR storage-headroom monitoring.
// headroom = view_account.amount - storage_usage * storage_amount_per_byte.
// Fixtures are real, recorded testnet RPC responses (keyless, read-only)
// for the R3e escrow; no network is touched here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  MIN_HEADROOM_YOCTO,
  PROJECTION_HORIZON_NS,
  computeHeadroom,
  fetchHeadroomSample,
  alertsForStorageHeadroom,
  type HeadroomSample,
} from "../src/storageHeadroom.js";
import { createAlertRunnerState, runAlertTick, type AlertSnapshotProvider } from "../src/runner.js";
import type { Alert } from "../src/alerts.js";
import type { AlertChannel } from "../src/alertChannel.js";

const NEAR = 10n ** 24n;
const HOUR_NS = 3_600_000_000_000;
const ESCROW = "praetorial-r3e-11062012.praetorial-dev-1101.testnet";
const fx = (n: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));
const viewAccount = fx("view_account.testnet.json");
const protocolConfig = fx("protocol_config.testnet.json");

/** fetch double answering the two RPC methods from fixtures. */
function fakeFetch(opts: { account?: unknown; config?: unknown; fail?: boolean } = {}): typeof fetch {
  return (async (_url: unknown, init?: { body?: string }) => {
    if (opts.fail) throw new Error("boom: connection refused");
    const body = JSON.parse(init?.body ?? "{}");
    const payload = body.method === "EXPERIMENTAL_protocol_config" ? opts.config ?? protocolConfig : opts.account ?? viewAccount;
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as unknown as typeof fetch;
}

const S = (tsH: number, headroomNear: number): HeadroomSample => ({
  tsNs: tsH * HOUR_NS,
  headroomYocto: BigInt(Math.round(headroomNear * 1000)) * (NEAR / 1000n),
});

test("constants: 0.5 NEAR floor, 24h horizon", () => {
  assert.equal(MIN_HEADROOM_YOCTO, NEAR / 2n);
  assert.equal(PROJECTION_HORIZON_NS, 24 * HOUR_NS);
});

test("computeHeadroom: amount - storage_usage * per_byte (recorded fixture)", () => {
  const h = computeHeadroom(viewAccount.result, protocolConfig.result);
  assert.equal(h, 6137352119612388099999998n - 523843n * 10n ** 19n);
  assert.ok(h > MIN_HEADROOM_YOCTO);
});

test("fetchHeadroomSample: reads view_account + protocol_config via RPC", async () => {
  const s = await fetchHeadroomSample("https://rpc.invalid", ESCROW, 42, fakeFetch());
  assert.equal(s.tsNs, 42);
  assert.equal(s.headroomYocto, 6137352119612388099999998n - 5238430000000000000000000n);
});

test("fetchHeadroomSample: RPC transport failure throws", async () => {
  await assert.rejects(fetchHeadroomSample("https://rpc.invalid", ESCROW, 0, fakeFetch({ fail: true })), /boom/);
});

test("fetchHeadroomSample: JSON-RPC error / missing fields throw", async () => {
  await assert.rejects(
    fetchHeadroomSample("u", ESCROW, 0, fakeFetch({ account: { error: { name: "UNKNOWN_ACCOUNT" } } })),
    /view_account/,
  );
  await assert.rejects(
    fetchHeadroomSample("u", ESCROW, 0, fakeFetch({ config: { result: { runtime_config: {} } } })),
    /storage_amount_per_byte/,
  );
});

test("healthy fixture headroom -> no alert", async () => {
  const s = await fetchHeadroomSample("u", ESCROW, 1, fakeFetch());
  assert.deepEqual(alertsForStorageHeadroom(ESCROW, [s]), []);
});

test("low headroom (< 0.5 NEAR) -> alert", () => {
  const alerts = alertsForStorageHeadroom(ESCROW, [S(0, 0.49)]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.kind, "storage_headroom");
  assert.equal(alerts[0]!.severity, "critical");
  assert.match(alerts[0]!.detail, /sending NEAR to the escrow account/);
});

test("exactly at the floor does not alert; negative headroom does", () => {
  assert.deepEqual(alertsForStorageHeadroom(ESCROW, [S(0, 0.5)]), []);
  const neg: HeadroomSample = { tsNs: 0, headroomYocto: -1n };
  assert.equal(alertsForStorageHeadroom(ESCROW, [neg]).length, 1);
});

test("negative trend projecting to 0 within 24h -> alert (even above floor)", () => {
  // 1.0 NEAR at t=0h, 0.8 at t=4h: -0.05/h => 16h to zero (<24h)
  const alerts = alertsForStorageHeadroom(ESCROW, [S(0, 1.0), S(4, 0.8)]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.kind, "storage_headroom");
  assert.equal(alerts[0]!.severity, "warning");
  assert.match(alerts[0]!.message, /trend/);
});

test("slow negative trend (> 24h to zero) and flat/rising trends -> no alert", () => {
  assert.deepEqual(alertsForStorageHeadroom(ESCROW, [S(0, 1.0), S(4, 0.99)]), []); // 396h
  assert.deepEqual(alertsForStorageHeadroom(ESCROW, [S(0, 1.0), S(4, 1.0)]), []);
  assert.deepEqual(alertsForStorageHeadroom(ESCROW, [S(0, 0.8), S(4, 1.0)]), []);
});

test("a top-up (headroom jump) resets the trend window", () => {
  // fell fast, then topped up to 5 NEAR: only post-top-up samples count
  assert.deepEqual(alertsForStorageHeadroom(ESCROW, [S(0, 1.0), S(2, 0.6), S(3, 5.0), S(4, 4.999)]), []);
});

function provider(over: Partial<AlertSnapshotProvider>): AlertSnapshotProvider {
  return {
    contractId: ESCROW,
    async fetchInvariantResults() { return new Map(); },
    async fetchDueActions() { return []; },
    async fetchRpcStats() { return { total: 10, errors: 0 }; },
    async fetchContractState() { return { paused: false, shutdown: false }; },
    ...over,
  };
}
function rec(): { channel: AlertChannel; sent: Alert[] } {
  const sent: Alert[] = [];
  return { sent, channel: { async send(a) { sent.push(a); } } };
}
const NS = 1_000_000_000;

test("runAlertTick: healthy headroom sample -> nothing sent", async () => {
  const st = createAlertRunnerState({ stallGraceNs: 60 * NS, cooldownNs: 60 * NS });
  const { channel, sent } = rec();
  await runAlertTick(provider({ fetchStorageHeadroomSample: async () => S(0, 0.9) }), st, channel, 0);
  assert.deepEqual(sent, []);
});

test("runAlertTick: low headroom is delivered through the channel", async () => {
  const st = createAlertRunnerState({ stallGraceNs: 60 * NS, cooldownNs: 60 * NS });
  const { channel, sent } = rec();
  await runAlertTick(provider({ fetchStorageHeadroomSample: async () => S(0, 0.1) }), st, channel, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.kind, "storage_headroom");
});

test("runAlertTick: samples accumulate across ticks; falling trend alerts", async () => {
  const st = createAlertRunnerState({ stallGraceNs: 60 * NS, cooldownNs: 60 * NS });
  const { channel, sent } = rec();
  const samples = [S(0, 1.0), S(4, 0.8)];
  let i = 0;
  const p = provider({ fetchStorageHeadroomSample: async () => samples[i++]! });
  await runAlertTick(p, st, channel, 0);
  assert.equal(sent.length, 0);
  await runAlertTick(p, st, channel, 4 * HOUR_NS);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.message, /trend/);
});

test("runAlertTick: RPC error -> distinct 'cannot check' alert, never silent OK", async () => {
  const st = createAlertRunnerState({ stallGraceNs: 60 * NS, cooldownNs: 60 * NS });
  const { channel, sent } = rec();
  await runAlertTick(
    provider({ fetchStorageHeadroomSample: async () => { throw new Error("rpc 503"); } }),
    st, channel, 0,
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.kind, "storage_headroom_unchecked");
  assert.notEqual(sent[0]!.key, `storage_headroom:${ESCROW}`);
  assert.match(sent[0]!.detail, /rpc 503/);
});

test("runAlertTick: provider without headroom support is unchanged", async () => {
  const st = createAlertRunnerState({ stallGraceNs: 60 * NS, cooldownNs: 60 * NS });
  const { channel, sent } = rec();
  await runAlertTick(provider({}), st, channel, 0);
  assert.deepEqual(sent, []);
});
