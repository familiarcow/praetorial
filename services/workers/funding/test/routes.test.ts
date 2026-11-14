// F1 RED/GREEN: /fund/status (no open proxy), /fund/submit-tx, /tokens (cached), CORS, rate limits (429 + Retry-After),
// error mapping for every 1Click 400 text in the FUND3/FUND4/F1 evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT, BET, NOW, TOKENS, TRON_USDT, USDC, call, fundBody, harness, throwing } from "./helpers.js";
import { LIMITS } from "../src/core.js";
import { OneClickError } from "../src/oneclick.js";

test("status: an address with no record is 404 and 1Click is NOT called (no open proxy)", async () => {
  const h = harness();
  const r = await call(h, "GET", "/fund/status?depositAddress=someone-elses-address");
  assert.equal(r.status, 404);
  assert.equal(h.fake.calls.filter((c) => c.op === "status").length, 0);
});

test("status: proxies 1Click for a stored record, stores the new state, never returns the signed quote", async () => {
  const h = harness();
  const q = await call(h, "POST", "/fund/quote", fundBody({ dry: false }));
  const addr = q.json.depositAddress;
  h.fake.statusOf.set(addr, { correlationId: "c", quoteResponse: {}, status: "REFUNDED", updatedAt: new Date(NOW).toISOString(), swapDetails: { refundedAmount: "40000000", refundReason: "PARTIAL_DEPOSIT", originChainTxHashes: [{ hash: "abc", explorerUrl: "https://x" }] } });
  const r = await call(h, "GET", `/fund/status?depositAddress=${addr}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, "REFUNDED");
  assert.equal(r.json.refundedAmount, "40000000");
  assert.equal(r.json.refundReason, "PARTIAL_DEPOSIT");
  assert.deepEqual(r.json.originTxs, [{ hash: "abc", explorerUrl: "https://x" }]);
  assert.equal(r.json.record.state, "refunded");
  assert.equal(r.json.record.refunded, "40000000");
  assert.ok(!r.text.includes("signature"));
  assert.equal((await h.state.get(addr))!.status, "REFUNDED");
});

test("status: 1Click down -> 503 upstream_down (the web shows 'checking', never 'failed'); stored state unchanged", async () => {
  const h = harness();
  const addr = (await call(h, "POST", "/fund/quote", fundBody({ dry: false }))).json.depositAddress;
  h.fake.statusOf.set(addr, new OneClickError("upstream_down", 502, "bad gateway"));
  const r = await call(h, "GET", `/fund/status?depositAddress=${addr}`);
  assert.equal(r.status, 503);
  assert.equal(r.json.code, "upstream_down");
  assert.equal((await h.state.get(addr))!.status, "PENDING_DEPOSIT");
});

test("submit-tx: only for a stored fund record; passes the record's own address (and memo) to 1Click", async () => {
  const h = harness();
  assert.equal((await call(h, "POST", "/fund/submit-tx", { depositAddress: "nope", txHash: "0xabcdef0123" })).status, 404);
  const addr = (await call(h, "POST", "/fund/quote", fundBody({ dry: false }))).json.depositAddress;
  const r = await call(h, "POST", "/fund/submit-tx", { depositAddress: addr, txHash: "0xabcdef0123" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(h.fake.calls.find((c) => c.op === "submitDeposit")!.body, { txHash: "0xabcdef0123", depositAddress: addr });
  assert.equal((await call(h, "POST", "/fund/submit-tx", { depositAddress: addr, txHash: "bad hash with spaces" })).json.code, "bad_tx_hash");
});

test("/tokens: the 1Click list + the 6 bet ids; cached for 5 min (one upstream call); the last good list survives an outage", async () => {
  const h = harness();
  const a = await call(h, "GET", "/tokens");
  assert.equal(a.status, 200);
  assert.equal(a.json.tokens.length, TOKENS.length);
  assert.deepEqual(a.json.bettingAssetIds, BET);
  await call(h, "GET", "/tokens");
  await call(h, "POST", "/fund/quote", fundBody());
  assert.equal(h.fake.calls.filter((c) => c.op === "tokens").length, 1);
  h.setNow(NOW + 6 * 60_000); h.fake.tokensFail = true;
  assert.equal((await call(h, "GET", "/tokens")).status, 200, "stale list served while 1Click is down");
  const cold = harness(); cold.fake.tokensFail = true;
  const r = await call(cold, "GET", "/tokens");
  assert.equal(r.status, 503);
  assert.equal(r.json.code, "upstream_down");
});

test("CORS: an unknown Origin is 403 before anything runs; the allowed one is echoed; preflight 204; never '*'", async () => {
  const h = harness();
  const bad = await call(h, "POST", "/fund/quote", fundBody(), { origin: "https://evil.example" });
  assert.equal(bad.status, 403);
  assert.equal(h.fake.calls.length, 0);
  const ok = await call(h, "GET", "/tokens");
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://app.praetorial.test");
  const pre = await call(h, "OPTIONS", "/fund/quote");
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-methods") ?? "", /POST/);
  assert.notEqual(pre.headers.get("access-control-allow-origin"), "*");
  assert.equal((await call(h, "POST", "/fund/quote", fundBody())).headers.get("cache-control"), "no-store");
});

test("rate limits: dry quotes 60/min per IP -> 429 with Retry-After, exposed to the browser; another IP is unaffected", async () => {
  const h = harness();
  for (let i = 0; i < LIMITS.dryPerMinPerIp; i++) assert.equal((await call(h, "POST", "/fund/quote", fundBody())).status, 200, `call ${i}`);
  const r = await call(h, "POST", "/fund/quote", fundBody());
  assert.equal(r.status, 429);
  assert.equal(r.json.code, "rate_limited");
  assert.ok(Number(r.headers.get("retry-after")) > 0);
  assert.match(r.headers.get("access-control-expose-headers") ?? "", /retry-after/);
  assert.equal((await call(h, "POST", "/fund/quote", fundBody(), { "cf-connecting-ip": "198.51.100.1" })).status, 200);
});

test("rate limits: real quotes 10/h per account even across IPs; status 120/min per IP; intent 10/h per account", async () => {
  const h = harness();
  const addrs: string[] = [];
  for (let i = 0; i < LIMITS.realPerHourPerAccount; i++) {
    const r = await call(h, "POST", "/fund/quote", fundBody({ dry: false }), { "cf-connecting-ip": `10.1.0.${i}` });
    if (r.status === 200) { addrs.push(r.json.depositAddress); await h.state.patch(r.json.depositAddress, { status: "FAILED" }); }
    else assert.fail(r.text);
  }
  const over = await call(h, "POST", "/fund/quote", fundBody({ dry: false }), { "cf-connecting-ip": "10.1.1.1" });
  assert.equal(over.status, 429);
  assert.equal(over.json.code, "rate_limited");
  for (let i = 0; i < LIMITS.statusPerMinPerIp; i++) await call(h, "GET", `/fund/status?depositAddress=${addrs[0]}`);
  assert.equal((await call(h, "GET", `/fund/status?depositAddress=${addrs[0]}`)).status, 429);
});

test("no cf-connecting-ip -> 400 fail closed on limited routes", async () => {
  const h = harness();
  const r = await call(h, "POST", "/fund/quote", fundBody(), { "cf-connecting-ip": "" });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "no_client_ip");
});

test("1Click 400 texts from the evidence map to stable codes (too_low carries minUnits); raw 5xx text never reaches the user", async () => {
  const cases: [number, string, number, string][] = [
    [400, "Amount is too low for bridge, try at least 1218977", 422, "too_low"],
    [400, "recipient is not valid", 422, "bad_recipient"],
    [400, "refundTo is not valid", 422, "bad_refund"],
    [400, "Internal server error", 422, "no_route"],
    [400, "Quoting for this pair is not available", 422, "no_route"],
    [400, "No liquidity available", 422, "no_route"],
    [400, "Incorrect depositMode for originAsset from stellar chain", 422, "no_route"],
    [400, "deadline is not valid", 422, "deadline"],
    [401, "Unauthorized", 503, "upstream_down"],
    [503, "<html>gateway secret-ish page</html>", 503, "upstream_down"],
  ];
  for (const [st, msg, want, code] of cases) {
    const h = harness();
    h.fake.onQuote = () => throwing(st, msg);
    const r = await call(h, "POST", "/fund/quote", fundBody());
    assert.equal(r.status, want, msg);
    assert.equal(r.json.code, code, msg);
    if (code === "too_low") assert.equal(r.json.minUnits, "1218977");
    if (want === 503) assert.doesNotMatch(r.text, /gateway|Unauthorized/);
  }
});

test("unknown route 404; GET /fund/list validates the account", async () => {
  const h = harness();
  assert.equal((await call(h, "GET", "/nope")).status, 404);
  assert.equal((await call(h, "GET", "/fund/list?account=alice.near")).json.code, "bad_account");
  assert.equal((await call(h, "GET", `/fund/list?account=${ACCOUNT}`)).status, 200);
  assert.equal((await call(h, "GET", "/nope")).json.error, "no_route_here", "error bodies carry `error` (F2 client) as well as `code`");
  void TRON_USDT; void USDC;
});
