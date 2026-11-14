// SRCW1 (D-SRCW1) RED/GREEN tests: the sourcecheck Worker core. Pinned to apps/web/lib/sourceCheckClient.ts and the shared
// fixture contracts/escrow/tests/fixtures/sourcecheck_crosscheck.json. Every OutLayer/RPC/NEAR-AI touchpoint is a spy.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import { build } from "esbuild";
import { buildSourceCheckMessage, verifySourceCheckAttestationPinned } from "../../../common/src/sourceCheck.js";
import { handleSourceCheck, parseAllowedOrigins, type SourceCheckDeps } from "../src/core.js";
import { SourceCheckLimiter, memoryStore, IP_PER_HOUR, GLOBAL_PER_DAY } from "../src/limiter.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");
// the web client lives outside the services tsc rootDir: load it dynamically (runtime only, same module the app ships).
const WEB_CLIENT = path.join(ROOT, "apps/web/lib/sourceCheckClient.ts");
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts/escrow/tests/fixtures/sourcecheck_crosscheck.json"), "utf8"));
const cases: Array<{ name: string; ts: any }> = JSON.parse(fs.readFileSync(path.join(ROOT, "resolver/core/tests/fixtures/template_cases.json"), "utf8"));
const GOOD_SHEET = JSON.stringify(cases.find((c) => c.name === "btc_touch_ok")!.ts);
const BAD_SHEET = JSON.stringify({ template: { id: "btc_touch" }, fields: {} });
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5));
const ATTEST_HEX = hex(kp.publicKey);
const ORIGIN = "https://app.praetorial.test";
const NOW_NS = "1700000000000000000";

function guestOutput(terms: string, over: Record<string, unknown> = {}) {
  const spec = sha(terms);
  const sig = nacl.sign.detached(Buffer.from(buildSourceCheckMessage(spec, NOW_NS)), kp.secretKey);
  return { ok: true, spec_hash: spec, checked_at: NOW_NS, unreachable: [], signing: { pubkey_hex: ATTEST_HEX, signature_hex: hex(sig) }, ...over };
}

function mk(over: Partial<SourceCheckDeps> = {}) {
  const spy = { executions: [] as string[], alerts: [] as string[], lints: 0 };
  const limiter = new SourceCheckLimiter(memoryStore());
  const deps: SourceCheckDeps = {
    allowedOrigins: parseAllowedOrigins(ORIGIN),
    limiter,
    lint: (terms) => { spy.lints++; try { return (JSON.parse(terms), []); } catch { return ["not json"]; } },
    chain: {
      pinnedAttestPubkeyHex: async () => ATTEST_HEX,
      execute: async (terms) => { spy.executions.push(terms); return guestOutput(terms); },
    },
    alert: async (m) => { spy.alerts.push(m); },
    nowMs: () => 1_700_000_000_000,
    ...over,
  };
  return { deps, spy };
}
const req = (body: unknown, h: Record<string, string> = {}, method = "POST") =>
  new Request("https://w.example/sourcecheck", { method, headers: { "content-type": "application/json", "cf-connecting-ip": "1.1.1.1", origin: ORIGIN, ...h }, body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined });
const post = (deps: SourceCheckDeps, terms: string, h: Record<string, string> = {}) => handleSourceCheck(req({ mode: "sourcecheck", terms }, h), deps);

// ---- (1) shape pinned against the web client + the shared fixture -------------------------------------------------
test("fixture: the signed message is the shared crosscheck message byte-for-byte", () => {
  assert.equal(buildSourceCheckMessage(fixture.spec_hash, fixture.checked_at), fixture.message);
  assert.equal(Buffer.from(fixture.message, "utf8").toString("hex"), fixture.message_hex);
});

