// PA1b: E2 params replay -- current views must equal new() + applied events in order; 24h delay; hard caps.
// Fixtures are recorded-shape data (test/fixtures/pa1b/build.mjs), never the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkParams, extractParamsEvents, parseBigJson, INITIAL_FEE_BPS, type ParamsEvent, type ParamsViews } from "../src/params.js";

const here = dirname(fileURLToPath(import.meta.url));
const loadFx = (): any => JSON.parse(readFileSync(join(here, "fixtures", "pa1b", "params_fixture.json"), "utf8"));
const RUST = readFileSync(join(here, "..", "..", "..", "contracts", "escrow", "src", "lib.rs"), "utf8");
const DAY = 86_400_000_000_000n;

function inputs(fx = loadFx()) {
  const views: ParamsViews = { protocol_fee_bps: fx.views.protocol_fee_bps, asset_limit: fx.views.asset_limit, pending_params: parseBigJson(fx.views.pending_params_raw) };
  return { newArgs: fx.new_args, views, events: extractParamsEvents(fx.receipts) };
}
const verdict = (mut?: (i: ReturnType<typeof inputs>) => void) => { const i = inputs(); mut?.(i); return checkParams(i); };
const ev = (i: ReturnType<typeof inputs>, kind: string, n = 0): ParamsEvent => i.events.filter((e) => e.kind === kind)[n];
const setAtNs = (e: ParamsEvent, ns: bigint) => { e.atNs = ns.toString(); };

test("recorded fixture: views == new() + applied events in order -> PASS", () => {
  const v = verdict();
  assert.deepEqual(v.problems, []);
  assert.equal(v.status, "PASS");
  assert.match(v.summary, /2 applied/);
  assert.match(v.summary, /1 cancelled/);
  assert.match(v.summary, /pending/i);
});

test("event extraction: only successful receipts, standard praetorial-escrow, in block order; ns digits exact", () => {
  const evs = extractParamsEvents(loadFx().receipts);
  assert.deepEqual(evs.map((e) => e.kind), ["proposed", "applied", "proposed", "cancelled", "proposed", "applied", "proposed"]);
  assert.equal(evs[0].data.proposed_at_ns, "1793086400000000000");
  assert.equal(evs[0].data.effective_at_ns, "1793172800000000000");
  assert.equal(evs[0].atNs, "1793086400000000000");
  assert.equal(evs[0].data.fee_bps, 150);
  assert.equal(evs[0].data.assets[0].min_per_side, null);
});

test("parseBigJson keeps u64 ns digits exactly", () => {
  const j = parseBigJson('{"proposed_at_ns":1793086400000000123,"x":5,"c":{"effective_at_ns":1793172800000000123}}');
  assert.equal(j.proposed_at_ns, "1793086400000000123");
  assert.equal(j.c.effective_at_ns, "1793172800000000123");
  assert.equal(j.x, 5);
});

test("event format matches the contract's emit code (drift guard on contracts/escrow/src/lib.rs)", () => {
  for (const e of ["params_proposed", "params_applied", "params_cancelled"]) {
    assert.ok(RUST.includes(`\\"standard\\":\\"praetorial-escrow\\",\\"version\\":\\"1.0.0\\",\\"event\\":\\"${e}\\",\\"data\\":[{}]}}`), `lib.rs no longer emits ${e} in the shape the fixtures assume`);
  }
  assert.ok(RUST.includes('{{\\"fee_bps\\":{},\\"assets\\":[{}],\\"proposed_at_ns\\":{},\\"effective_at_ns\\":{}}}'.replace(/\{\{/g, "{").replace(/\}\}/g, "}")) || RUST.includes('{{\\"fee_bps\\":{},\\"assets\\":[{}],\\"proposed_at_ns\\":{},\\"effective_at_ns\\":{}}}'));
  assert.ok(RUST.includes('\\"asset_id\\":\\"{}\\",\\"min_fee_per_side\\":{},\\"min_per_side\\":{},\\"max_per_side\\":{}'));
  assert.ok(RUST.includes(`pub const PROTOCOL_FEE_BPS_V1: u32 = ${INITIAL_FEE_BPS};`), "initial fee constant drifted");
  assert.ok(RUST.includes("pub const MAX_FEE_BPS: u32 = 200;"));
  assert.ok(RUST.includes("pub const PARAMS_DELAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;"));
});

