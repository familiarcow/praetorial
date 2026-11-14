// V1: scripts/verify-bet.mjs, the public checker (familiarcow 2026-11-11: "users should easily be able to get all of their information to
// verify"). Real testnet bet 49 (AI ruling YES, checks 9 and 10, a challenge, paid out): every check PASSes; each tampered copy FAILs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
// @ts-ignore -- plain JS module (no types), run by tsx
import { buildFile, runChecks, main, parseExact, outcomeMessage, verifyEd25519, sha256Hex, FORMAT } from "../../../scripts/verify-bet.mjs";

const fx = JSON.parse(readFileSync(new URL("./fixtures/v1/bet49-testnet.json", import.meta.url), "utf8"));
const mkFile = (over: Record<string, unknown> = {}) => buildFile({
  network: "testnet", escrow: fx.escrow, betId: 49, betText: fx.get_bet_text, keys: fx.resolver_keys, olc: fx.outlayer_config,
  codeHashB58: fx.code_hash_b58, txs: fx.txs, generatedAt: "2026-11-11T00:00:00.000Z", ...over,
});
const statuses = (rs: any[]) => Object.fromEntries(rs.map((r) => [r.id, r.status]));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test("parseExact keeps u64 digits exact and never touches digits inside strings", () => {
  const v = parseExact('{"a":1794423865849395398,"b":"x\\":1794423865849395398,","c":[12,1794423865849395399],"d":1.5}');
  assert.equal(v.a, "1794423865849395398");
  assert.equal(v.b, 'x":1794423865849395398,');
  assert.deepEqual(v.c, [12, "1794423865849395399"]);
  assert.equal(v.d, 1.5);
});

test("the stored ruling of bet 49 verifies under the escrow's outcome key (the exact submit_outcome message)", () => {
  const raw = JSON.parse(JSON.parse(fx.get_bet_text).last_resolution_raw);
  assert.equal(raw.signing.pubkey_hex, fx.resolver_keys[0]);
  const msg = outcomeMessage(raw.contract, raw.result);
  assert.ok(verifyEd25519(fx.resolver_keys[0], raw.signing.signature_hex, msg));
  assert.ok(!verifyEd25519(fx.resolver_keys[1], raw.signing.signature_hex, msg), "the attest key must not verify it");
  assert.ok(!verifyEd25519(fx.resolver_keys[0], raw.signing.signature_hex, outcomeMessage(raw.contract, { ...raw.result, outcome: "NO" })));
});

test("file from real bet 49: terms hash and both AI rulings PASS offline; nothing FAILs", () => {
  const f = mkFile();
  assert.equal(f.format, FORMAT);
  assert.equal(f.rulings.length, 2);
  assert.deepEqual(f.rulings.map((r: any) => [r.run_no, r.source]), [[9, "submit_outcome"], [10, "submit_outcome"]]);
  assert.equal(f.rulings[1].pubkey_hex, fx.resolver_keys[0], "the stored ruling's signing key is attached to its run");
  const s = statuses(runChecks(f, null));
  assert.equal(s["terms-hash"], "PASS");
  assert.equal(s["ruling-sig-9"], "PASS");
  assert.equal(s["ruling-sig-10"], "PASS");
  assert.ok(!Object.values(s).includes("FAIL"), JSON.stringify(s));
});

test("TAMPERED terms text -> terms-hash FAILs (and main exits 1)", async () => {
  const f = mkFile();
  f.terms = f.terms.replace("74400", "74300");
  const r = runChecks(f, null);
  assert.equal(statuses(r)["terms-hash"], "FAIL");
  const lines: string[] = [];
  const code = await main(["49", "f.json", "--offline"], { readFile: () => JSON.stringify(f), log: (l: string) => lines.push(l) });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /FAIL terms-hash/);
});

test("TAMPERED ruling (YES -> NO) or a swapped signing key -> ruling-sig FAILs", () => {
  const f = mkFile();
  f.rulings[1].result_json = f.rulings[1].result_json.replace('"YES"', '"NO"');
  assert.equal(statuses(runChecks(f, null))["ruling-sig-10"], "FAIL");
  const g = mkFile();
  g.resolver.outcome_pubkey = fx.resolver_keys[1];
  const s = statuses(runChecks(g, null));
  assert.equal(s["ruling-sig-9"], "FAIL");
  assert.equal(s["ruling-sig-10"], "FAIL");
});

test("TAMPERED terms hash claimed in the file (terms + hash both swapped) -> the stored bet record and signatures disagree", () => {
  const f = mkFile();
  f.terms = '{"claim":"something else"}';
  f.terms_hash = sha256Hex(f.terms);
  const s = statuses(runChecks(f, null));
  assert.equal(s["terms-hash"], "FAIL", "the bet record inside the file still names the real hash");
  assert.equal(s["ruling-sig-10"], "FAIL", "the signed result names the real terms hash");
});

test("a file for another bet, or not a verification file, is refused", async () => {
  assert.equal(statuses(runChecks({ format: "x" }, null)).format, "FAIL");
  const code = await main(["50", "f.json"], { readFile: () => JSON.stringify(mkFile()), log: () => {} });
  assert.equal(code, 1);
  assert.equal(await main(["nope"], { log: () => {} }), 2);
});