test("shape: the real web client (requestSourceCheck) accepts the Worker's response and the pinned verify passes", async () => {
  const { deps } = mk();
  const { requestSourceCheck } = (await import(WEB_CLIENT)) as any;
  const orig = globalThis.fetch;
  // the Cloudflare edge (not the browser client) supplies cf-connecting-ip; a browser supplies Origin.
  globalThis.fetch = (async (_u: any, init: any) => handleSourceCheck(new Request("https://w.example/sourcecheck", { ...init, headers: { ...init.headers, "cf-connecting-ip": "1.1.1.1", origin: ORIGIN } }), deps)) as any;
  try {
    // checked_at is 1.7e18 ns (2023): use the guest's own value with a matching "now" by stubbing Date.now for the freshness check.
    const realNow = Date.now; Date.now = () => 1_700_000_000_000;
    let att; try { att = await requestSourceCheck(sha(GOOD_SHEET), GOOD_SHEET, "https://w.example/sourcecheck", 5000); } finally { Date.now = realNow; }
    assert.equal(att.checked_at, NOW_NS);
    assert.ok(verifySourceCheckAttestationPinned({ specHash: sha(GOOD_SHEET), checkedAt: att.checked_at, resolverPubkeyHex: ATTEST_HEX, signatureHex: att.signature_hex }, ATTEST_HEX));
  } finally { globalThis.fetch = orig; }
});

test("shape: ok response has exactly {ok,spec_hash,checked_at,unreachable,signing:{pubkey_hex,signature_hex}} and CORS for the web origin", async () => {
  const { deps } = mk();
  const res = await post(deps, GOOD_SHEET);
  assert.equal(res.status, 200);
  const b: any = await res.json();
  assert.equal(b.ok, true); assert.equal(b.spec_hash, sha(GOOD_SHEET)); assert.equal(b.checked_at, NOW_NS);
  assert.deepEqual(b.unreachable, []); assert.deepEqual(Object.keys(b.signing).sort(), ["pubkey_hex", "signature_hex"]);
  assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
});

test("shape: bad requests (wrong mode, non-string terms, bad JSON, wrong method, oversize) are 4xx with zero executions", async () => {
  const { deps, spy } = mk();
  for (const b of [{ mode: "archive", terms: GOOD_SHEET }, { mode: "sourcecheck", terms: 5 }, { mode: "sourcecheck" }, "{nope", { mode: "sourcecheck", terms: "x".repeat(200_000) }]) {
    const r = await handleSourceCheck(req(b), deps); assert.ok(r.status >= 400 && r.status < 500, `${r.status}`);
  }
  assert.equal((await handleSourceCheck(req(null, {}, "GET"), deps)).status, 405);
  assert.equal(spy.executions.length, 0);
});

// ---- (2) execution = plain OutLayer request_execution, signed by the attest signer ---------------------------------
import { OutLayerSourceCheckChain, sourceCheckRequestArgs } from "../src/chain.js";
import { realArchiveFactories } from "../../../keeper/src/archiveProd.js";

const WASM_HASH = "c1fa42424cb7274eb8a3a0ac63afcd6cc5a267b1ffc9d146fdd707dac5bdf6b5";
const BASE = "https://test.fastfs.io/praetorial-dev-1101.testnet/outlayer.testnet";
function fakeNear(over: { output?: (terms: string) => unknown; keys?: string[]; failure?: boolean; neverFinal?: boolean } = {}) {
  const log = { views: [] as string[], sent: [] as any[], polls: 0 };
  const view = async (_c: string, m: string) => { log.views.push(m); return m === "resolver_keys" ? (over.keys ?? ["aa", ATTEST_HEX, WASM_HASH]) : { wasm_base_url: BASE, secrets_profile: "p", secrets_account_id: "a" }; };
  const send = async (args: any) => {
    log.sent.push(args);
    const terms = JSON.parse(args.args.input_data).terms;
    return { hash: "TXH", result: over.neverFinal ? null : { status: over.failure ? { Failure: { x: 1 } } : { SuccessValue: "" }, receipts_outcome: [{ outcome: { executor_id: "outlayer.testnet", status: { SuccessValue: Buffer.from(JSON.stringify((over.output ?? guestOutput)(terms))).toString("base64") } } }] } };
  };
  return { log, view, send };
}
const mkChain = (f: ReturnType<typeof fakeNear>, extra: any = {}) => new OutLayerSourceCheckChain({ escrowContract: "esc.testnet", outlayerContract: "outlayer.testnet", attestAccountId: "attest1.testnet", view: f.view, send: f.send, ...extra });

