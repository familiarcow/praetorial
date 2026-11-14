// GUEST1 (familiarcow 11-13): "Browse as guest" -- read-only browsing with no account. Guests can look; every action still needs an account.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appCtx, gate, ACTIONS, ACTION_RULES, type AppCtx } from "../lib/appState";
import { shellView } from "../lib/shell";
import { GUEST_KEY, GUEST_BANNER, LOGIN_TO_BET_LINE, readGuest, writeGuest, guestRoute } from "../lib/guest";
import { matchRoute } from "../lib/router";
import { guestRequestViolation } from "./lib/guestFetchPolicy";

const v = (p: Partial<AppCtx>) => { const c = appCtx(p); return shellView(c, gate("create", c)); };

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, x: string) => void m.set(k, x), removeItem: (k: string) => void m.delete(k), m };
}

test("the guest flag lives in sessionStorage under one key; on/off round-trips; blocked storage = not a guest", () => {
  const s = memStorage();
  assert.equal(readGuest(s), false);
  writeGuest(s, true);
  assert.equal(s.m.get(GUEST_KEY), "1");
  assert.equal(readGuest(s), true);
  writeGuest(s, false);
  assert.equal(s.m.has(GUEST_KEY), false);
  assert.equal(readGuest(s), false);
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  assert.equal(readGuest(blocked), false);
  assert.doesNotThrow(() => writeGuest(blocked, true));
  assert.equal(readGuest(null), false);
});

test("copy: the banner and the action prompt", () => {
  assert.equal(GUEST_BANNER, "You're browsing as a guest. Log in to bet.");
  assert.match(LOGIN_TO_BET_LINE, /^Log in to bet\./);
});

test("shell: logged out without the flag is still ONLY the login page (LOGIN1 unchanged)", () => {
  const s = v({ auth: "logged-out" });
  assert.deepEqual([s.loginPage, s.guest, s.signedIn], [true, false, false]);
});

test("shell: a guest gets the app shell, read-only: not signed in, not ready, no Log out, no username sheet", () => {
  const g = v({ auth: "logged-out", guest: true });
  assert.deepEqual([g.loginPage, g.guest, g.signedIn, g.ready, g.logout, g.namePickable], [false, true, false, false, false, false]);
  // Create is shown and pressable, and it goes to the login (never the form).
  assert.deepEqual(g.create, { held: false, toFix: false, toLogin: true, disabled: false });
});

test("the guest flag means nothing once signed in (a signed-in user is never a guest)", () => {
  for (const auth of ["setting-up", "setup-failed", "ready"] as const) {
    const s = v({ auth, account: "has", guest: true });
    assert.equal(s.guest, false, auth);
    assert.equal(s.create.toLogin, false, auth);
    assert.equal(appCtx({ auth, guest: true }).guest, false, auth);
  }
});

test("every action that needs an account is refused for a guest with the login fix; only looking is open", () => {
  const c = appCtx({ auth: "logged-out", guest: true });
  for (const a of ACTIONS) {
    const g = gate(a, c);
    if (ACTION_RULES[a].login) assert.deepEqual([g.allowed, g.code, g.fix], [false, "login", "login"], a);
  }
  for (const a of ["browse", "view-bet", "share", "verify"] as const) assert.equal(gate(a, c).allowed, true, a);
});

test("routes a guest may see: Home, any bet, Docs, the AI guide (and not-found); /new and /account need the login", () => {
  for (const p of ["/", "/bet/7", "/docs", "/docs/verification", "/guide/custom-bet", "/nope"]) assert.equal(guestRoute(matchRoute(p)), true, p);
  for (const p of ["/new", "/account"]) assert.equal(guestRoute(matchRoute(p)), false, p);
});

// ---------------------------------------------------------------- the fetch policy the guest e2e spec enforces
const RPC = "https://test.rpc.fastnear.com";
const cfg = { rpcUrl: RPC, relayerUrl: "http://localhost:8788", registryUrl: "http://names.e2e.test", sourceCheckUrl: "http://localhost:8790/sourcecheck" };
const rpcBody = (method: string, params: unknown = {}) => JSON.stringify({ jsonrpc: "2.0", id: "1", method, params });

test("guest fetch policy: public reads pass", () => {
  assert.equal(guestRequestViolation({ method: "GET", url: "http://localhost:8787/offers" }, cfg), null);
  assert.equal(guestRequestViolation({ method: "GET", url: "http://names.e2e.test/lookup/account/a.testnet" }, cfg), null);
  assert.equal(guestRequestViolation({ method: "GET", url: "https://1click.chaindefuser.com/v0/tokens" }, cfg), null);
  assert.equal(guestRequestViolation({ method: "POST", url: RPC, body: rpcBody("query", { request_type: "call_function", method_name: "get_bet" }) }, cfg), null);
  assert.equal(guestRequestViolation({ method: "POST", url: RPC + "/", body: rpcBody("block", { finality: "final" }) }, cfg), null);
  assert.equal(guestRequestViolation({ method: "POST", url: RPC, body: rpcBody("query", { request_type: "view_account" }) }, cfg), null);
  // the Privy SDK's start-up ping (every visitor's page load, before any guest code) is the one allowed Privy POST
  assert.equal(guestRequestViolation({ method: "POST", url: "https://auth.privy.io/api/v1/analytics_events", body: JSON.stringify({ event_name: "sdk_initialize" }) }, cfg), null);
});

test("guest fetch policy: any write, signer, relayer, funding, registry write or paid check fails", () => {
  const bad: Array<{ method: string; url: string; body?: string }> = [
    { method: "POST", url: RPC, body: rpcBody("broadcast_tx_commit", ["x"]) },
    { method: "POST", url: RPC, body: rpcBody("send_tx", { signed_tx_base64: "x" }) },
    { method: "POST", url: RPC, body: "not json" },
    { method: "POST", url: "http://localhost:8788/relay", body: "{}" },
    { method: "GET", url: "http://localhost:8788/relay/status?x=1" },
    { method: "POST", url: "http://names.e2e.test/claim", body: "{}" },
    { method: "GET", url: "http://names.e2e.test/claim" },
    { method: "POST", url: "http://localhost:8788/activate", body: "{}" },
    { method: "POST", url: "http://localhost:8788/faucet", body: "{}" },
    { method: "POST", url: "https://bridge.chaindefuser.com/rpc", body: "{}" },
    { method: "GET", url: "https://bridge.chaindefuser.com/rpc" },
    { method: "POST", url: "https://1click.chaindefuser.com/v0/quote", body: "{}" },
    { method: "POST", url: "http://localhost:8790/sourcecheck", body: "{}" },
    { method: "POST", url: "https://auth.privy.io/api/v1/passwordless/init", body: "{}" },
    { method: "POST", url: "https://auth.privy.io/api/v1/analytics_events", body: JSON.stringify({ event_name: "login_started" }) },
    { method: "POST", url: "https://auth.privy.io/api/v1/embedded_wallets", body: "{}" },
    { method: "PUT", url: "http://localhost:8787/offers" },
    { method: "DELETE", url: "http://names.e2e.test/lookup/account/a" },
  ];
  for (const r of bad) assert.notEqual(guestRequestViolation(r, cfg), null, `${r.method} ${r.url} ${r.body ?? ""}`);
});
