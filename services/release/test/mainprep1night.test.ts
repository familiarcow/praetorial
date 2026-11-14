// MAINPREP1: deploy-night helpers. fillOutlayerFields turns the three OutLayer outputs (escrow report-pubkey run, attest
// report-pubkey run, FastFS upload log) into the final release input, refusing anything that does not bind to the right
// account / wasm hash. compareViews checks the deployed escrow's views against the new() args file.
// Fixtures are the real testnet NOKEY1b logs (services/e2e/live-NOKEY1b), whose values ended up in its new_args.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fillOutlayerFields, parseReportPubkeyLog, parseUploadLog, compareViews } from "../src/night.js";

const here = dirname(fileURLToPath(import.meta.url));
const NK = join(here, "..", "..", "e2e", "live-NOKEY1b");
const REL = join(here, "..", "..", "..", "release");
const rd = (p: string) => readFileSync(p, "utf8");
const ESC = "praetorial-frz3-2611100414.praetorial-dev-1101.testnet";
const ATT = "attest1.praetorial-dev-1101.testnet";
const HASH = "8791413ff7943f5e5b99df4c5cafc50cb9baf5696cf32837e1a8afd31baa2473";
const nkArgs = () => JSON.parse(rd(join(NK, "new_args.json")));
const logs = () => ({ outcomeLog: rd(join(NK, "report_pubkey_outcome.log")), attestLog: rd(join(NK, "report_pubkey_attest1.log")), uploadLog: rd(join(NK, "upload.log")) });

test("MAINPREP1 night: parseReportPubkeyLog reads the JSON block of a real report-pubkey log", () => {
  const r = parseReportPubkeyLog(rd(join(NK, "report_pubkey_outcome.log")));
  assert.equal(r.predecessor, ESC);
  assert.equal(r.public_key, "4479e0b6d288cbcc77324b916bfe8296bcd48cb764de87d134bd90584565ef23");
  assert.equal(r.tx, "2F4fRUYeDNwTXfALrJrb3j72UvhxBPnXPGWas9ADFKuT");
});

test("MAINPREP1 night: parseUploadLog returns base URL (no trailing /), sha256 and the hash in the URL", () => {
  const u = parseUploadLog(rd(join(NK, "upload.log")));
  assert.equal(u.baseUrl, "https://test.fastfs.io/praetorial-dev-1101.testnet/outlayer.testnet");
  assert.equal(u.sha256, HASH);
});

test("MAINPREP1 night: fillOutlayerFields reproduces NOKEY1b's new_args pubkeys + wasm_base_url from its logs", () => {
  const draft = JSON.parse(rd(join(REL, "draft-input.mainnet.json")));
  const out = fillOutlayerFields(draft, { ...logs(), escrow: ESC, attestAccount: ATT, resolverHash: HASH });
  const a = nkArgs();
  assert.equal(out.outcome_pubkey, a.outcome_pubkey);
  assert.equal(out.attest_pubkey, a.attest_pubkey);
  assert.equal(out.outlayer_config.wasm_base_url, a.outlayer_config.wasm_base_url);
  assert.equal(draft.outcome_pubkey, "0".repeat(64), "input object must not be mutated");
});

test("MAINPREP1 night: fillOutlayerFields refuses an outcome run whose predecessor is not the escrow", () => {
  assert.throws(() => fillOutlayerFields({ outlayer_config: {} }, { ...logs(), escrow: "escrow.praetorial.near", attestAccount: ATT, resolverHash: HASH }), /outcome.*predecessor/);
});

test("MAINPREP1 night: fillOutlayerFields refuses an attest run from the wrong account, and outcome==attest logs swapped", () => {
  assert.throws(() => fillOutlayerFields({ outlayer_config: {} }, { ...logs(), escrow: ESC, attestAccount: "attest.praetorial.near", resolverHash: HASH }), /attest.*predecessor/);
  const l = logs();
  assert.throws(() => fillOutlayerFields({ outlayer_config: {} }, { outcomeLog: l.attestLog, attestLog: l.outcomeLog, uploadLog: l.uploadLog, escrow: ESC, attestAccount: ATT, resolverHash: HASH }), /predecessor/);
});

test("MAINPREP1 night: fillOutlayerFields refuses an upload of a different wasm hash or a run of a different wasm", () => {
  assert.throws(() => fillOutlayerFields({ outlayer_config: {} }, { ...logs(), escrow: ESC, attestAccount: ATT, resolverHash: "ab".repeat(32) }), /hash/);
});

const viewsFromArgs = (a: any) => ({
  resolver_keys: [a.outcome_pubkey, a.attest_pubkey, a.resolver_wasm_hash],
  outlayer_config: a.outlayer_config,
  judge_chain: a.judge_chain,
  asset_limit: Object.fromEntries(a.asset_limits.map(([id, l]: [string, unknown]) => [id, l])),
  protocol_fee_bps: 100, is_paused: false, is_shutdown: false, contract_version: "0.1.0",
});

test("MAINPREP1 night: compareViews passes when every view equals the args, and names each mismatch", () => {
  const a = nkArgs();
  assert.deepEqual(compareViews(a, viewsFromArgs(a)).filter((l) => !l.ok), []);
  const v = viewsFromArgs(a);
  v.resolver_keys[2] = "00".repeat(32);
  v.is_paused = true;
  const first = a.asset_limits[0][0];
  v.asset_limit[first] = { ...v.asset_limit[first], min_per_side: "1" };
  const bad = compareViews(a, v).filter((l) => !l.ok).map((l) => l.check);
  assert.deepEqual(bad.sort(), [`asset_limit(${first})`, "is_paused", "resolver_keys"].sort());
});

test("MAINPREP1 night: compareViews flags an asset in the args that the contract does not know (null view)", () => {
  const a = nkArgs(); const v = viewsFromArgs(a);
  const first = a.asset_limits[0][0];
  v.asset_limit[first] = null;
  assert.ok(compareViews(a, v).some((l) => !l.ok && l.check === `asset_limit(${first})`));
});