test("FAIL: current fee differs from new() + applied events", () => {
  const v = verdict((i) => { i.views.protocol_fee_bps = 130; });
  assert.equal(v.status, "FAIL");
  assert.match(v.problems.join("\n"), /protocol_fee_bps.*130.*120/);
});

test("FAIL: viewed asset limit differs from replay (min_fee, min, max each)", () => {
  for (const [field, val] of [["min_fee_per_side", "250000"], ["min_per_side", "6000000"], ["max_per_side", "99999999"]] as const) {
    const v = verdict((i) => { i.views.asset_limit["usdc.fakes.testnet"][field] = val; });
    assert.equal(v.status, "FAIL", field);
    assert.match(v.problems.join("\n"), new RegExp(`usdc.*${field}`), field);
  }
});

test("FAIL: viewed limit for an asset is missing (view returned null)", () => {
  const v = verdict((i) => { i.views.asset_limit["usdt.fakes.testnet"] = null; });
  assert.equal(v.status, "FAIL");
});

test("FAIL: an applied change is missing from the log (views changed without an event)", () => {
  const v = verdict((i) => { i.events = i.events.filter((e) => !(e.kind === "applied" && e.data.fee_bps === 150)); });
  assert.equal(v.status, "FAIL");
});

test("FAIL: applied < 24h after its proposal (block time)", () => {
  const v = verdict((i) => setAtNs(ev(i, "applied", 0), BigInt(ev(i, "proposed", 0).data.proposed_at_ns) + DAY - 1n));
  assert.equal(v.status, "FAIL");
  assert.match(v.problems.join("\n"), /24h|before effective/);
});

test("FAIL: event payload claims an effective time < 24h after proposal", () => {
  const v = verdict((i) => {
    for (const k of ["proposed", "applied"]) { const e = ev(i, k, 0); e.data.effective_at_ns = (BigInt(e.data.proposed_at_ns) + DAY - 1n).toString(); }
  });
  assert.equal(v.status, "FAIL");
  assert.match(v.problems.join("\n"), /24h/);
});

test("PASS boundary: applied exactly at effective_at_ns", () => {
  assert.equal(verdict().status, "PASS"); // fixture's second apply is exactly at effective
  const i = inputs();
  assert.equal(BigInt(ev(i, "applied", 1).atNs), BigInt(ev(i, "applied", 1).data.effective_at_ns));
});

test("FAIL: applied with no matching proposal, or payload differing from the proposal", () => {
  assert.equal(verdict((i) => { i.events = i.events.filter((e) => !(e.kind === "proposed" && e.data.fee_bps === 150)); }).status, "FAIL");
  const v = verdict((i) => { ev(i, "applied", 0).data.fee_bps = 160; });
  assert.equal(v.status, "FAIL");
});

test("FAIL: proposal while another is pending, and cancel/apply with nothing pending", () => {
  assert.equal(verdict((i) => { i.events = i.events.filter((e) => e.kind !== "cancelled"); }).status, "FAIL");
  assert.equal(verdict((i) => { i.events = i.events.filter((e) => !(e.kind === "proposed" && e.data.fee_bps === 120)); }).status, "FAIL");
});

test("FAIL: pending_params view disagrees with the log", () => {
  assert.equal(verdict((i) => { i.views.pending_params = null; }).status, "FAIL");
  assert.equal(verdict((i) => { i.views.pending_params.change.assets[0].min_fee_per_side = "1"; }).status, "FAIL");
  assert.equal(verdict((i) => { i.views.pending_params.effective_at_ns = (BigInt(i.views.pending_params.proposed_at_ns) + DAY - 1n).toString(); }).status, "FAIL");
  // a pending view with no outstanding proposal in the log
  assert.equal(verdict((i) => { i.events = i.events.slice(0, -1); }).status, "FAIL");
});

test("PASS: no events at all and views equal new() values; pending null", () => {
  const i = inputs();
  const v = checkParams({ newArgs: i.newArgs, events: [], views: { protocol_fee_bps: INITIAL_FEE_BPS, asset_limit: Object.fromEntries(i.newArgs.asset_limits.map(([id, l]: any) => [id, l])), pending_params: null } });
  assert.equal(v.status, "PASS", v.problems.join("; "));
});

