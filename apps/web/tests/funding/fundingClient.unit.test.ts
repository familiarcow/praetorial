// F2: the funding Worker client (lib/funding/fundingClient.ts) and NETWORK.fundingUrl.
import test from "node:test";
import assert from "node:assert/strict";
import { NETWORKS, resolveNetwork } from "../../lib/network";
import { createFundingClient, FundingError, parseQuoteView, parseStatusView } from "../../lib/funding/fundingClient";
import { createMockFundingWorker, FUNDING_URL, ACCOUNT, ID, DEPOSIT_ADDRESS, STATUS, fundQuote } from "./fixtures";

// DEPLOYFIX: F1 is live on mainnet, so the table pins its URL (was "" = not configured, which made build:mainnet ship 1Click off;
// tests/deployfixFunding.unit.test.ts). The fail-closed path for an unconfigured Worker is the next test.
test("fundingUrl: mainnet = the live F1 mainnet Worker; testnet = F1's testnet Worker; env override wins", () => {
  assert.equal(NETWORKS.mainnet.fundingUrl, "https://funding.praetorial.com");
  assert.equal(NETWORKS.testnet.fundingUrl, "https://praetorial-funding-testnet.familiarcow.workers.dev");
  assert.equal(resolveNetwork({ NETWORK_ID: "mainnet", VITE_FUNDING_URL: "https://f.example" }).fundingUrl, "https://f.example");
  assert.equal(resolveNetwork({ NETWORK_ID: "mainnet", FUNDING_URL: "https://g.example" }).fundingUrl, "https://g.example");
});

test("an unconfigured Worker fails closed with not_configured and never calls fetch", async () => {
  let called = false;
  const c = createFundingClient({ baseUrl: "", fetch: async () => { called = true; return new Response("{}"); } });
  await assert.rejects(c.health(), (e: any) => e instanceof FundingError && e.code === "not_configured");
  assert.equal(called, false);
});

test("fund quote: posts only account/originAsset/betWith/amount/dry (never a recipient or refund address)", async () => {
  const w = createMockFundingWorker();
  const c = createFundingClient({ baseUrl: FUNDING_URL, fetch: w.fetch });
  const q = await c.fundQuote({ account: ACCOUNT, originAsset: ID.TRON_USDT, betWith: ID.USDC, amountIn: "20000000", dry: false });
  assert.equal(q.depositAddress, DEPOSIT_ADDRESS);
  assert.equal(q.amountOut, "19977493");
  const call = w.calls.find((x) => x.path === "/fund/quote")!;
  assert.equal(call.method, "POST");
  assert.deepEqual(Object.keys(call.body).sort(), ["account", "amountIn", "betWith", "dry", "originAsset"]);
});

test("fund quote refuses client-side to send a betWith that is not one of the 6", async () => {
  const w = createMockFundingWorker();
  const c = createFundingClient({ baseUrl: FUNDING_URL, fetch: w.fetch });
  await assert.rejects(c.fundQuote({ account: ACCOUNT, originAsset: ID.TRON_USDT, betWith: ID.TRON_USDT, amountIn: "1", dry: true }), (e: any) => e.code === "bad_request");
  assert.equal(w.calls.length, 0);
});

test("withdraw/convert quote: convert must land in the 6 and carries no recipient", async () => {
  const w = createMockFundingWorker();
  const c = createFundingClient({ baseUrl: FUNDING_URL, fetch: w.fetch });
  await assert.rejects(c.withdrawQuote({ account: ACCOUNT, kind: "convert", originAsset: ID.ETH_USDC, amountIn: "1000000", destinationAsset: ID.SOL_USDC, dry: true }), (e: any) => e.code === "bad_request");
  await assert.rejects(c.withdrawQuote({ account: ACCOUNT, kind: "convert", originAsset: ID.ETH_USDC, amountIn: "1000000", destinationAsset: ID.USDC, recipient: "x", dry: true }), (e: any) => e.code === "bad_request");
  await c.withdrawQuote({ account: ACCOUNT, kind: "convert", originAsset: ID.ETH_USDC, amountIn: "1000000", destinationAsset: ID.USDC, dry: true });
  await assert.rejects(c.withdrawQuote({ account: ACCOUNT, kind: "withdraw", originAsset: ID.USDC, amountIn: "1", destinationAsset: ID.TRON_USDT, dry: true }), (e: any) => e.code === "bad_request", "cash out needs a recipient");
  await c.withdrawQuote({ account: ACCOUNT, kind: "withdraw", originAsset: ID.USDC, amountIn: "20000000", destinationAsset: ID.TRON_USDT, recipient: "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9", dry: false });
  assert.equal(w.calls.filter((x) => x.path === "/withdraw/quote").length, 2);
});

