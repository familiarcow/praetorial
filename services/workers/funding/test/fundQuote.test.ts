// F1 RED/GREEN: POST /fund/quote policy (SPEC §7.1, D-FUND4a). Destination is ALWAYS one of the 6 bet tokens; recipient and
// refundTo are ALWAYS the caller's own intents account (INTENTS/INTENTS), built server-side; no app fee; one-time address only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT, BASE_USDC, BET, BTC, NOW, OTHER, STELLAR_USDC, TRON_USDT, USDC, USDT, ZEC, call, fundBody, harness, lastQuote, signQuote } from "./helpers.js";

test("dry quote: the outgoing 1Click request is FLEX_INPUT, ORIGIN_CHAIN deposit, recipient = refundTo = account, INTENTS both, no appFees", async () => {
  const h = harness();
  const r = await call(h, "POST", "/fund/quote", fundBody());
  assert.equal(r.status, 200, r.text);
  const q = lastQuote(h);
  assert.equal(q.dry, true);
  assert.equal(q.swapType, "FLEX_INPUT");
  assert.equal(q.depositType, "ORIGIN_CHAIN");
  assert.equal(q.originAsset, TRON_USDT);
  assert.equal(q.destinationAsset, USDC);
  assert.equal(q.recipient, ACCOUNT);
  assert.equal(q.recipientType, "INTENTS");
  assert.equal(q.refundTo, ACCOUNT);
  assert.equal(q.refundType, "INTENTS");
  assert.equal(q.amount, "50000000");
  assert.equal(q.referral, "praetorial");
  assert.equal(q.quoteWaitingTimeMs, 0);
  assert.ok(!("appFees" in q), "familiarcow: no partner fee: appFees is never sent");
  assert.equal(q.slippageTolerance, 50, "stable -> stable is 50 bp");
  assert.equal(Date.parse(q.deadline), NOW + 3_600_000, "1 h address for a fast chain");
  assert.equal(r.json.depositAddress, null, "a dry quote has no address");
  assert.equal(r.json.amountOut, "49950000");
  assert.equal(h.kv.map.size > 0 && [...h.kv.map.keys()].some((k) => k.startsWith("rec:")), false, "dry quotes store nothing");
});

test("every one of the 6 bet tokens is accepted as betWith; anything else is refused before 1Click is called", async () => {
  for (const id of BET) assert.equal((await call(harness(), "POST", "/fund/quote", fundBody({ betWith: id }))).status, 200, id);
  for (const id of [TRON_USDT, BASE_USDC, "nep141:evil.near", "", 5]) {
    const h = harness();
    const r = await call(h, "POST", "/fund/quote", fundBody({ betWith: id }));
    assert.equal(r.status, 400, String(id));
    assert.equal(r.json.code, "not_bet_token");
    assert.equal(h.fake.calls.filter((c) => c.op === "quote").length, 0);
  }
});

test("client-supplied recipient / refundTo / destinationAsset / appFees / refundType are refused (the Worker builds them)", async () => {
  for (const k of ["recipient", "refundTo", "destinationAsset", "appFees", "refundType", "recipientType", "depositType", "slippageTolerance"]) {
    const h = harness();
    const r = await call(h, "POST", "/fund/quote", fundBody({ [k]: k === "appFees" ? [{ recipient: "x.near", fee: 100 }] : OTHER }));
    assert.equal(r.status, 400, k);
    assert.equal(r.json.code, "unexpected_field", k);
    assert.equal(h.fake.calls.length, 0, k);
  }
});

test("account must be a 64-hex implicit id on mainnet (a 62-hex typo, a named account, uppercase hex are refused)", async () => {
  for (const a of ["a".repeat(62), "alice.near", "A".repeat(64), "", null, `${"a".repeat(64)} `]) {
    const r = await call(harness(), "POST", "/fund/quote", fundBody({ account: a }));
    assert.equal(r.status, 400, String(a));
    assert.equal(r.json.code, "bad_account");
  }
  assert.equal((await call(harness({ network: "testnet", dryOnly: true }), "POST", "/fund/quote", fundBody({ account: "alice.testnet" }))).status, 200);
});