test("chain: wasm hash from resolver_keys[2], base URL from outlayer_config (views only), request_execution args mirror archiveProd", async () => {
  const f = fakeNear(); const c = mkChain(f);
  assert.equal(await c.pinnedAttestPubkeyHex(), ATTEST_HEX);
  const out: any = await c.execute(GOOD_SHEET);
  assert.equal(out.spec_hash, sha(GOOD_SHEET));
  assert.deepEqual(f.log.views.filter((v) => v === "outlayer_config").length >= 1, true);
  const a = f.log.sent[0];
  assert.equal(a.contractId, "outlayer.testnet"); assert.equal(a.methodName, "request_execution");
  assert.deepEqual(a.args.source, { WasmUrl: { url: `${BASE}/${WASM_HASH}.wasm`, hash: WASM_HASH, build_target: "wasm32-wasip2" } });
  assert.deepEqual(JSON.parse(a.args.input_data), { mode: "sourcecheck", terms: GOOD_SHEET });
  assert.equal(a.args.response_format, "Json");
  assert.equal(a.signerId, "attest1.testnet"); assert.ok(a.attachedDeposit > 0n && a.attachedDeposit <= 400_000_000_000_000_000_000_000n);
});

test("chain parity: same WasmUrl source + resource limits as the keeper's archive client (archiveProd realArchiveFactories)", async () => {
  const seen: any[] = [];
  const f = fakeNear();
  const fac = realArchiveFactories({ networkId: "testnet", outlayerContract: "outlayer.testnet" }, { view: f.view as any }, async () => ({ functionCall: async (a: any) => { seen.push(a); return {}; } }));
  try { await fac.makeClient({ enabled: true, dir: "x", attachYocto: 1n } as any).runArchiveJob("1", GOOD_SHEET, "esc.testnet"); } catch { /* no output: expected, we only capture the args */ }
  const ours = sourceCheckRequestArgs({ wasmBaseUrl: BASE, wasmHash: WASM_HASH, rawTerms: GOOD_SHEET });
  assert.deepEqual(ours.source, seen[0].args.source);
  assert.deepEqual(ours.resource_limits, seen[0].args.resource_limits);
  assert.equal(seen[0].methodName, "request_execution");
});

test("chain: request_execution tx fails or no guest output -> throws (never a partial result)", async () => {
  await assert.rejects(mkChain(fakeNear({ failure: true })).execute(GOOD_SHEET), /outlayer|fail/i);
  await assert.rejects(mkChain(fakeNear({ output: () => null as any })).execute(GOOD_SHEET), /no output|outlayer/i);
});

test("chain: no wasm hash on the escrow view -> throws before any execution", async () => {
  const f = fakeNear({ keys: ["aa", ATTEST_HEX] });
  await assert.rejects(mkChain(f).execute(GOOD_SHEET), /resolver_keys/);
  assert.equal(f.log.sent.length, 0);
});

