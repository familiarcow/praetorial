// F1 RED/GREEN: Cash out / Convert (SPEC §5, §7.1): /withdraw/quote policy, then the user-signed NEP-413 path
// /withdraw/intent (1Click generate-intent + exact payload check) and /withdraw/submit (byte-equal payload + signature check).
import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { hashNep413Payload } from "../../../common/src/funding/intentCheck.js";
import { ACCOUNT, BTC, ETH_USDC, NOW, OTHER, TRON_USDT, USDC, USDT, USER_KEYS, call, genFor, harness, lastQuote, type Harness } from "./helpers.js";

const TRON_ADDR = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
const wBody = (o: Record<string, unknown> = {}) => ({ account: ACCOUNT, kind: "withdraw", originAsset: USDC, amountIn: "20000000", destinationAsset: TRON_USDT, recipient: TRON_ADDR, dry: true, ...o });
const cBody = (o: Record<string, unknown> = {}) => ({ account: ACCOUNT, kind: "convert", originAsset: ETH_USDC, amountIn: "1000000", destinationAsset: USDC, dry: true, ...o });

test("withdraw quote: INTENTS deposit, DESTINATION_CHAIN recipient = the validated address, refund INTENTS to the account, EXACT_INPUT, 30 min", async () => {
  const h = harness();
  const r = await call(h, "POST", "/withdraw/quote", wBody());
  assert.equal(r.status, 200, r.text);
  const q = lastQuote(h);
  assert.deepEqual([q.depositType, q.recipientType, q.recipient, q.refundType, q.refundTo, q.swapType, q.slippageTolerance], ["INTENTS", "DESTINATION_CHAIN", TRON_ADDR, "INTENTS", ACCOUNT, "EXACT_INPUT", 100]);
  assert.equal(Date.parse(q.deadline), NOW + 30 * 60_000);
  assert.ok(!("appFees" in q));
});

