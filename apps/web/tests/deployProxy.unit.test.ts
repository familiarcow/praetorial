// WEBDEP1: the indexer/relayer Workers send no CORS headers, so the preview Worker proxies them same-origin (/_proxy/<svc>/*).
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, UPSTREAMS } from "../worker/index";

const env = (hits: string[]) => ({ ASSETS: { fetch: async (r: Request | string) => { hits.push("asset:" + new URL(typeof r === "string" ? r : r.url).pathname); return new Response("asset"); } } });
const stubFetch = (calls: Array<{ url: string; method: string }>) => (async (u: any, init?: any) => { calls.push({ url: String(u), method: init?.method ?? "GET" }); return new Response("{\"ok\":true}", { status: 200, headers: { "content-type": "application/json", "set-cookie": "x=1" } }); }) as typeof fetch;

test("upstreams are the testnet workers.dev Workers only", () => {
  assert.deepEqual(Object.keys(UPSTREAMS).sort(), ["indexer", "registry", "relayer"]);
  for (const u of Object.values(UPSTREAMS)) assert.match(u, /^https:\/\/praetorial-[a-z]+-testnet\.familiarcow\.workers\.dev$/);
});
test("proxies /_proxy/indexer/offers?x=1 to the indexer, strips set-cookie", async () => {
  const calls: any[] = [];
  const r = await handle(new Request("https://w.example/_proxy/indexer/offers?x=1"), env([]), stubFetch(calls));
  assert.equal(r.status, 200); assert.equal(r.headers.get("set-cookie"), null);
  assert.deepEqual(calls, [{ url: `${UPSTREAMS.indexer}/offers?x=1`, method: "GET" }]);
});
test("POST to relayer is forwarded; unknown service 404; bad method 405; other paths go to assets", async () => {
  const calls: any[] = []; const hits: string[] = [];
  assert.equal((await handle(new Request("https://w.example/_proxy/relayer/relay", { method: "POST", body: "{}" }), env(hits), stubFetch(calls))).status, 200);
  assert.equal(calls[0].url, `${UPSTREAMS.relayer}/relay`);
  assert.equal((await handle(new Request("https://w.example/_proxy/evil/x"), env(hits), stubFetch(calls))).status, 404);
  assert.equal((await handle(new Request("https://w.example/_proxy/indexer/x", { method: "DELETE" }), env(hits), stubFetch(calls))).status, 405);
  await handle(new Request("https://w.example/browse"), env(hits), stubFetch(calls));
  assert.deepEqual(hits, ["asset:/browse"]); assert.equal(calls.length, 1);
});

// MAINPREP (3): on mainnet the proxy is service-binding only. A missing binding fails closed (502), never a URL fetch.
const bound = (calls: string[]) => ({ fetch: async (r: Request | string) => { calls.push(typeof r === "string" ? r : r.url); return new Response("{}", { status: 200 }); } });
test("mainnet: missing service binding -> 502 'service binding missing'; the URL fetch path is never used", async () => {
  const calls: any[] = [];
  for (const svc of ["indexer", "relayer", "registry"]) {
    const r = await handle(new Request(`https://w.example/_proxy/${svc}/x`), { ...env([]), NETWORK_ID: "mainnet" }, stubFetch(calls));
    assert.equal(r.status, 502);
    assert.match(await r.text(), /service binding missing/);
  }
  assert.equal(calls.length, 0, "no fetch to any URL on mainnet");
});
test("mainnet: a present binding is used and the request never names a testnet host", async () => {
  const calls: any[] = []; const via: string[] = [];
  const r = await handle(new Request("https://w.example/_proxy/indexer/offers?x=1"), { ...env([]), NETWORK_ID: "mainnet", INDEXER: bound(via) }, stubFetch(calls));
  assert.equal(r.status, 200);
  assert.equal(calls.length, 0);
  assert.equal(via.length, 1);
  assert.doesNotMatch(via[0], /testnet/);
  assert.match(via[0], /\/offers\?x=1$/);
});
test("an unknown NETWORK_ID fails closed (no fetch); testnet/unset keep the URL fallback", async () => {
  const calls: any[] = [];
  const r = await handle(new Request("https://w.example/_proxy/indexer/x"), { ...env([]), NETWORK_ID: "devnet" }, stubFetch(calls));
  assert.equal(r.status, 502); assert.equal(calls.length, 0);
  assert.equal((await handle(new Request("https://w.example/_proxy/indexer/x"), { ...env([]), NETWORK_ID: "testnet" }, stubFetch(calls))).status, 200);
  assert.equal(calls.length, 1);
});