// ---- (3) fail closed ------------------------------------------------------------------------------------------------
for (const [name, over, status] of [
  ["pubkey != pinned attest key", (t: string) => guestOutput(t, { signing: { pubkey_hex: hex(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).publicKey), signature_hex: "00".repeat(64) } }), 502],
  ["spec_hash != sha256(terms)", (t: string) => guestOutput(t, { spec_hash: "0".repeat(64) }), 502],
  ["signature invalid for the pinned key", (t: string) => guestOutput(t, { signing: { pubkey_hex: ATTEST_HEX, signature_hex: "00".repeat(64) } }), 502],
  ["ok:false with unreachable sources", (t: string) => ({ ok: false, spec_hash: sha(t), unreachable: [{ id: "s1", reason: "http 404" }] }), 502],
  ["ok:true but no signing", (t: string) => { const o: any = guestOutput(t); delete o.signing; return o; }, 502],
  ["ok:true but unreachable non-empty", (t: string) => guestOutput(t, { unreachable: [{ id: "s1", reason: "x" }] }), 502],
] as const) {
  test(`fail closed: ${name} -> ${status}, never ok`, async () => {
    const { deps } = mk({ chain: { pinnedAttestPubkeyHex: async () => ATTEST_HEX, execute: async (t) => over(t) } });
    const res = await post(deps, GOOD_SHEET); const b: any = await res.json();
    assert.equal(res.status, status); assert.equal(b.ok, false); assert.equal(b.signing, undefined); assert.ok(typeof b.reason === "string" && b.reason.length > 0);
  });
}
test("fail closed: unreachable sources are surfaced (client sees them), still not ok", async () => {
  const { deps } = mk({ chain: { pinnedAttestPubkeyHex: async () => ATTEST_HEX, execute: async (t) => ({ ok: false, spec_hash: sha(t), unreachable: [{ id: "s1", reason: "http 404" }] }) } });
  const b: any = await (await post(deps, GOOD_SHEET)).json();
  assert.deepEqual(b.unreachable, [{ id: "s1", reason: "http 404" }]);
});
test("fail closed: OutLayer error -> 502; timeout -> 504; escrow view failure -> 502; all ok:false", async () => {
  for (const [err, status] of [[new Error("rpc boom"), 502], [Object.assign(new Error("deadline"), { name: "SourceCheckTimeout" }), 504]] as const) {
    const { deps } = mk({ chain: { pinnedAttestPubkeyHex: async () => ATTEST_HEX, execute: async () => { throw err; } } });
    const r = await post(deps, GOOD_SHEET); assert.equal(r.status, status); assert.equal(((await r.json()) as any).ok, false);
  }
  const { deps } = mk({ chain: { pinnedAttestPubkeyHex: async () => { throw new Error("view down"); }, execute: async (t) => guestOutput(t) } });
  assert.equal((await post(deps, GOOD_SHEET)).status, 502);
});
test("chain: a never-finalizing execution times out with SourceCheckTimeout", async () => {
  const f = fakeNear({ neverFinal: true });
  await assert.rejects(mkChain(f, { timeoutMs: 30, pollMs: 5 }).execute(GOOD_SHEET), (e: any) => e.name === "SourceCheckTimeout");
});

// ---- (4) lint BEFORE any OutLayer call --------------------------------------------------------------------------------
test("lint first: an invalid sheet -> 4xx with the named problems, zero executions, zero limiter use (spy)", async () => {
  const { deps, spy } = mk({ lint: (t) => (spy2.lints++, ["CUSTOM_RELATIVE_DATE: say a date"]) });
  var spy2 = spy;
  const r = await post(deps, BAD_SHEET); const b: any = await r.json();
  assert.equal(r.status, 422); assert.equal(b.ok, false); assert.deepEqual(b.problems, ["CUSTOM_RELATIVE_DATE: say a date"]);
  assert.equal(spy.executions.length, 0); assert.equal(spy.lints, 1);
});
test("lint first: the shared (web/resolver-parity) linter rejects a real bad btc_touch sheet and accepts the fixture one", async () => {
  const { sharedLint } = await import("../src/lint.js");
  assert.deepEqual(sharedLint(GOOD_SHEET), []);
  assert.ok(sharedLint(BAD_SHEET).length > 0);
  assert.ok(sharedLint("not json").length > 0);
});