test("withdraw recipient goes through the shared chainAddress rules (bad checksum, the token contract itself, burn address refused)", async () => {
  for (const [dest, rcpt, reason] of [[TRON_USDT, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u", "checksum"], [TRON_USDT, "", "empty"], [TRON_USDT, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "refused"], [ETH_USDC, "0x000000000000000000000000000000000000dEaD", "refused"], [ETH_USDC, `0x${ACCOUNT.slice(0, 40)}`, undefined], [USDC, "intents.near", "refused"]] as const) {
    const r = await call(harness(), "POST", "/withdraw/quote", wBody({ destinationAsset: dest, recipient: rcpt }));
    if (reason === undefined) { assert.equal(r.status, 200, rcpt); continue; }
    assert.equal(r.status, 400, rcpt);
    assert.equal(r.json.code, "bad_recipient");
    assert.equal(r.json.reason, reason, rcpt);
  }
  // withdrawing to your own NEAR account through 1Click is fine (SPEC §5.4 fallback route)
  assert.equal((await call(harness(), "POST", "/withdraw/quote", wBody({ destinationAsset: USDC, recipient: ACCOUNT, originAsset: USDT }))).status, 200);
});

test("convert: destination must be one of the 6, recipient forced to the account (INTENTS), a client recipient is refused", async () => {
  const h = harness();
  assert.equal((await call(h, "POST", "/withdraw/quote", cBody())).status, 200);
  const q = lastQuote(h);
  assert.deepEqual([q.recipient, q.recipientType, q.refundTo, q.refundType, q.depositType], [ACCOUNT, "INTENTS", ACCOUNT, "INTENTS", "INTENTS"]);
  assert.equal((await call(harness(), "POST", "/withdraw/quote", cBody({ destinationAsset: TRON_USDT }))).json.code, "not_bet_token");
  assert.equal((await call(harness(), "POST", "/withdraw/quote", cBody({ recipient: OTHER }))).json.code, "unexpected_field");
  assert.equal((await call(harness(), "POST", "/withdraw/quote", cBody({ originAsset: USDC }))).json.code, "same_asset");
});

test("real withdraw quote checks the intents balance first (insufficient -> 400, RPC down -> 503, nothing quoted)", async () => {
  const h = harness();
  h.balances.set(`${ACCOUNT}|${USDC}`, 19_999_999n);
  let r = await call(h, "POST", "/withdraw/quote", wBody({ dry: false }));
  assert.equal(r.json.code, "insufficient_balance");
  h.rpcDown.v = true;
  r = await call(h, "POST", "/withdraw/quote", wBody({ dry: false }));
  assert.equal(r.status, 503);
  assert.equal(r.json.code, "rpc_down");
  assert.equal(h.fake.calls.filter((c) => c.op === "quote").length, 0);
});

async function realWithdraw(h: Harness, o: Record<string, unknown> = {}) {
  h.balances.set(`${ACCOUNT}|${USDC}`, 50_000_000n);
  const r = await call(h, "POST", "/withdraw/quote", wBody({ dry: false, ...o }));
  assert.equal(r.status, 200, r.text);
  genFor.set(r.json.depositAddress, { originAsset: USDC, amountIn: "20000000" });
  return r.json.depositAddress as string;
}
const sign = (payload: any, keys = USER_KEYS) => ({
  standard: "nep413", payload,
  public_key: `ed25519:${bs58.encode(keys.publicKey)}`,
  signature: `ed25519:${bs58.encode(nacl.sign.detached(hashNep413Payload(payload), keys.secretKey))}`,
});

test("happy path: intent -> payload checked -> user signs -> submit -> intent hash stored; 1Click asked with signerId = account", async () => {
  const h = harness();
  const addr = await realWithdraw(h);
  const i = await call(h, "POST", "/withdraw/intent", { account: ACCOUNT, depositAddress: addr });
  assert.equal(i.status, 200, i.text);
  const gen = h.fake.calls.find((c) => c.op === "generateIntent")!.body;
  assert.deepEqual(gen, { type: "swap_transfer", standard: "nep413", signerId: ACCOUNT, depositAddress: addr });
  assert.equal(i.json.hash, Buffer.from(hashNep413Payload(i.json.intent.payload)).toString("hex"));
  const s = await call(h, "POST", "/withdraw/submit", { account: ACCOUNT, depositAddress: addr, signedData: sign(i.json.intent.payload) });
  assert.equal(s.status, 200, s.text);
  assert.equal(s.json.intentHash, "IntentHash111");
  const sub = h.fake.calls.find((c) => c.op === "submitIntent")!.body;
  assert.equal(sub.type, "swap_transfer");
  assert.deepEqual(sub.signedData.payload, i.json.intent.payload);
  assert.equal((await h.state.get(addr))!.intentHash, "IntentHash111");
  assert.equal((await call(h, "POST", "/withdraw/submit", { account: ACCOUNT, depositAddress: addr, signedData: sign(i.json.intent.payload) })).json.code, "already_submitted");
});

test("generate-intent payload mismatch (extra intent, other token, other amount, other receiver, later deadline, other signer) -> 502, nothing to sign", async () => {
  const mutate: Record<string, (m: any) => void> = {
    "extra intent": (m) => m.intents.push({ intent: "transfer", receiver_id: "evil.near", tokens: { [USDC]: "1" } }),
    "other token": (m) => { m.intents[0].tokens = { [USDT]: "20000000" }; },
    "other amount": (m) => { m.intents[0].tokens = { [USDC]: "20000001" }; },
    "other receiver": (m) => { m.intents[0].receiver_id = "evil.near"; },
    "later deadline": (m) => { m.deadline = new Date(NOW + 31 * 60_000).toISOString(); },
    "other signer": (m) => { m.signer_id = OTHER; },
    "msg on transfer": (m) => { m.intents[0].msg = "x"; },
    "token_diff": (m) => { m.intents[0] = { intent: "token_diff", diff: { [USDC]: "-20000000", [BTC]: "1" } }; },
  };
  for (const [name, f] of Object.entries(mutate)) {
    const h = harness();
    const addr = await realWithdraw(h);
    h.fake.onGenerate = (_b, def) => { const m = JSON.parse(def.intent.payload.message); f(m); return { ...def, intent: { ...def.intent, payload: { ...def.intent.payload, message: JSON.stringify(m) } } }; };
    const r = await call(h, "POST", "/withdraw/intent", { account: ACCOUNT, depositAddress: addr });
    assert.equal(r.status, 502, name);
    assert.equal(r.json.code, "intent_mismatch", name);
    assert.equal((await h.state.get(addr))!.intentPayload, null, name);
  }
});

test("submit refuses: a different payload, another key, a bad signature, no prior intent; and someone else's record is 404", async () => {
  const h = harness();
  const addr = await realWithdraw(h);
  assert.equal((await call(h, "POST", "/withdraw/submit", { account: ACCOUNT, depositAddress: addr, signedData: sign({ message: "{}", nonce: Buffer.alloc(32).toString("base64"), recipient: "intents.near" }) })).json.code, "no_intent");
  const i = await call(h, "POST", "/withdraw/intent", { account: ACCOUNT, depositAddress: addr });
  const p = i.json.intent.payload;
  const m = JSON.parse(p.message); m.intents[0].tokens[USDC] = "1";
  assert.equal((await call(h, "POST", "/withdraw/submit", { account: ACCOUNT, depositAddress: addr, signedData: sign({ ...p, message: JSON.stringify(m) }) })).json.code, "payload_mismatch");
  assert.equal((await call(h, "POST", "/withdraw/submit", { account: ACCOUNT, depositAddress: addr, signedData: sign(p, nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9))) })).json.code, "wrong_signer");
  const forged = sign(p); forged.signature = `ed25519:${bs58.encode(new Uint8Array(64).fill(1))}`;
  assert.equal((await call(h, "POST", "/withdraw/submit", { account: ACCOUNT, depositAddress: addr, signedData: forged })).json.code, "bad_signature");
  assert.equal(h.fake.calls.filter((c) => c.op === "submitIntent").length, 0);
  assert.equal((await call(h, "POST", "/withdraw/intent", { account: OTHER, depositAddress: addr })).status, 404);
});

