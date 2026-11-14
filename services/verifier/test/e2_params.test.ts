// PA1b: the params replay is part of E2 -- offline injection, the recorded-R3e live path (events from tx history), and the CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBetChecks, loadEvidenceDir, type CheckResult } from "../src/run.js";
import { collectLive } from "../src/live.js";
import { extractParamsEvents, parseBigJson } from "../src/params.js";
import { ESCROW, loadFixture, replayFetch } from "./live_replay.js";
import { addTx, eventLine, graftParams, DAY, T, USDC } from "./params_live_fx.js";

const here = dirname(fileURLToPath(import.meta.url));
const R3E = join(here, "..", "..", "e2e", "live-runR3e");
const OPTS = { releaseDir: join(here, "..", "..", "..", "resolver", "release"), expectEscrowHash: "f50742358b404ccc7b9a80f9da86e5cd7591e32ccf7371f9e970fbe94ad0b9ed" };
const PFX = JSON.parse(readFileSync(join(here, "fixtures", "pa1b", "params_fixture.json"), "utf8"));

async function liveE2(fx: any, bet: number | undefined = 1): Promise<CheckResult> {
  const rp = replayFetch(fx);
  const ev = await collectLive("testnet", ESCROW, bet, { fetch: rp.fetch, sleep: async () => {} });
  return runBetChecks(ev, OPTS).find((r) => r.id === "E2")!;
}

test("live (recorded R3e, pre-PA1 contract without params views): E2 still PASS and says params were not checked", async () => {
  const fx = loadFixture();
  // what a real node returns for a view on a contract without the method (result-level error, not an RPC error)
  fx.rpc["call_function|protocol_fee_bps|{}"] = { block_hash: "x", block_height: 1, logs: [], error: "wasm execution failed with error: FunctionCallError(MethodResolveError(MethodNotFound))" };
  const e2 = await liveE2(fx);
  assert.equal(e2.status, "PASS", e2.reason);
  assert.match(e2.reason, /params.*not checked.*(PA1|predates|MethodNotFound)/i);
});

test("live: params views + propose/apply in tx history replay to the viewed values -> E2 PASS naming the replay", async () => {
  const fx = loadFixture(); graftParams(fx);
  const e2 = await liveE2(fx);
  assert.equal(e2.status, "PASS", e2.reason);
  assert.match(e2.reason, /params.*1 applied/i);
});

test("live verify-escrow path (no bet id) also runs the params replay", async () => {
  const fx = loadFixture(); graftParams(fx);
  const e2 = await liveE2(fx, undefined);
  assert.equal(e2.status, "PASS", e2.reason);
  assert.match(e2.reason, /params.*1 applied/i);
});

test("live tamper: viewed protocol_fee_bps != replay -> E2 FAIL", async () => {
  const fx = loadFixture(); graftParams(fx, { viewFee: 175 });
  const e2 = await liveE2(fx);
  assert.equal(e2.status, "FAIL");
  assert.match(e2.reason, /protocol_fee_bps/);
});

test("live tamper: apply_params receipt hidden from history -> views no longer replay -> E2 FAIL", async () => {
  const fx = loadFixture(); graftParams(fx);
  delete fx.transactions.PA1bApplyTx; fx.accountTxs = fx.accountTxs.filter((t: any) => t.transaction_hash !== "PA1bApplyTx");
  const e2 = await liveE2(fx);
  assert.equal(e2.status, "FAIL");
});

test("live tamper: applied < 24h after the proposal -> E2 FAIL", async () => {
  const fx = loadFixture(); graftParams(fx, { applyDelayNs: -3_600_000_000_000n });
  const e2 = await liveE2(fx);
  assert.equal(e2.status, "FAIL");
  assert.match(e2.reason, /24h|effective/);
});

test("live: a FAILED apply_params receipt (too early) is ignored, not counted as applied", async () => {
  const fx = loadFixture(); graftParams(fx);
  addTx(fx, "PA1bEarlyApply", "apply_params", T + 3_600_000_000_000n, [eventLine("params_applied", { fee_bps: 200, assets: [] }, T, T + DAY)], false);
  const e2 = await liveE2(fx);
  assert.equal(e2.status, "PASS", e2.reason);
});

test("live: view call failing for a reason other than a missing method is an error, not a silent skip", async () => {
  const fx = loadFixture(); graftParams(fx);
  delete fx.rpc[`call_function|asset_limit|{"asset_id":"${USDC}"}`];
  await assert.rejects(() => liveE2(fx));
});

test("offline injection: ev.params from a recorded file -> E2 PASS, tampered view -> FAIL", () => {
  const mk = () => {
    const ev = loadEvidenceDir(R3E);
    ev.newArgs = { ...ev.newArgs, asset_limits: PFX.new_args.asset_limits };
    ev.params = { views: { protocol_fee_bps: PFX.views.protocol_fee_bps, asset_limit: PFX.views.asset_limit, pending_params: parseBigJson(PFX.views.pending_params_raw) }, events: extractParamsEvents(PFX.receipts) };
    return ev;
  };
  const e2 = runBetChecks(mk(), OPTS).find((r) => r.id === "E2")!;
  assert.equal(e2.status, "PASS", e2.reason);
  assert.match(e2.reason, /params.*2 applied/i);
  const bad = mk(); bad.params!.views.protocol_fee_bps = 99;
  assert.equal(runBetChecks(bad, OPTS).find((r) => r.id === "E2")!.status, "FAIL");
});

test("offline evidence without any params input: E2 PASS and notes params not checked (no views/log supplied)", () => {
  const e2 = runBetChecks(loadEvidenceDir(R3E), OPTS).find((r) => r.id === "E2")!;
  assert.equal(e2.status, "PASS");
  assert.match(e2.reason, /params.*not checked/i);
});

test("CLI: verify-escrow --evidence-dir R3E --params-file <recorded> exits 0 with params replay in E2; tampered file exits 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "pa1b-cli-"));
  const good = join(dir, "params.json"); writeFileSync(good, JSON.stringify(PFX));
  const r = spawnSync(join(here, "..", "verify-escrow"), ["--evidence-dir", R3E, "--params-file", good], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PASS +E2 .*params.*2 applied/m);
  const bad = JSON.parse(JSON.stringify(PFX)); bad.views.protocol_fee_bps = 101;
  const badP = join(dir, "bad.json"); writeFileSync(badP, JSON.stringify(bad));
  const r2 = spawnSync(join(here, "..", "verify-escrow"), ["--evidence-dir", R3E, "--params-file", badP], { encoding: "utf8" });
  assert.equal(r2.status, 1, r2.stdout + r2.stderr);
  assert.match(r2.stdout, /^FAIL +E2 .*protocol_fee_bps/m);
});