// ---- (5) rate limits at the boundary + alert hook ---------------------------------------------------------------------
test("per-IP 10/hour: 10th ok, 11th refused 429 with alert; another IP unaffected; next hour resets", async () => {
  assert.equal(IP_PER_HOUR, 10);
  let now = 1_700_000_000_000;
  const { deps, spy } = mk({ nowMs: () => now });
  for (let i = 1; i <= 10; i++) assert.equal((await post(deps, GOOD_SHEET)).status, 200, `call ${i}`);
  const r = await post(deps, GOOD_SHEET); const b: any = await r.json();
  assert.equal(r.status, 429); assert.equal(b.ok, false); assert.match(b.reason, /rate/i);
  assert.equal(spy.executions.length, 10);
  assert.ok(spy.alerts.some((a) => /per-IP|rate/i.test(a)));
  assert.equal((await post(deps, GOOD_SHEET, { "cf-connecting-ip": "2.2.2.2" })).status, 200);
  now += 3_600_000; assert.equal((await post(deps, GOOD_SHEET)).status, 200);
});
test("global 300/day: 300th ok, 301st refused 429 with alert, across many IPs", async () => {
  assert.equal(GLOBAL_PER_DAY, 300);
  const { deps, spy } = mk();
  for (let i = 1; i <= 300; i++) assert.equal((await post(deps, GOOD_SHEET, { "cf-connecting-ip": `10.0.${Math.floor(i / 10)}.${i % 10}` })).status, 200, `call ${i}`);
  const r = await post(deps, GOOD_SHEET, { "cf-connecting-ip": "9.9.9.9" }); const b: any = await r.json();
  assert.equal(r.status, 429); assert.match(b.reason, /daily|global/i);
  assert.equal(spy.executions.length, 300);
  assert.ok(spy.alerts.some((a) => /global|daily/i.test(a)));
});
test("limiter: a refused-by-global call does not consume the IP's quota; missing client IP fails closed (400)", async () => {
  const l = new SourceCheckLimiter(memoryStore());
  for (let i = 0; i < 300; i++) await l.consume(`ip${i}`, 0);
  assert.equal((await l.consume("fresh", 0)).ok, false);
  const { deps, spy } = mk();
  const r = await handleSourceCheck(new Request("https://w.example/sourcecheck", { method: "POST", headers: { origin: ORIGIN }, body: JSON.stringify({ mode: "sourcecheck", terms: GOOD_SHEET }) }), deps);
  assert.equal(r.status, 400); assert.equal(spy.executions.length, 0);
});

// ---- (6) CORS only for configured web origins -------------------------------------------------------------------------
test("CORS: preflight for the configured origin only; foreign Origin -> 403 and zero executions; no wildcard ever", async () => {
  const { deps, spy } = mk({ allowedOrigins: parseAllowedOrigins(`${ORIGIN}, https://www.praetorial.test`) });
  const ok = await handleSourceCheck(req(null, { origin: "https://www.praetorial.test", "access-control-request-method": "POST" }, "OPTIONS"), deps);
  assert.equal(ok.status, 204); assert.equal(ok.headers.get("access-control-allow-origin"), "https://www.praetorial.test");
  assert.match(ok.headers.get("access-control-allow-methods") ?? "", /POST/);
  const bad = await handleSourceCheck(req(null, { origin: "https://evil.test" }, "OPTIONS"), deps);
  assert.equal(bad.headers.get("access-control-allow-origin"), null); assert.ok(bad.status >= 400);
  const evil = await post(deps, GOOD_SHEET, { origin: "https://evil.test" });
  assert.equal(evil.status, 403); assert.equal(evil.headers.get("access-control-allow-origin"), null);
  assert.equal(spy.executions.length, 0);
  assert.deepEqual(parseAllowedOrigins("*, ,"), []); // a wildcard is never an origin
});

