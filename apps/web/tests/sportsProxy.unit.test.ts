// TPL2: the NHL league source (api-web.nhle.com) sends no CORS headers, so the web Worker proxies ONLY its per-day score/schedule
// reads, GET-only, same-origin at /_proxy/sports/nhl/v1/(score|schedule)/YYYY-MM-DD, cached 5 minutes. Everything else is refused
// without any upstream fetch. Unlike the indexer/relayer/registry Workers this is a public third-party read, so it is a plain URL
// fetch on both networks (no service binding involved).
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, SPORTS_UPSTREAMS, SPORTS_CACHE_SECS } from "../worker/index";

type Call = { url: string; init: any };
const env = (net?: string) => ({ ASSETS: { fetch: async () => new Response("asset") }, ...(net ? { NETWORK_ID: net } : {}) });
const stub = (calls: Call[], status = 200) => (async (u: any, init?: any) => {
  calls.push({ url: String(u), init });
  return new Response("{\"games\":[]}", { status, headers: { "content-type": "application/json", "set-cookie": "a=1", "cache-control": "max-age=9" } });
}) as typeof fetch;

test("allowlist: only api-web.nhle.com", () => {
  assert.deepEqual(SPORTS_UPSTREAMS, { nhl: "https://api-web.nhle.com" });
  assert.equal(SPORTS_CACHE_SECS, 300);
});

for (const net of [undefined, "testnet", "mainnet"]) {
  test(`${net ?? "default"}: GET /_proxy/sports/nhl/v1/score/<date> and /schedule/<date> are fetched GET-only and cached 5 min`, async () => {
    for (const kind of ["score", "schedule"]) {
      const calls: Call[] = [];
      const r = await handle(new Request(`https://w.example/_proxy/sports/nhl/v1/${kind}/2026-11-12`, { headers: { cookie: "s=1", authorization: "x" } }), env(net), stub(calls));
      assert.equal(r.status, 200);
      assert.equal(await r.text(), "{\"games\":[]}");
      assert.equal(r.headers.get("cache-control"), "public, max-age=300");
      assert.equal(r.headers.get("content-type"), "application/json");
      assert.equal(r.headers.get("set-cookie"), null);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `https://api-web.nhle.com/v1/${kind}/2026-11-12`);
      assert.equal(calls[0].init.method, "GET");
      assert.equal(calls[0].init.body, undefined);
      assert.deepEqual(calls[0].init.cf, { cacheTtl: 300, cacheEverything: true });
      const h = new Headers(calls[0].init.headers);
      assert.equal(h.get("cookie"), null); assert.equal(h.get("authorization"), null); // nothing from the browser is forwarded
    }
  });
}

test("anything else under /_proxy/sports is refused with no upstream fetch", async () => {
  const calls: Call[] = [];
  const bad = [
    "/_proxy/sports/nhl/v1/player/8478402/landing", "/_proxy/sports/nhl/v1/score/now", "/_proxy/sports/nhl/v1/score/2026-11-12/x",
    "/_proxy/sports/nhl/v1/score/2026-11-12?x=1", "/_proxy/sports/nhl/v1/score/..%2F..%2Fx", "/_proxy/sports/mlb/api/v1/schedule",
    "/_proxy/sports/espn/x", "/_proxy/sports/", "/_proxy/sports",
  ];
  for (const p of bad) {
    const r = await handle(new Request(`https://w.example${p}`), env("mainnet"), stub(calls));
    assert.equal(r.status, 404, p);
  }
  for (const m of ["POST", "PUT", "DELETE"]) {
    const r = await handle(new Request("https://w.example/_proxy/sports/nhl/v1/score/2026-11-12", { method: m, body: "{}" }), env(), stub(calls));
    assert.equal(r.status, 405, m);
  }
  assert.equal(calls.length, 0);
});

test("upstream trouble is a 502 the picker turns into 'try again'; it is not cached", async () => {
  const calls: Call[] = [];
  const r = await handle(new Request("https://w.example/_proxy/sports/nhl/v1/score/2026-11-12"), env(), stub(calls, 503));
  assert.equal(r.status, 502);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const t = await handle(new Request("https://w.example/_proxy/sports/nhl/v1/score/2026-11-12"), env(), (async () => { throw new Error("down"); }) as typeof fetch);
  assert.equal(t.status, 502);
});
