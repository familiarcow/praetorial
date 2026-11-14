// RED -> GREEN: real 1Click quote HTTP client for D-ECON2 follow-up
// (2). Request/response shape per the public docs cited in
// src/oneClickClient.ts and README.md:
// https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote
// (POST /v0/quote, `dry` flag) and
// https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request
// (auth: bearer JWT). Every test mocks fetchImpl -- no network call is
// ever made. The client refuses to send a non-dry (`dry: false`)
// request at all: live swap submission stays unimplemented-to-network
// no matter what env flags are set, by construction, not just by test
// omission.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpOneClickClient } from "../src/oneClickHttpClient.js";
import type { OneClickQuoteRequest } from "../src/oneClickClient.js";

function baseReq(overrides: Partial<OneClickQuoteRequest> = {}): OneClickQuoteRequest {
  return {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: "nep141:usdc.near",
    depositType: "INTENTS",
    destinationAsset: "nep141:wrap.near",
    amount: "1000000",
    refundTo: "fees.praetorial-dev-1101.near",
    refundType: "INTENTS",
    recipient: "fees.praetorial-dev-1101.near",
    recipientType: "INTENTS",
    deadline: new Date().toISOString(),
    ...overrides,
  };
}

test("sends dry:true quote requests to POST /v0/quote with a Bearer auth header from the injected api key", async () => {
  let calledUrl: string | undefined;
  let calledInit: any;
  const fetchImpl = (async (url: any, init: any) => {
    calledUrl = String(url);
    calledInit = init;
    return new Response(JSON.stringify({ quote: { amountIn: "1000000", amountOut: "999000" } }), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new HttpOneClickClient({ apiKey: "secret-jwt-value", fetchImpl });
  const req = baseReq();
  const resp = await client.getQuote(req);

  assert.equal(calledUrl, "https://1click.chaindefuser.com/v0/quote");
  assert.equal(calledInit.method, "POST");
  assert.equal(calledInit.headers["authorization"], "Bearer secret-jwt-value");
  assert.deepEqual(JSON.parse(calledInit.body), req);
  assert.equal(resp.quote.amountOut, "999000");
});

test("defaults the api key from ONECLICK_API_KEY and never sends it anywhere but the auth header", async () => {
  const prev = process.env.ONECLICK_API_KEY;
  process.env.ONECLICK_API_KEY = "env-jwt-value";
  try {
    let calledInit: any;
    const fetchImpl = (async (_url: any, init: any) => {
      calledInit = init;
      return new Response(JSON.stringify({ quote: { amountIn: "1", amountOut: "1" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new HttpOneClickClient({ fetchImpl });
    await client.getQuote(baseReq());
    assert.equal(calledInit.headers["authorization"], "Bearer env-jwt-value");
    assert.ok(!calledInit.body.includes("env-jwt-value"));
  } finally {
    if (prev === undefined) delete process.env.ONECLICK_API_KEY;
    else process.env.ONECLICK_API_KEY = prev;
  }
});

test("sends no authorization header when no api key is configured anywhere", async () => {
  const prev = process.env.ONECLICK_API_KEY;
  delete process.env.ONECLICK_API_KEY;
  try {
    let calledInit: any;
    const fetchImpl = (async (_url: any, init: any) => {
      calledInit = init;
      return new Response(JSON.stringify({ quote: { amountIn: "1", amountOut: "1" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new HttpOneClickClient({ fetchImpl });
    await client.getQuote(baseReq());
    assert.equal("authorization" in calledInit.headers, false);
  } finally {
    if (prev === undefined) delete process.env.ONECLICK_API_KEY;
    else process.env.ONECLICK_API_KEY = prev;
  }
});

test("refuses a non-dry request before ever touching fetch", async () => {
  let fetchCalled = false;
  const fetchImpl = (async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const client = new HttpOneClickClient({ fetchImpl });
  await assert.rejects(() => client.getQuote(baseReq({ dry: false })), /dry/i);
  assert.equal(fetchCalled, false);
});

test("surfaces a clear, key-free error on a non-OK HTTP response", async () => {
  const fetchImpl = (async () =>
    new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
  const client = new HttpOneClickClient({ apiKey: "secret-jwt-value", fetchImpl });
  await assert.rejects(
    () => client.getQuote(baseReq()),
    (err: any) => {
      assert.match(err.message, /502/);
      assert.ok(!err.message.includes("secret-jwt-value"));
      return true;
    },
  );
});

test("throws a clear error when the response body is missing the quote object", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
  const client = new HttpOneClickClient({ fetchImpl });
  await assert.rejects(() => client.getQuote(baseReq()), /quote/i);
});

test("respects a custom baseUrl override", async () => {
  let calledUrl: string | undefined;
  const fetchImpl = (async (url: any) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ quote: { amountIn: "1", amountOut: "1" } }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new HttpOneClickClient({ baseUrl: "https://staging.example.com", fetchImpl });
  await client.getQuote(baseReq());
  assert.equal(calledUrl, "https://staging.example.com/v0/quote");
});
