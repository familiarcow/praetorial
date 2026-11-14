// FE4b (D-FE4b): HttpUserRegistry.searchStrict throws on network/HTTP errors (search() keeps swallowing them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpUserRegistry, MockUserRegistry, refereeTakeAgreementLine } from "../lib/refereeRegistry";

const res = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

test("searchStrict: GETs /search?q= (encoded, @ stripped, trimmed) and maps account_tail -> account", async () => {
  const urls: string[] = [];
  const r = new HttpUserRegistry("https://reg.example/", (async (u: string) => { urls.push(u); return res(200, [{ username: "ivy", account_tail: "abcd1234" }]); }) as any);
  assert.deepEqual(await r.searchStrict("  @Iv y "), [{ username: "ivy", account: "abcd1234" }]);
  assert.equal(urls[0], "https://reg.example/search?q=" + encodeURIComponent("Iv y"));
});
test("searchStrict: empty query -> [] with no request", async () => {
  let n = 0;
  const r = new HttpUserRegistry("https://reg.example", (async () => { n++; return res(200, []); }) as any);
  assert.deepEqual(await r.searchStrict("  @ "), []);
  assert.equal(n, 0);
});
test("searchStrict: throws on HTTP errors (429, 500) and on network failure", async () => {
  for (const s of [429, 500, 503]) {
    const r = new HttpUserRegistry("https://reg.example", (async () => res(s)) as any);
    await assert.rejects(() => r.searchStrict("al"), /search failed/);
  }
  const r = new HttpUserRegistry("https://reg.example", (async () => { throw new Error("net"); }) as any);
  await assert.rejects(() => r.searchStrict("al"));
});
test("search() is unchanged: still swallows the same failures", async () => {
  const r = new HttpUserRegistry("https://reg.example", (async () => res(500)) as any);
  assert.deepEqual(await r.search("al"), []);
});
test("MockUserRegistry.searchStrict behaves like search", async () => {
  const m = new MockUserRegistry([{ username: "alice", account: "alice.testnet" }]);
  assert.deepEqual(await m.searchStrict("ali"), await m.search("ali"));
});
test("review agreement line shows username + account tail (implicit: last 8 chars; named: full id)", () => {
  const full = "ab".repeat(28) + "12345678";
  const l = refereeTakeAgreementLine({ mode: "human", referee: full }, "ivy");
  assert.match(l, /@ivy \(12345678\)/);
  assert.ok(!l.includes(full));
  assert.match(refereeTakeAgreementLine({ mode: "human", referee: "alice.testnet" }, "alice"), /@alice \(alice\.testnet\)/);
});
