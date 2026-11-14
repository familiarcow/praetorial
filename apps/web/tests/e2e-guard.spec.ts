// FE10e: the shared guard blocks unmocked off-box requests and fails the test that made them.
import { test, expect } from "./e2eGuard";

const mockRpc = (page: import("@playwright/test").Page) => page.route("https://test.rpc.fastnear.com/", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result: {} }) }));

test("an unmocked off-box request is aborted and recorded; a spec's own page.route still wins", async ({ page, e2eGuard }) => {
  await mockRpc(page);
  await page.route("https://mocked.e2e.test/ok", (r) => r.fulfill({ status: 200, body: "mine" }));
  await page.goto("/");
  const res = await page.evaluate(async () => {
    const mine = await (await fetch("https://mocked.e2e.test/ok")).text();
    const escaped = await fetch("https://example.com/leak").then(() => "reached", () => "blocked");
    return { mine, escaped };
  });
  expect(res).toEqual({ mine: "mine", escaped: "blocked" });
  expect(e2eGuard.violations).toEqual(["GET https://example.com/leak"]);
  e2eGuard.violations.length = 0; // consumed: the guard's own teardown assertion must not fail this proof
});

test("Privy app config is served locally (ready no longer needs auth.privy.io)", async ({ page }) => {
  await mockRpc(page);
  await page.goto("/new");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
});

// FE10f: swapping a mock must never open a window where an in-flight request reaches the guard.
import { swappableRoute } from "./swappableRoute";
const RPC_URL = "https://test.rpc.fastnear.com/";
const fulfilled = (body: string) => (r: import("@playwright/test").Route) => r.fulfill({ status: 200, contentType: "text/plain", headers: { "access-control-allow-origin": "*" }, body });

test("FE10f: a request issued between swapping a mock's behaviour is still answered by the mock (no unroute gap)", async ({ page, e2eGuard }) => {
  await page.goto("/");
  const ctl = await swappableRoute(page, RPC_URL, fulfilled("one"));
  const first = await page.evaluate(async (u) => (await fetch(u)).text(), RPC_URL);
  ctl.set(fulfilled("two"));
  const second = await page.evaluate(async (u) => (await fetch(u)).text(), RPC_URL);
  expect([first, second]).toEqual(["one", "two"]);
  expect(e2eGuard.violations).toEqual([]);
});

test("FE10f: documents the gap: unroute-then-route lets a request through to the guard (why specs must not do it)", async ({ page, e2eGuard }) => {
  await page.goto("/");
  await page.route(RPC_URL, fulfilled("one"));
  await page.unroute(RPC_URL);
  const r = await page.evaluate(async (u) => fetch(u).then(() => "reached", () => "blocked"), RPC_URL);
  expect(r).toBe("blocked");
  expect(e2eGuard.violations).toContain(`GET ${RPC_URL}`); // the app's own background POSTs land in the gap too: that is the bug
  e2eGuard.violations.length = 0; // consumed
});
