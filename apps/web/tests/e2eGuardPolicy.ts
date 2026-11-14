// FE10e: classification of requests that no spec-level page.route handled (pure; unit-tested without a browser).
export type E2eVerdict =
  | { kind: "passthrough" }
  | { kind: "privy-config" }
  | { kind: "stub"; status: number; contentType: string; body: string }
  | { kind: "violation" };

const MARKET_HOSTS = ["api.exchange.coinbase.com", "api.coinbase.com", "www.bitstamp.net"];
const LOCAL = ["localhost", "127.0.0.1", "[::1]"];
const PRIVY_CONFIG =/^\/api\/v1\/apps\/[A-Za-z0-9]+$/;
const json = (body: string): E2eVerdict => ({ kind: "stub", status: 200, contentType: "application/json", body });

export function classifyE2eRequest(url: string): E2eVerdict {
  let u: URL;
  try { u = new URL(url); } catch { return { kind: "violation" }; }
  if (u.protocol === "data:" || u.protocol === "blob:") return { kind: "passthrough" };
  // TPL1: the price-bet coin list / live price (exchanges' public market data; Kraken via the web worker's /_proxy/kraken). Inert 503
  // unless a spec mocks it: the form falls back to its built-in coin list and shows no price, never a real network call.
  if (MARKET_HOSTS.includes(u.hostname) || (LOCAL.includes(u.hostname) && u.pathname.startsWith("/_proxy/kraken/"))) return { kind: "stub", status: 503, contentType: "text/plain", body: "" };
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]") return { kind: "passthrough" };
  if (u.hostname === "auth.privy.io") return PRIVY_CONFIG.test(u.pathname) && !u.search ? { kind: "privy-config" } : json("{}");
  if (u.hostname === "explorer-api.walletconnect.com") return json(JSON.stringify({ count: 0, listings: {} }));
  if (u.hostname === "csp-report.browser-intake-datadoghq.com") return { kind: "stub", status: 204, contentType: "text/plain", body: "" };
  return { kind: "violation" };
}