// ---- (7) no NEAR AI client is reachable from the sourcecheck path ------------------------------------------------------
test("no NEAR AI: the bundled Worker contains no NEAR AI / judge client and its module graph has none", async () => {
  const r = await build({ entryPoints: [path.join(HERE, "../src/index.ts")], bundle: true, format: "esm", platform: "browser", target: "es2022", write: false, logLevel: "silent", metafile: true });
  const inputs = Object.keys(r.metafile!.inputs);
  assert.ok(inputs.some((i) => /sourcecheck\/src\/core/.test(i)), "bundle must include the sourcecheck core");
  for (const i of inputs) assert.doesNotMatch(i, /near-?ai|nearai|judge|llm|openai|anthropic|cloud-api/i, `module graph reaches ${i}`);
  const text = r.outputFiles[0].text;
  assert.doesNotMatch(text, /near\.ai|cloud-api\.near|nearai|NEAR_AI|OPENAI|api\.openai|api\.anthropic|chat\/completions/i);
});
test("no NEAR AI: a full request only touches the injected chain (no ambient fetch)", async () => {
  const orig = globalThis.fetch; const hosts: string[] = [];
  globalThis.fetch = (async (u: any) => { hosts.push(String(u)); throw new Error("ambient fetch"); }) as any;
  try { const { deps } = mk(); assert.equal((await post(deps, GOOD_SHEET)).status, 200); } finally { globalThis.fetch = orig; }
  assert.deepEqual(hosts, []);
});

// ---- (8) deploy-ready + config pattern ---------------------------------------------------------------------------------
import { checkMainnetReady, MAINNET_WORKERS } from "../../common/src/mainnetReady.js";
const toml = fs.readFileSync(path.join(HERE, "../wrangler.toml"), "utf8");
const readme = fs.readFileSync(path.join(HERE, "../README.md"), "utf8");
test("deploy-ready (WKMAIN1b): sourcecheck is in MAINNET_WORKERS and adds no finding; names are praetorial-sourcecheck-{testnet,mainnet}", () => {
  assert.ok((MAINNET_WORKERS as readonly string[]).includes("sourcecheck"));
  const findings = checkMainnetReady({ sourcecheck: toml }).filter((f) => f.startsWith("sourcecheck"));
  assert.deepEqual(findings, []);
  assert.match(toml, /^name\s*=\s*"praetorial-sourcecheck-testnet"/m);
  assert.match(toml, /^\[env\.mainnet\]/m); assert.match(toml, /name\s*=\s*"praetorial-sourcecheck-mainnet"/);
  assert.match(toml, /\[\[durable_objects\.bindings\]\]/); assert.match(toml, /\[\[env\.mainnet\.durable_objects\.bindings\]\]/);
  assert.match(toml, /\[\[env\.mainnet\.migrations\]\]/);
  assert.doesNotMatch(toml, /crons\s*=/, "no cron: the account's 5 are used (D-HOST3)");
  assert.doesNotMatch(toml, /ed25519:[1-9A-HJ-NP-Za-km-z]{40,}|PRIVATE_KEY\s*=/);
  assert.match(toml, /ESCROW_CONTRACT_ID\s*=\s*"praetorial-frz3-2611100414\.praetorial-dev-1101\.testnet"/);
  assert.match(toml, /ATTEST_ACCOUNT_ID\s*=\s*"attest1\.praetorial-dev-1101\.testnet"/);
});
test("README names the attest key Worker secret and the deploy steps (never a value)", () => {
  assert.match(readme, /wrangler secret put SOURCECHECK_ATTEST_PRIVATE_KEY/);
  assert.match(readme, /Deployed URL/i);
  assert.doesNotMatch(readme, /ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/);
});

