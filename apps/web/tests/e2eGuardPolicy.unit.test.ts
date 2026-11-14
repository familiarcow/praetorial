// FE10e: the mocked e2e suites must never touch the real network. An unmocked request is classified here; the Playwright
// fixture (e2eGuard.ts) applies it. Root cause of the FE10d hangs: real Privy config fetch (auth.privy.io) gates __e2e.ready.
import test from "node:test";
import assert from "node:assert/strict";
import { classifyE2eRequest } from "./e2eGuardPolicy";

test("vite / localhost and inline schemes pass through", () => {
  for (const u of ["http://localhost:52522/new", "http://127.0.0.1:5173/src/main.tsx", "data:text/plain,x", "blob:http://localhost:1/abc"])
    assert.deepEqual(classifyE2eRequest(u), { kind: "passthrough" }, u);
});

test("Privy app config is served from the recorded fixture; other Privy/WalletConnect/Datadog chatter gets an inert stub", () => {
  assert.deepEqual(classifyE2eRequest("https://auth.privy.io/api/v1/apps/cmw1b5stc01q60glap4q18que"), { kind: "privy-config" });
  const a = classifyE2eRequest("https://auth.privy.io/api/v1/analytics_events");
  assert.equal(a.kind, "stub");
  const w = classifyE2eRequest("https://explorer-api.walletconnect.com/v3/wallets?projectId=x");
  assert.equal(w.kind, "stub");
  const d = classifyE2eRequest("https://csp-report.browser-intake-datadoghq.com/api/v2/logs?x=1");
  assert.equal(d.kind, "stub");
});

test("anything else off-box is a violation (never reaches the real network)", () => {
  for (const u of ["https://test.rpc.fastnear.com/", "https://1click.chaindefuser.com/v0/tokens", "http://localhost.evil.com/x", "https://example.com/"])
    assert.equal(classifyE2eRequest(u).kind, "violation", u);
});

test("TPL1: the exchanges' public market data (price-bet coin list + live price) gets an inert 503 unless a spec mocks it", () => {
  for (const u of ["https://api.exchange.coinbase.com/products", "https://api.coinbase.com/v2/prices/ZEC-USD/spot", "https://www.bitstamp.net/api/v2/trading-pairs-info/",
    "http://localhost:5173/_proxy/kraken/0/public/AssetPairs", "http://127.0.0.1:3000/_proxy/kraken/0/public/Ticker?pair=ZECUSD"]) {
    const v = classifyE2eRequest(u);
    assert.equal(v.kind, "stub", u);
    assert.equal((v as any).status, 503, u);
  }
  assert.deepEqual(classifyE2eRequest("http://localhost:5173/_proxy/indexer/bets"), { kind: "passthrough" });
});
