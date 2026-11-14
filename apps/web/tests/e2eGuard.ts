// FE10e shared guard. Every mocked spec imports { test, expect } from here instead of @playwright/test.
// Context-level catch-all (lowest priority: a spec's page.route always wins). Anything a spec did not mock is
//  - localhost/vite: passed through;
//  - Privy / WalletConnect / Datadog SDK chatter: answered from a recorded fixture or inert stub, so `__e2e.ready` never depends on
//    the real network (FE10e root cause: the real auth.privy.io config fetch stalled under concurrent suites);
//  - anything else: aborted, and the test FAILS at teardown naming the URL (no silent fall-through to the real network).
import { test as base, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyE2eRequest } from "./e2eGuardPolicy";

const PRIVY_CONFIG_BODY = readFileSync(fileURLToPath(new URL("./fixtures/privyAppConfig.json", import.meta.url)), "utf8");

export const test = base.extend<{ e2eGuard: { violations: string[] } }>({
  e2eGuard: [async ({ context }, use) => {
    const violations: string[] = [];
    if (process.env.PW_LIVE) return use({ violations }); // @live specs talk to the real Privy by design
    // WEBREG1: testnet builds now default REGISTRY_URL to the live Worker; mocked specs get the registry OFF unless they set
    // window.__e2eRegistryUrl themselves (spec init scripts run after this one and win).
    await context.addInitScript(() => { (window as any).__e2eRegistryUrl = ""; });
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      const v = classifyE2eRequest(url);
      if (v.kind === "passthrough") return route.fallback();
      if (v.kind === "privy-config") return route.fulfill({ status: 200, contentType: "application/json", body: PRIVY_CONFIG_BODY });
      if (v.kind === "stub") return route.fulfill({ status: v.status, contentType: v.contentType, body: v.body });
      violations.push(`${route.request().method()} ${url.slice(0, 200)}`);
      return route.abort("blockedbyclient");
    });
    await use({ violations });
    expect(violations, "unmocked request(s) escaped to the real network; add a page.route for them in the spec").toEqual([]);
  }, { auto: true }],
});
export { expect };
