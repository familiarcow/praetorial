// F1: the 1Click quote signature port verifies REAL 1Click quotes (dry, captured 2026-11-11 in spikes/fund4 + spikes/f1, no key)
// and refuses any tampering. KNOWN 1Click GAP pinned here: BTC origin-chain quotes do NOT verify, with the official SDK 0.1.26
// too (spikes/f1/NOTES.md). If 1Click fixes it, the pin fails and the NOTES/Worker policy can be revisited.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { quoteHash, stableStringify, verifyQuoteSignature, ONE_CLICK_MANAGER_PUB_KEY } from "../../src/funding/quoteSignature.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "vectors");
const load = (n: string) => JSON.parse(fs.readFileSync(path.join(DIR, n), "utf8"));
const GOOD = ["quote-fund-tron-usdt-refund-intents.json", "quote-withdraw-usdc-to-tron-usdt.json", "quote-convert-stray-eth-usdc-to-usdc.json", "tron-usdt-to-near-usdt.json", "zec-to-zec.json", "intents-btc-to-usdc.json"];

test("real 1Click quotes verify under the published manager key", () => {
  assert.equal(ONE_CLICK_MANAGER_PUB_KEY, "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc");
  for (const f of GOOD) assert.equal(verifyQuoteSignature(load(f)), true, f);
});

test("any change to a signed field breaks the signature (recipient, refundTo, amountOut, destination, timestamp)", () => {
  const base = load("quote-fund-tron-usdt-refund-intents.json");
  const muts: ((r: any) => void)[] = [
    (r) => { r.quoteRequest.recipient = "evil.near"; }, (r) => { r.quoteRequest.refundTo = "evil.near"; }, (r) => { r.quote.amountOut = "99999999"; },
    (r) => { r.quoteRequest.destinationAsset = "nep141:wrap.near"; }, (r) => { r.timestamp = "2026-11-11T05:39:41.276Z"; }, (r) => { r.signature = "garbage"; }, (r) => { delete r.signature; },
  ];
  for (const m of muts) { const r = structuredClone(base); m(r); assert.equal(verifyQuoteSignature(r), false, m.toString()); }
  assert.equal(verifyQuoteSignature(null), false);
});

test("unsigned fields (appFees, depositMode) are NOT covered by the signature (so the Worker checks the echo itself)", () => {
  const r = load("quote-fund-tron-usdt-refund-intents.json");
  r.quoteRequest.appFees = [{ recipient: "evil.near", fee: 500 }];
  assert.equal(verifyQuoteSignature(r), true);
});

test("PINNED 1Click gap: BTC origin-chain quotes fail verification (2/2 fresh samples); BTC via INTENTS deposit verifies", () => {
  assert.equal(verifyQuoteSignature(load("btc-to-btc-flex.json")), false);
  assert.equal(verifyQuoteSignature(load("btc-to-usdc.json")), false);
  assert.equal(verifyQuoteSignature(load("intents-btc-to-usdc.json")), true);
});

test("stableStringify: sorted keys, undefined dropped, nested + arrays (json-stable-stringify semantics)", () => {
  assert.equal(stableStringify({ b: 1, a: { d: [1, undefined, "x"], c: undefined } }), '{"a":{"d":[1,null,"x"]},"b":1}');
  assert.match(quoteHash(load("zec-to-zec.json")), /^[1-9A-HJ-NP-Za-km-z]{40,50}$/);
});