test("intent after the quote deadline -> 410 expired; a fund record cannot be signed", async () => {
  const h = harness();
  const addr = await realWithdraw(h);
  h.setNow(NOW + 31 * 60_000);
  assert.equal((await call(h, "POST", "/withdraw/intent", { account: ACCOUNT, depositAddress: addr })).status, 410);
  const h2 = harness();
  const f = await call(h2, "POST", "/fund/quote", { account: ACCOUNT, originAsset: TRON_USDT, betWith: USDC, amountIn: "50000000", dry: false });
  assert.equal((await call(h2, "POST", "/withdraw/intent", { account: ACCOUNT, depositAddress: f.json.depositAddress })).json.code, "wrong_kind");
});

test("SECREV1 SR-1: /fund/list never returns an unsigned cash out / convert (anyone can create one for any account; the web would offer to sign it)", async () => {
  const h = harness();
  // attacker: a real withdraw quote for the victim's account to the attacker's own address (no proof of ownership is asked)
  const addr = await realWithdraw(h);
  let l = await call(h, "GET", `/fund/list?account=${ACCOUNT}`);
  assert.equal(l.status, 200, l.text);
  assert.deepEqual(l.json, [], "an unsigned withdraw record is not listed");
  // asking for the intent (still unsigned) does not make it listable either
  assert.equal((await call(h, "POST", "/withdraw/intent", { account: ACCOUNT, depositAddress: addr })).status, 200);
  assert.deepEqual((await call(h, "GET", `/fund/list?account=${ACCOUNT}`)).json, []);
  // once the account's own key signed and it was submitted, it is listed (other devices can track it), marked signed
  const i = await call(h, "POST", "/withdraw/intent", { account: ACCOUNT, depositAddress: addr });
  assert.equal((await call(h, "POST", "/withdraw/submit", { account: ACCOUNT, depositAddress: addr, signedData: sign(i.json.intent.payload) })).status, 200);
  l = await call(h, "GET", `/fund/list?account=${ACCOUNT}`);
  assert.equal(l.json.length, 1);
  assert.equal(l.json[0].signed, true);
});

test("SECREV1 SR-6: a second /withdraw/intent returns the stored payload (no 1Click call), so nobody can invalidate the one the user signs", async () => {
  const h = harness();
  const addr = await realWithdraw(h);
  const first = await call(h, "POST", "/withdraw/intent", { account: ACCOUNT, depositAddress: addr });
  assert.equal(first.status, 200, first.text);
  for (let i = 0; i < 20; i++) { // an attacker who knows the address hammers /withdraw/intent
    const again = await call(h, "POST", "/withdraw/intent", { account: ACCOUNT, depositAddress: addr });
    assert.equal(again.status, 200, `call ${i}: ${again.text}`);
    assert.deepEqual(again.json.intent, first.json.intent);
    assert.equal(again.json.hash, first.json.hash);
  }
  assert.equal(h.fake.calls.filter((c) => c.op === "generateIntent").length, 1, "1Click asked once");
  // junk submits (no valid signature) do not use up the owner's submit allowance
  for (let i = 0; i < 20; i++) await call(h, "POST", "/withdraw/submit", { depositAddress: addr, signedData: { standard: "nep413", payload: first.json.intent.payload, public_key: "ed25519:x", signature: "ed25519:y" } });
  const s = await call(h, "POST", "/withdraw/submit", { account: ACCOUNT, depositAddress: addr, signedData: sign(first.json.intent.payload) });
  assert.equal(s.status, 200, s.text);
});

test("SECREV1 SR-6: a stored payload whose own deadline is (nearly) past is regenerated, not reissued", async () => {
  const h = harness();
  const addr = await realWithdraw(h);
  const first = await call(h, "POST", "/withdraw/intent", { account: ACCOUNT, depositAddress: addr });
  assert.equal(first.status, 200, first.text);
  const p = first.json.intent.payload;
  const msg = JSON.parse(p.message);
  const stale = { ...p, message: JSON.stringify({ ...msg, deadline: new Date(NOW + 30_000).toISOString() }) };
  await h.state.patch(addr, { intentPayload: JSON.stringify(stale) });
  const again = await call(h, "POST", "/withdraw/intent", { account: ACCOUNT, depositAddress: addr });
  assert.equal(again.status, 200, again.text);
  assert.equal(h.fake.calls.filter((c) => c.op === "generateIntent").length, 2, "regenerated");
});
