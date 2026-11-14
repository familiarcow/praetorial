// F1B RED/GREEN (D-PM3, option ii): 1Click's quote signature fails for every BTC origin-chain quote (spikes/f1/NOTES.md finding 1;
// pinned in common/test/funding/quoteSignature.test.ts). For BTC origin-chain quotes ONLY, a bad signature is accepted when the
// echoed request matches what we sent field by field AND the response came straight from 1Click over TLS; it is logged as
// `quote_sig_btc_unverified`. Every other route stays strict. Plus: the status endpoint keeps polling after the address deadline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT, BTC, NOW, TRON_USDT, USDC, ZEC, call, fundBody, harness, type Harness } from "./helpers.js";

const recs = (h: Harness) => [...h.kv.map.keys()].filter((k) => k.startsWith("rec:")).length;
const badSig = (s: string) => s.slice(0, -4) + (s.endsWith("1111") ? "2222" : "1111");
/** 1Click's response with a broken signature and an exact echo (no appFees: we send none, the partner key adds none). */
function btcUnsigned(h: Harness, mutate: (q: any) => void = () => {}) {
  h.fake.onQuote = (_req, def) => {
    const quoteRequest: any = structuredClone(def.quoteRequest);
    delete quoteRequest.appFees;
    mutate(quoteRequest);
    return { ...def, quoteRequest, signature: badSig(def.signature) };
  };
}
const btcBody = (o: Record<string, unknown> = {}) => fundBody({ originAsset: BTC, betWith: USDC, amountIn: "100000", dry: false, ...o });

test("BTC origin-chain quote, bad signature, exact echo, straight from 1Click over TLS -> accepted, stored, warning logged", async () => {
  for (const betWith of [USDC, BTC]) {
    const h = harness();
    btcUnsigned(h);
    const r = await call(h, "POST", "/fund/quote", btcBody({ betWith }));
    assert.equal(r.status, 200, r.text);
    const rec = await h.state.get(r.json.depositAddress);
    assert.ok(rec, "stored");
    assert.equal(rec!.quoteSignature, "btc_unverified");
    const w = h.logs.find((l) => l.evt === "quote_sig_btc_unverified");
    assert.ok(w, "structured warning");
    assert.equal(w!.level, "warn");
    assert.equal(w!.correlationId, r.json.correlationId);
    assert.equal(w!.depositAddress, r.json.depositAddress);
    assert.ok(!JSON.stringify(w).includes("signature\":\"ed25519"), "no signature / secret material in the log");
    assert.ok(!h.logs.some((l) => l.evt === "bad_signature"));
  }
});

test("an echoed appFees [] counts as 'no fee' (same as absent)", async () => {
  const h = harness();
  btcUnsigned(h, (q) => { q.appFees = []; });
  assert.equal((await call(h, "POST", "/fund/quote", btcBody())).status, 200);
});

test("a properly signed BTC quote is still just 'verified' (no warning)", async () => {
  const h = harness();
  const r = await call(h, "POST", "/fund/quote", btcBody());
  assert.equal(r.status, 200, r.text);
  assert.equal((await h.state.get(r.json.depositAddress))!.quoteSignature, "verified");
  assert.ok(!h.logs.some((l) => l.evt === "quote_sig_btc_unverified"));
});

test("BTC, bad signature, echo differs in ANY one field -> 502, nothing stored, no warning", async () => {
  const muts: [string, (q: any) => void][] = [
    ["originAsset", (q) => { q.originAsset = ZEC; }],
    ["destinationAsset", (q) => { q.destinationAsset = BTC; }],
    ["amount", (q) => { q.amount = "100001"; }],
    ["swapType", (q) => { q.swapType = "EXACT_INPUT"; }],
    ["recipient", (q) => { q.recipient = "c".repeat(64); }],
    ["recipientType", (q) => { q.recipientType = "DESTINATION_CHAIN"; }],
    ["refundTo", (q) => { q.refundTo = "c".repeat(64); }],
    ["refundType", (q) => { q.refundType = "ORIGIN_CHAIN"; }],
    ["deadline", (q) => { q.deadline = new Date(Date.parse(q.deadline) + 1).toISOString(); }],
    ["deadline missing", (q) => { delete q.deadline; }],
    ["appFees", (q) => { q.appFees = [{ recipient: "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd", fee: 1 }]; }],
    ["appFees zero-fee entry", (q) => { q.appFees = [{ recipient: "evil.near", fee: 0 }]; }],
    ["slippageTolerance", (q) => { q.slippageTolerance = 101; }],
    ["depositType", (q) => { q.depositType = "INTENTS"; }],
    ["dry", (q) => { q.dry = true; }],
  ];
  for (const [name, m] of muts) {
    const h = harness();
    btcUnsigned(h, m);
    const r = await call(h, "POST", "/fund/quote", btcBody());
    assert.equal(r.status, 502, name);
    assert.ok(["quote_mismatch", "bad_signature"].includes(r.json.code), `${name}: ${r.json.code}`);
    assert.equal(recs(h), 0, name);
    assert.ok(!h.logs.some((l) => l.evt === "quote_sig_btc_unverified"), name);
  }
});

test("BTC, bad signature, exact echo, but NOT straight from 1Click over TLS (other base URL / plain http) -> 502", async () => {
  for (const baseUrl of ["http://1click.chaindefuser.com", "https://1click.test", undefined]) {
    const h = harness();
    btcUnsigned(h);
    (h.fake as { baseUrl?: string }).baseUrl = baseUrl;
    const r = await call(h, "POST", "/fund/quote", btcBody());
    assert.equal(r.status, 502, String(baseUrl));
    assert.equal(r.json.code, "bad_signature");
    assert.equal(recs(h), 0);
  }
});

test("non-BTC origin with a bad signature and an exact echo is STILL refused (Tron USDT, ZEC)", async () => {
  for (const originAsset of [TRON_USDT, ZEC]) {
    const h = harness();
    btcUnsigned(h);
    const r = await call(h, "POST", "/fund/quote", btcBody({ originAsset, amountIn: "50000000" }));
    assert.equal(r.status, 502, originAsset);
    assert.equal(r.json.code, "bad_signature");
    assert.equal(recs(h), 0);
    assert.ok(!h.logs.some((l) => l.evt === "quote_sig_btc_unverified"));
  }
});

test("status keeps polling 1Click after the address deadline (a late deposit is still tracked)", async () => {
  const h = harness();
  const q = await call(h, "POST", "/fund/quote", btcBody());
  const addr = q.json.depositAddress;
  assert.equal(Date.parse(q.json.deadline), NOW + 3 * 3_600_000, "BTC address lives 3 h");
  h.setNow(Date.parse(q.json.deadline) + 2 * 3_600_000);
  let r = await call(h, "GET", `/fund/status?depositAddress=${addr}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.record.state, "expired");
  h.fake.statusOf.set(addr, { correlationId: "c", quoteResponse: {}, status: "REFUNDED", updatedAt: new Date(NOW).toISOString(), swapDetails: { refundedAmount: "100000" } });
  r = await call(h, "GET", `/fund/status?depositAddress=${addr}`);
  assert.equal(r.json.record.state, "refunded");
  assert.equal(h.fake.calls.filter((c) => c.op === "status").length, 2);
  assert.equal((await h.state.get(addr))!.account, ACCOUNT);
});