test("an originAsset 1Click does not list is refused (unknown_origin)", async () => {
  const r = await call(harness(), "POST", "/fund/quote", fundBody({ originAsset: "nep141:not-a-token.near" }));
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "unknown_origin");
});

test("amount: exactly one of amountIn/needOut, a positive integer string", async () => {
  for (const extra of [{ amountIn: undefined }, { needOut: "5" }, { amountIn: "0" }, { amountIn: "1.5" }, { amountIn: 10 }, { amountIn: "-1" }]) {
    const r = await call(harness(), "POST", "/fund/quote", { ...fundBody(), ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.equal(r.json.code, "bad_amount");
  }
  assert.equal((await call(harness(), "POST", "/fund/quote", { ...fundBody(), dry: "yes" })).json.code, "bad_dry");
});

test("BTC / ZEC origins get a 3 h address; volatile pairs 100 bp", async () => {
  for (const id of [BTC, ZEC]) {
    const h = harness();
    assert.equal((await call(h, "POST", "/fund/quote", fundBody({ originAsset: id, betWith: id, amountIn: "100000" }))).status, 200);
    assert.equal(Date.parse(lastQuote(h).deadline), NOW + 3 * 3_600_000, id);
    assert.equal(lastQuote(h).slippageTolerance, 100);
  }
});

test("Stellar origins are quoted with depositMode MEMO and the memo comes back; others never send MEMO", async () => {
  const h = harness();
  const r = await call(h, "POST", "/fund/quote", fundBody({ originAsset: STELLAR_USDC, dry: false }));
  assert.equal(r.status, 200, r.text);
  assert.equal(lastQuote(h).depositMode, "MEMO");
  assert.equal(r.json.depositMemo, "123456");
  const h2 = harness();
  await call(h2, "POST", "/fund/quote", fundBody());
  assert.equal(lastQuote(h2).depositMode, undefined);
});

test("needOut: dry EXACT_OUTPUT sizing, then FLEX_INPUT for sizing amountIn + 1% (rounded up)", async () => {
  const h = harness();
  const r = await call(h, "POST", "/fund/quote", fundBody({ amountIn: undefined, needOut: "7300000", betWith: USDT }));
  assert.equal(r.status, 200, r.text);
  const quotes = h.fake.calls.filter((c) => c.op === "quote").map((c) => c.body);
  assert.equal(quotes.length, 2);
  assert.equal(quotes[0].swapType, "EXACT_OUTPUT");
  assert.equal(quotes[0].dry, true);
  assert.equal(quotes[0].amount, "7300000");
  assert.equal(quotes[0].recipient, ACCOUNT);
  assert.equal(quotes[1].swapType, "FLEX_INPUT");
  assert.equal(quotes[1].amount, "7520460"); // 7300000*1.02 = 7446000 (mock) -> *1.01 = 7520460
});

test("real quote: signature verified, record stored BEFORE the address is returned, address listed for the account", async () => {
  const h = harness();
  const r = await call(h, "POST", "/fund/quote", fundBody({ dry: false }));
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.depositAddress, /^dep/);
  assert.equal(lastQuote(h).quoteWaitingTimeMs, 3000);
  const rec = await h.state.get(r.json.depositAddress);
  assert.ok(rec);
  assert.equal(rec!.account, ACCOUNT);
  assert.equal(rec!.kind, "fund");
  assert.equal(rec!.recipient, ACCOUNT);
  assert.equal(rec!.status, "PENDING_DEPOSIT");
  assert.ok((rec!.signedQuote as any).signature, "the full signed quote is kept for disputes");
  const l = await call(h, "GET", `/fund/list?account=${ACCOUNT}`);
  assert.equal(l.status, 200);
  assert.deepEqual(l.json.map((x: any) => x.depositAddress), [r.json.depositAddress]);
  assert.equal(l.json[0].state, "waiting");
  assert.equal(l.json[0].account, ACCOUNT);
  assert.deepEqual(l.json[0].origin, { assetId: TRON_USDT, symbol: "USDT", blockchain: "tron", decimals: 6 });
  assert.ok(!("signedQuote" in l.json[0]) && !("intentPayload" in l.json[0]) && !l.text.includes("signature"));
  assert.deepEqual((await call(h, "GET", `/fund/list?account=${OTHER}`)).json, []);
});

test("a bad 1Click signature -> 502 bad_signature and NO record", async () => {
  const h = harness();
  h.fake.onQuote = (_req, def) => ({ ...def, signature: def.signature.slice(0, -4) + "1111" });
  const r = await call(h, "POST", "/fund/quote", fundBody({ dry: false }));
  assert.equal(r.status, 502);
  assert.equal(r.json.code, "bad_signature");
  assert.equal([...h.kv.map.keys()].filter((k) => k.startsWith("rec:")).length, 0);
  assert.ok(h.logs.some((l) => l.evt === "bad_signature"));
});

test("a validly signed quote whose echoed request differs (recipient, refundTo, destination, amount) -> 502 quote_mismatch, no record", async () => {
  for (const [k, v] of [["recipient", "evil.near"], ["refundTo", "evil.near"], ["destinationAsset", TRON_USDT], ["amount", "1"], ["refundType", "ORIGIN_CHAIN"], ["recipientType", "DESTINATION_CHAIN"]] as const) {
    const h = harness();
    h.fake.onQuote = (_req, def) => signQuote({ ...def, quoteRequest: { ...def.quoteRequest, [k]: v } });
    const r = await call(h, "POST", "/fund/quote", fundBody({ dry: false }));
    assert.equal(r.status, 502, k);
    assert.equal(r.json.code, "quote_mismatch", k);
    assert.equal([...h.kv.map.keys()].filter((x) => x.startsWith("rec:")).length, 0, k);
  }
});

test("a real quote with no depositAddress is refused", async () => {
  const h = harness();
  h.fake.onQuote = (_req, def) => signQuote({ ...def, quote: { ...def.quote, depositAddress: undefined } });
  assert.equal((await call(h, "POST", "/fund/quote", fundBody({ dry: false }))).json.code, "quote_mismatch");
});

test("testnet Worker is dry-only: a real quote is 403 dry_only and 1Click is never asked", async () => {
  const h = harness({ network: "testnet", dryOnly: true });
  const r = await call(h, "POST", "/fund/quote", fundBody({ dry: false }));
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "dry_only");
  assert.equal(h.fake.calls.length, 0);
});

test("at most 5 open transfers per account (429 too_many_open); terminal / long-expired ones do not count", async () => {
  const h = harness();
  const addrs: string[] = [];
  for (let i = 0; i < 5; i++) { const r = await call(h, "POST", "/fund/quote", fundBody({ dry: false }), { "cf-connecting-ip": `10.0.0.${i}` }); assert.equal(r.status, 200, r.text); addrs.push(r.json.depositAddress); }
  const r6 = await call(h, "POST", "/fund/quote", fundBody({ dry: false }), { "cf-connecting-ip": "10.0.1.1" });
  assert.equal(r6.status, 429);
  assert.equal(r6.json.code, "too_many_open");
  await h.state.patch(addrs[0]!, { status: "SUCCESS" });
  assert.equal((await call(h, "POST", "/fund/quote", fundBody({ dry: false }), { "cf-connecting-ip": "10.0.1.2" })).status, 200);
  h.setNow(NOW + 2 * 3_600_000); // every 1 h address is past deadline + 30 min
  assert.equal((await call(h, "POST", "/fund/quote", fundBody({ dry: false }), { "cf-connecting-ip": "10.0.1.3" })).status, 200);
});