// FUND1b: the faucet rate-limits per IP, so the proxy hands the relayer the caller's IP in x-client-ip (replacing any client-sent value).
test("FUND1b: relayer requests carry x-client-ip from cf-connecting-ip, never a client-supplied one", async () => {
  let seen: Headers | undefined;
  const f = (async (_u: any, init?: any) => { seen = new Headers(init?.headers); return new Response("{}", { status: 200 }); }) as typeof fetch;
  await handle(new Request("https://w.example/_proxy/relayer/faucet", { method: "POST", body: "{}", headers: { "cf-connecting-ip": "7.7.7.7", "x-client-ip": "1.1.1.1" } }), env([]), f);
  assert.equal(seen!.get("x-client-ip"), "7.7.7.7");
});

// TPL1: Kraken's public market data sends no CORS headers; the worker proxies two read-only public endpoints (testnet and mainnet:
// it is a public exchange API, not one of our services, so no service binding). Anything else under /_proxy/kraken is 404.
test("TPL1: /_proxy/kraken forwards only GET AssetPairs / Ticker to api.kraken.com, cached, on both networks", async () => {
  const { KRAKEN_UPSTREAM } = await import("../worker/index");
  assert.equal(KRAKEN_UPSTREAM, "https://api.kraken.com");
  for (const NETWORK_ID of [undefined, "testnet", "mainnet"]) {
    const calls: any[] = [];
    const e = { ...env([]), NETWORK_ID } as any;
    const r = await handle(new Request("https://w.example/_proxy/kraken/0/public/AssetPairs"), e, stubFetch(calls));
    assert.equal(r.status, 200, String(NETWORK_ID));
    assert.match(r.headers.get("cache-control") ?? "", /max-age=\d+/);
    const t = await handle(new Request("https://w.example/_proxy/kraken/0/public/Ticker?pair=ZECUSD"), e, stubFetch(calls));
    assert.equal(t.status, 200);
    assert.deepEqual(calls.map((c) => c.url), ["https://api.kraken.com/0/public/AssetPairs", "https://api.kraken.com/0/public/Ticker?pair=ZECUSD"]);
    assert.ok(calls.every((c) => c.method === "GET"));
    assert.equal((await handle(new Request("https://w.example/_proxy/kraken/0/private/Balance"), e, stubFetch(calls))).status, 404);
    assert.equal((await handle(new Request("https://w.example/_proxy/kraken/0/public/AssetPairs", { method: "POST", body: "{}" }), e, stubFetch(calls))).status, 405);
    assert.equal(calls.length, 2);
  }
});

test("SECREV1 SR-8/10/12: proxy answers are nosniff and never HTML; POST bodies are capped; the indexer is GET-only through the proxy", async () => {
  const htmlFetch = (async () => new Response("<script>alert(1)</script>", { status: 200, headers: { "content-type": "text/html", "x-extra": "1" } })) as typeof fetch;
  const r = await handle(new Request("https://w.example/_proxy/registry/name?u=x"), env([]), htmlFetch);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.doesNotMatch(r.headers.get("content-type") ?? "", /html/i, "an upstream text/html answer is never served as HTML on our origin");
  const ok = await handle(new Request("https://w.example/_proxy/indexer/offers"), env([]), stubFetch([]));
  assert.equal(ok.headers.get("content-type"), "application/json", "JSON passes unchanged");
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  const calls: any[] = [];
  const big = await handle(new Request("https://w.example/_proxy/relayer/relay", { method: "POST", body: "x".repeat(65 * 1024) }), env([]), stubFetch(calls));
  assert.equal(big.status, 413);
  assert.equal(calls.length, 0, "an oversized body is never forwarded");
  const tick = await handle(new Request("https://w.example/_proxy/indexer/tick", { method: "POST", body: "{}" }), env([]), stubFetch(calls));
  assert.equal(tick.status, 405);
  assert.equal(calls.length, 0, "POST /tick never reaches the indexer through the proxy");
});