test("error mapping: too_low carries the minimum, rate_limited the Retry-After, 5xx/network -> upstream_down/network", async () => {
  const w = createMockFundingWorker({ errors: { "POST /fund/quote": { code: "too_low", minUnits: "1218977" }, "GET /fund/list": { code: "rate_limited" } } });
  const c = createFundingClient({ baseUrl: FUNDING_URL, fetch: w.fetch });
  await assert.rejects(c.fundQuote({ account: ACCOUNT, originAsset: ID.TRON_USDT, betWith: ID.USDC, amountIn: "1", dry: true }), (e: any) => e.code === "too_low" && e.minUnits === "1218977");
  await assert.rejects(c.list(ACCOUNT), (e: any) => e.code === "rate_limited" && e.retryAfterSec === 30);
  const down = createFundingClient({ baseUrl: FUNDING_URL, fetch: createMockFundingWorker({ down: true }).fetch });
  await assert.rejects(down.health(), (e: any) => e.code === "upstream_down");
  const offline = createFundingClient({ baseUrl: FUNDING_URL, fetch: async () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(offline.health(), (e: any) => e.code === "network");
  const garbage = createFundingClient({ baseUrl: FUNDING_URL, fetch: async () => new Response("<html>", { status: 502 }) });
  await assert.rejects(garbage.health(), (e: any) => e.code === "upstream_down");
  const unknown = createFundingClient({ baseUrl: FUNDING_URL, fetch: async () => new Response(JSON.stringify({ error: "weird" }), { status: 400 }) });
  await assert.rejects(unknown.health(), (e: any) => e.code === "bad_request");
});

test("status and list: url-encoded query, StatusView parsed defensively", async () => {
  const w = createMockFundingWorker();
  const c = createFundingClient({ baseUrl: FUNDING_URL + "/", fetch: w.fetch });
  await c.fundQuote({ account: ACCOUNT, originAsset: ID.TRON_USDT, betWith: ID.USDC, amountIn: "20000000", dry: false });
  const s = await c.status(DEPOSIT_ADDRESS, null);
  assert.equal(s.status, "PENDING_DEPOSIT");
  const call = w.calls.find((x) => x.path === "/fund/status")!;
  assert.deepEqual(call.query, { depositAddress: DEPOSIT_ADDRESS });
  await c.status(DEPOSIT_ADDRESS, "memo 1");
  assert.equal(w.calls.filter((x) => x.path === "/fund/status")[1].query.memo, "memo 1");
  const list = await c.list(ACCOUNT);
  assert.equal(list.length, 1);
  assert.equal(list[0].depositAddress, DEPOSIT_ADDRESS);
});

test("parsers reject a response that isn't a quote/status (never trust a half-shaped body)", () => {
  assert.throws(() => parseQuoteView({ amountIn: "1" }), (e: any) => e.code === "upstream_down");
  assert.throws(() => parseQuoteView({ ...fundQuote(), amountOut: "1.5" }), (e: any) => e.code === "upstream_down");
  assert.throws(() => parseStatusView({ status: "DONE" }), (e: any) => e.code === "upstream_down");
  assert.deepEqual(parseStatusView({ status: "SUCCESS" }), { ...STATUS.credited, updatedAt: null, correlationId: null, depositedAmount: null, amountOut: null });
});

test("intent + submit: the client passes the depositAddress through and returns the hash", async () => {
  const w = createMockFundingWorker();
  const c = createFundingClient({ baseUrl: FUNDING_URL, fetch: w.fetch });
  const i = await c.withdrawIntent(ACCOUNT, "dep1");
  assert.equal(i.hash, "00".repeat(32));
  const s = await c.withdrawSubmit("dep1", { signature: "x" });
  assert.equal(s.intentHash, "mockIntentHash");
  await c.submitTx("dep1", "0xabc", null);
  assert.deepEqual(w.calls.map((x) => x.path), ["/withdraw/intent", "/withdraw/submit", "/fund/submit-tx"]);
});