test("FAIL: no events but a changed view", () => {
  const i = inputs();
  const asset_limit = Object.fromEntries(i.newArgs.asset_limits.map(([id, l]: any) => [id, { ...l }]));
  asset_limit["usdc.fakes.testnet"].max_per_side = "1";
  assert.equal(checkParams({ newArgs: i.newArgs, events: [], views: { protocol_fee_bps: 100, asset_limit, pending_params: null } }).status, "FAIL");
});

// ---- hard caps: consistent tampering (events AND views agree) must still FAIL
function capCase(mutApplied: (d: ParamsEvent["data"]) => void, mutViews: (v: ParamsViews) => void) {
  return verdict((i) => {
    for (const k of ["proposed", "applied"]) mutApplied(ev(i, k, 0).data);
    mutViews(i.views);
  });
}
test("FAIL hard cap: applied fee_bps > 200", () => {
  const v = capCase((d) => { d.fee_bps = 250; }, (w) => { w.protocol_fee_bps = 250; });
  // fee later replaced by applied P3 (120); make that one a no-op so 250 persists
  const w = verdict((i) => { for (const k of ["proposed", "applied"]) { ev(i, k, 0).data.fee_bps = 250; ev(i, k, 1).data.fee_bps = 250; } i.views.protocol_fee_bps = 250; });
  assert.equal(w.status, "FAIL");
  assert.match(w.problems.join("\n"), /200/);
  assert.equal(v.status, "FAIL");
});
test("FAIL hard cap: current protocol_fee_bps view > 200 even with matching log", () => {
  const w = verdict((i) => { for (const k of ["proposed", "applied"]) ev(i, k, 1).data.fee_bps = 201; i.views.protocol_fee_bps = 201; });
  assert.equal(w.status, "FAIL");
  assert.match(w.problems.join("\n"), /200/);
});
test("FAIL hard cap: min_fee_per_side above the pinned per-asset cap (explicit cap and cap-by-default)", () => {
  const set = (asset: string, fee: string) => verdict((i) => {
    for (const k of ["proposed", "applied"]) { const d = ev(i, k, 0).data; d.assets = [{ asset_id: asset, min_fee_per_side: fee, min_per_side: "100000000", max_per_side: "200000000" }]; }
    i.views.asset_limit[asset] = { ...i.views.asset_limit[asset], min_fee_per_side: fee, min_per_side: "100000000", max_per_side: "200000000" };
  });
  // usdc cap 2_500_000 -> 2_500_001 over cap (min 100M so min/20 = 5M does not mask it)
  const a = set("usdc.fakes.testnet", "2500001");
  assert.equal(a.status, "FAIL"); assert.match(a.problems.join("\n"), /cap/);
  // usdt cap defaults to its initial min fee 250_000
  const b = set("usdt.fakes.testnet", "250001");
  assert.equal(b.status, "FAIL"); assert.match(b.problems.join("\n"), /cap/);
});
test("FAIL hard cap: min_per_side > max_per_side; min_fee > min/20; min_fee == 0", () => {
  const apply = (f: Record<string, string>) => verdict((i) => {
    for (const k of ["proposed", "applied"]) ev(i, k, 0).data.assets = [{ asset_id: "usdc.fakes.testnet", min_fee_per_side: null, min_per_side: null, max_per_side: null, ...f }];
    i.views.asset_limit["usdc.fakes.testnet"] = { ...i.views.asset_limit["usdc.fakes.testnet"], ...f };
  });
  const a = apply({ min_per_side: "200000000", max_per_side: "100000000" });
  assert.equal(a.status, "FAIL"); assert.match(a.problems.join("\n"), /min_per_side.*max_per_side|max_per_side/);
  const b = apply({ min_per_side: "1000000", min_fee_per_side: "100000" });
  assert.equal(b.status, "FAIL"); assert.match(b.problems.join("\n"), /\/20|1\/20|5%/);
  const c = apply({ min_fee_per_side: "0" });
  assert.equal(c.status, "FAIL"); assert.match(c.problems.join("\n"), />\s*0|zero/i);
});
test("FAIL: event for an asset not in new() asset_limits", () => {
  const v = verdict((i) => { for (const k of ["proposed", "applied"]) ev(i, k, 0).data.assets[0].asset_id = "nope.testnet"; });
  assert.equal(v.status, "FAIL");
  assert.match(v.problems.join("\n"), /unknown asset|nope\.testnet/);
});