test("vendored sheet lint (services/common/src/sheetLint) is byte-identical to apps/web/lib (no drift)", () => {
  for (const f of ["templates", "customLint", "lintHints", "offerExpiry"]) {
    assert.equal(fs.readFileSync(path.join(ROOT, "services/common/src/sheetLint", `${f}.ts`), "utf8"), fs.readFileSync(path.join(ROOT, "apps/web/lib", `${f}.ts`), "utf8"), `${f}.ts drifted from apps/web/lib`);
  }
});

// Live finding (SRCW1): the guest prints checked_at as a bare u64-ns JSON number (> 2^53). A plain JSON.parse rounds it, which breaks the signature.
import { extractOutlayerOutput } from "../src/chain.js";
test("guest output: a bare u64 checked_at survives parsing exactly (decimal string, no float rounding)", () => {
  const big = "1794200000000004097"; // not representable as a double
  const body = `{"ok":true,"spec_hash":"ab","checked_at":${big},"unreachable":[]}`;
  const tx = { receipts_outcome: [{ outcome: { executor_id: "outlayer.testnet", status: { SuccessValue: Buffer.from(body).toString("base64") } } }] };
  const out: any = extractOutlayerOutput(tx, "outlayer.testnet");
  assert.equal(out.checked_at, big);
  assert.equal(String(Number(big)) === big, false, "control: a double would NOT hold this value");
});

// ---- SECREV1 SR-2: a verified attestation is reused while fresh (no second paid OutLayer run, no quota used) ----------------
function memCache() {
  const m = new Map<string, { checked_at: string; signature_hex: string }>();
  return { m, async get(k: string) { return m.get(k); }, async put(k: string, v: { checked_at: string; signature_hex: string }) { m.set(k, v); } };
}
test("SECREV1 SR-2: the same sheet again within 20 min returns the cached signed attestation: one OutLayer run, no quota used", async () => {
  let now = 1_700_000_000_000;
  const cache = memCache();
  const { deps, spy } = mk({ nowMs: () => now, cache });
  const a: any = await (await post(deps, GOOD_SHEET)).json();
  assert.equal(a.ok, true);
  for (let i = 0; i < 25; i++) { // more than the per-IP cap: a cache hit consumes nothing
    now += 1_000;
    const r = await post(deps, GOOD_SHEET);
    assert.equal(r.status, 200, `repeat ${i}`);
    assert.deepEqual(await r.json(), a, "byte-identical attestation (same checked_at and signature)");
  }
  assert.equal(spy.executions.length, 1, "only one paid run");
  // a different sheet is a cache miss: it runs and it counts
  const other = JSON.stringify({ ...JSON.parse(GOOD_SHEET), note: "x" });
  assert.equal((await post(deps, other)).status, 200);
  assert.equal(spy.executions.length, 2);
});
test("SECREV1 SR-2: a cached attestation older than 20 min (or dated in the future) is not reused; failures are never cached", async () => {
  let now = 1_700_000_000_000;
  const cache = memCache();
  let fail = true;
  const { deps, spy } = mk({ nowMs: () => now, cache, chain: {
    pinnedAttestPubkeyHex: async () => ATTEST_HEX,
    execute: async (terms) => { spy.executions.push(terms); return fail ? guestOutput(terms, { ok: false }) : guestOutput(terms); },
  } });
  assert.equal((await post(deps, GOOD_SHEET)).status, 502);
  assert.equal(cache.m.size, 0, "a failed check is never cached");
  fail = false;
  assert.equal((await post(deps, GOOD_SHEET)).status, 200);
  assert.equal(cache.m.size, 1);
  now += 20 * 60_000 + 1; // guest checked_at is fixed at NOW_NS: now 20 min + 1 ms old
  assert.equal((await post(deps, GOOD_SHEET)).status, 200);
  assert.equal(spy.executions.length, 3, "stale entry: ran again");
  now = 1_700_000_000_000 - 1; // checked_at in the future relative to now
  assert.equal((await post(deps, GOOD_SHEET)).status, 200);
  assert.equal(spy.executions.length, 4, "future-dated entry: ran again");
});
