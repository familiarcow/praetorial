// F1 RED/GREEN: every 1Click request carries `User-Agent: praetorial-funding/<GIT_SHA>` and `Accept: application/json` (1Click's
// Cloudflare WAF answers 403 "error code: 1010" without a User-Agent), and X-API-Key only when the secret is configured.
import { test } from "node:test";
import assert from "node:assert/strict";
import { oneClickClient, mapOneClickError, userAgent, OneClickError } from "../src/oneclick.js";

const KEY = "eyJhbGciOiJIUzI1NiJ9.FAKE-ONECLICK-PARTNER-JWT.sig0123456789";
function stub(status = 200, body: string = "[]") {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response(body, { status }); };
  return { seen, fetchImpl, h: (i = 0) => new Headers(seen[i]!.init.headers as Record<string, string>) };
}

test("every endpoint sends User-Agent praetorial-funding/<GIT_SHA> + Accept application/json (+ content-type on POST)", async () => {
  const s = stub(200, "{}");
  const c = oneClickClient({ baseUrl: "https://1click.test/", apiKey: KEY, gitSha: "abc123def456", fetchImpl: s.fetchImpl });
  await c.tokens(); await c.quote({} as any); await c.status("addr 1", "m"); await c.submitDeposit({ txHash: "t", depositAddress: "a" });
  await c.generateIntent({ type: "swap_transfer", standard: "nep413", signerId: "s", depositAddress: "a" }); await c.submitIntent({ type: "swap_transfer", signedData: {} as any });
  assert.deepEqual(s.seen.map((x) => `${x.init.method} ${x.url}`), [
    "GET https://1click.test/v0/tokens", "POST https://1click.test/v0/quote", "GET https://1click.test/v0/status?depositAddress=addr%201&depositMemo=m",
    "POST https://1click.test/v0/deposit/submit", "POST https://1click.test/v0/generate-intent", "POST https://1click.test/v0/submit-intent",
  ]);
  s.seen.forEach((_, i) => {
    assert.equal(s.h(i).get("user-agent"), "praetorial-funding/abc123def456");
    assert.equal(s.h(i).get("accept"), "application/json");
    assert.equal(s.h(i).get("x-api-key"), KEY);
    assert.equal(s.h(i).get("authorization"), null, "legacy Bearer scheme not used");
  });
  assert.equal(s.h(1).get("content-type"), "application/json");
});

test("no key configured -> no X-API-Key header at all (public quotes still work); UA falls back to praetorial-funding/unknown", async () => {
  const s = stub();
  await oneClickClient({ baseUrl: "https://1click.test", fetchImpl: s.fetchImpl }).tokens();
  assert.equal(s.h().get("x-api-key"), null);
  assert.equal(s.h().get("user-agent"), "praetorial-funding/unknown");
  assert.equal(userAgent("x y\nInjected: 1"), "praetorial-funding/unknown", "a weird sha cannot inject a header");
});

test("the WAF's 403 'error code: 1010' (non-JSON) -> upstream_auth, and the error never carries the key", async () => {
  const s = stub(403, "error code: 1010");
  const c = oneClickClient({ baseUrl: "https://1click.test", apiKey: KEY, fetchImpl: s.fetchImpl });
  await assert.rejects(c.tokens(), (e: any) => e instanceof OneClickError && e.code === "upstream_auth" && !JSON.stringify({ ...e, m: e.message, u: e.upstreamMessage }).includes(KEY));
});

test("network failure / timeout -> upstream_down", async () => {
  const c = oneClickClient({ baseUrl: "https://1click.test", fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(c.tokens(), (e: any) => e.code === "upstream_down");
});

test("mapOneClickError: 404 not_found, 429 upstream_down, unknown 400 -> upstream_rejected", () => {
  assert.equal(mapOneClickError(404, "Deposit address x not found").code, "not_found");
  assert.equal(mapOneClickError(429, "slow down").code, "upstream_down");
  assert.equal(mapOneClickError(400, "something new").code, "upstream_rejected");
});