// ---------------------------------------------------------------- online, against a fake chain (no network in tests)
const WASM = Buffer.from("not really wasm, but the bytes the fake FastFS serves");
const WASM_HASH = createHash("sha256").update(WASM).digest("hex");
function fakeChain(o: { wasm?: Buffer; txSigner?: string; raw?: string | null; accessKeys?: number } = {}) {
  const keys = [fx.resolver_keys[0], fx.resolver_keys[1], WASM_HASH];
  const betText = o.raw === undefined ? fx.get_bet_text : JSON.stringify({ ...JSON.parse(fx.get_bet_text), last_resolution_raw: o.raw });
  const views: Record<string, string> = { get_bet: betText, resolver_keys: JSON.stringify(keys), outlayer_config: JSON.stringify(fx.outlayer_config) };
  const calls: string[] = [];
  const fetch = async (url: string, init?: any): Promise<Response> => {
    calls.push(url);
    if (url.endsWith(".wasm")) return new Response(new Uint8Array(o.wasm ?? WASM));
    const b = JSON.parse(init.body);
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: b.id, result });
    if (b.method === "query" && b.params.request_type === "call_function") return ok({ result: [...Buffer.from(views[b.params.method_name])] });
    if (b.method === "query" && b.params.request_type === "view_account") return ok({ code_hash: fx.code_hash_b58 });
    if (b.method === "query" && b.params.request_type === "view_access_key_list") return ok({ keys: Array(o.accessKeys ?? 0).fill({}) });
    if (b.method === "tx") {
      const t = fx.txs.find((x: any) => x.hash === b.params.tx_hash);
      if (!t) return Response.json({ jsonrpc: "2.0", id: b.id, error: { cause: { name: "UNKNOWN_TRANSACTION" } } });
      return ok({ transaction: { signer_id: o.txSigner ?? t.signer }, receipts_outcome: [{ outcome: { executor_id: fx.escrow, status: t.ok ? { SuccessValue: "" } : { Failure: {} } } }] });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetch, keys, calls };
}

test("online (fake chain): every check PASSes, including the program download, code hash, no keys and every tx", async () => {
  const c = fakeChain();
  const f = mkFile({ keys: c.keys });
  const lines: string[] = [];
  const code = await main(["49", "f.json"], { readFile: () => JSON.stringify(f), fetch: c.fetch, sleep: async () => {}, log: (l: string) => lines.push(l) });
  const out = lines.join("\n");
  assert.equal(code, 0, out);
  for (const id of ["terms-hash", "resolver-keys", "ruling-sig-9", "ruling-sig-10", "stored-ruling", "wasm", "escrow-code", "escrow-locked"]) assert.match(out, new RegExp(`^PASS ${id}\\b`, "m"), id);
  assert.equal((out.match(/^PASS tx-/gm) ?? []).length, fx.txs.length);
  assert.ok(c.calls.some((u) => u === `${fx.outlayer_config.wasm_base_url}/${WASM_HASH}.wasm`));
});

test("online TAMPERED: wrong program bytes, a forged tx signer, a stored ruling that differs, or keys on the escrow -> FAIL", async () => {
  const run = async (c: ReturnType<typeof fakeChain>, f = mkFile({ keys: c.keys })) => {
    const lines: string[] = [];
    const code = await main(["49", "f.json"], { readFile: () => JSON.stringify(f), fetch: c.fetch, sleep: async () => {}, log: (l: string) => lines.push(l) });
    return { code, out: lines.join("\n") };
  };
  let r = await run(fakeChain({ wasm: Buffer.from("evil") }));
  assert.equal(r.code, 1); assert.match(r.out, /^FAIL wasm/m);
  r = await run(fakeChain({ txSigner: "mallory.testnet" }));
  assert.equal(r.code, 1); assert.match(r.out, /^FAIL tx-.*signed by mallory\.testnet/m);
  r = await run(fakeChain({ raw: '{"result":{"outcome":"NO"}}' }));
  assert.equal(r.code, 1); assert.match(r.out, /^FAIL stored-ruling/m);
  r = await run(fakeChain({ accessKeys: 1 }));
  assert.equal(r.code, 1); assert.match(r.out, /^FAIL escrow-locked/m);
  const c = fakeChain();
  const f = mkFile({ keys: c.keys });
  f.transactions = clone(f.transactions);
  f.transactions[0].hash = "1111111111111111111111111111111111111111111";
  r = await run(c, f);
  assert.equal(r.code, 1); assert.match(r.out, /^FAIL tx-1111.*not found on chain/m);
});

test("a rate-limited RPC is retried; one that stays down makes the tx checks SKIP (never PASS, never a false FAIL)", async () => {
  const c = fakeChain();
  const f = mkFile({ keys: c.keys });
  let n = 0;
  const flaky = async (url: string, init?: any) => (init && JSON.parse(init.body).method === "tx" && n++ % 2 === 0 ? new Response("slow down", { status: 429 }) : c.fetch(url, init));
  const lines: string[] = [];
  assert.equal(await main(["49", "f.json", "--no-wasm"], { readFile: () => JSON.stringify(f), fetch: flaky, sleep: async () => {}, log: (l: string) => lines.push(l) }), 0, lines.join("\n"));
  assert.equal((lines.join("\n").match(/^PASS tx-/gm) ?? []).length, fx.txs.length);
  const down = async (url: string, init?: any) => (init && JSON.parse(init.body).method === "tx" ? new Response("down", { status: 429 }) : c.fetch(url, init));
  const out: string[] = [];
  assert.equal(await main(["49", "f.json", "--no-wasm"], { readFile: () => JSON.stringify(f), fetch: down, sleep: async () => {}, log: (l: string) => out.push(l) }), 0);
  assert.equal((out.join("\n").match(/^SKIP tx-.*run again later/gm) ?? []).length, fx.txs.length);
  assert.equal((out.join("\n").match(/^PASS tx-/gm) ?? []).length, 0);
});
