// SM2: the cross-machine gate (lib/appState.ts) for every user action x every app state. Table-driven: one row per
// (state, action) expectation; the STATES.md §Rules tables are written from the same table (ACTION_RULES).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gate, identityOf, ACTIONS, ACTION_RULES, accountStateOf, authStateOf, appCtx, GATE_COPY, NO_USERNAME,
  type AppCtx, type UserAction, type Fix,
} from "../lib/appState";

const READY: AppCtx = appCtx({ auth: "ready", account: "has", offline: false, viewFailed: false, outOfDate: false, paused: false, shutdown: false });
const W = (p: Partial<AppCtx>): AppCtx => ({ ...READY, ...p });

const BET_NEW: UserAction[] = ["create", "take"];
const NEEDS_NAME_STRICT: UserAction[] = ["create", "take", "be-referee", "change-referee"];
const NEEDS_NAME_KNOWN: UserAction[] = ["challenge", "add-evidence", "rule"];
const NO_NAME: UserAction[] = ["request-result", "finalize", "concede", "retry-payout", "cancel", "refund-all", "add-money", "cash-out", "convert", "move-to-betting"];
const OPEN: UserAction[] = ["browse", "view-bet", "share", "verify"];
const SHUTDOWN_OK: UserAction[] = ["cancel", "retry-payout", "refund-all", "cash-out", "convert", ...OPEN, "login", "logout", "pick-username"];

test("every action has a rule row and the lists above cover them all", () => {
  for (const a of ACTIONS) assert.ok(ACTION_RULES[a], `no rule for ${a}`);
  const covered = new Set([...BET_NEW, ...NEEDS_NAME_STRICT, ...NEEDS_NAME_KNOWN, ...NO_NAME, ...OPEN, "duplicate", "login", "logout", "pick-username"]);
  for (const a of ACTIONS) assert.ok(covered.has(a), `action ${a} not covered by this test's tables`);
});

test("ready user: every action is allowed, no reason, no fix", () => {
  for (const a of ACTIONS) {
    const g = gate(a, READY);
    if (a === "login" || a === "pick-username") continue; // pointless when already logged in / named; checked below
    assert.deepEqual([a, g.allowed, g.reason, g.fix], [a, true, null, null]);
  }
});

type Row = [string, Partial<AppCtx>, UserAction[], { allowed: boolean; fix: Fix; code: string }];
const rows: Row[] = [
  // ---- browsing is always open
  ...(["logged-out", "setting-up", "setup-failed"] as const).map((auth): Row => [`browse while ${auth}`, { auth }, OPEN, { allowed: true, fix: null, code: "ok" }]),
  ["browse offline", { offline: true }, OPEN, { allowed: true, fix: null, code: "ok" }],
  ["browse shut down", { shutdown: true }, OPEN, { allowed: true, fix: null, code: "ok" }],
  ["browse without a username", { account: "none" }, OPEN, { allowed: true, fix: null, code: "ok" }],
  // ---- 1. session
  ["logged out", { auth: "logged-out", account: "not-checked" }, [...BET_NEW, ...NEEDS_NAME_KNOWN, ...NO_NAME, "be-referee", "change-referee", "duplicate", "pick-username"], { allowed: false, fix: "login", code: "login" }],
  ["account being set up", { auth: "setting-up", account: "not-checked" }, [...BET_NEW, ...NO_NAME], { allowed: false, fix: null, code: "setting-up" }],
  ["account setup failed", { auth: "setup-failed", account: "not-checked" }, [...BET_NEW, ...NO_NAME], { allowed: false, fix: "retry", code: "setup-failed" }],
  // ---- 2. connectivity / stale data (money actions only)
  ["offline", { offline: true }, [...BET_NEW, ...NEEDS_NAME_KNOWN, ...NO_NAME], { allowed: false, fix: "retry", code: "offline" }],
  ["out of date", { outOfDate: true }, [...BET_NEW, ...NO_NAME], { allowed: false, fix: "retry", code: "out-of-date" }],
  ["reads failing", { viewFailed: true }, [...BET_NEW, ...NO_NAME], { allowed: false, fix: "retry", code: "stale" }],
  // ---- 3. contract
  ["shut down: new bets", { shutdown: true, paused: true }, BET_NEW, { allowed: false, fix: null, code: "shutdown" }],
  ["shut down: live-bet actions the contract refuses", { shutdown: true, paused: true }, ["challenge", "add-evidence", "rule", "request-result", "finalize", "concede", "change-referee", "be-referee", "add-money", "move-to-betting"], { allowed: false, fix: null, code: "shutdown" }],
  ["shut down: refunds and cash out stay open", { shutdown: true, paused: true }, ["cancel", "retry-payout", "refund-all", "cash-out", "convert"], { allowed: true, fix: null, code: "ok" }],
  ["paused: new bets only", { paused: true }, BET_NEW, { allowed: false, fix: null, code: "paused" }],
  ["paused: live bets carry on", { paused: true }, [...NEEDS_NAME_KNOWN, ...NO_NAME.filter((a) => a !== "refund-all"), "be-referee", "change-referee"], { allowed: true, fix: null, code: "ok" }],
  ["not shut down: emergency refund is not offered", {}, ["refund-all"], { allowed: true, fix: null, code: "ok" }],
  // ---- 4. Praetorial account (username)
  ["no username: bet actions need one", { account: "none" }, [...NEEDS_NAME_STRICT, ...NEEDS_NAME_KNOWN], { allowed: false, fix: "pick-username", code: "no-username" }],
  ["no username: money of your own never waits on a name", { account: "none" }, NO_NAME, { allowed: true, fix: null, code: "ok" }],
  ["username lookup running", { account: "checking" }, NEEDS_NAME_STRICT, { allowed: false, fix: null, code: "checking-username" }],
  ["username lookup running: deadline actions are not held", { account: "checking" }, NEEDS_NAME_KNOWN, { allowed: true, fix: null, code: "ok" }],
  ["username service down: new bets wait", { account: "unknown" }, NEEDS_NAME_STRICT, { allowed: false, fix: "retry", code: "username-unknown" }],
  ["username service down: deadline actions are not held", { account: "unknown" }, NEEDS_NAME_KNOWN, { allowed: true, fix: null, code: "ok" }],
  ["no registry configured (dev): no username gate", { account: "not-required" }, [...NEEDS_NAME_STRICT, ...NEEDS_NAME_KNOWN], { allowed: true, fix: null, code: "ok" }],
  // ---- 5. funds
  ["short of the token: add money keeps the draft", { short: { sentence: "You need 2.00 USDC more in your betting balance to do this.", path: "/add-money?asset=USDC&need=2" } }, ["create", "take", "challenge"], { allowed: false, fix: "add-money", code: "short" }],
  ["short does not gate actions that pay nothing in", { short: { sentence: "x", path: "/add-money" } }, ["finalize", "concede", "cancel", "cash-out", "rule"], { allowed: true, fix: null, code: "ok" }],
];

for (const [name, p, actions, want] of rows) {
  test(`gate: ${name}`, () => {
    for (const a of actions) {
      const g = gate(a, W(p));
      assert.deepEqual({ a, allowed: g.allowed, fix: g.fix, code: g.code }, { a, ...want });
      if (!g.allowed) assert.ok(g.reason && g.reason.length > 10 && /[.?…]$/.test(g.reason), `${a}: plain sentence reason, got ${g.reason}`);
      else assert.equal(g.reason, null);
    }
  });
}

test("priority: login > setting up > offline/stale > shutdown > paused > username > funds", () => {
  const all: Partial<AppCtx> = { auth: "logged-out", offline: true, shutdown: true, paused: true, account: "none", short: { sentence: "s.", path: "/add-money" } };
  const order: [Partial<AppCtx>, string][] = [
    [{}, "login"],
    [{ auth: "ready" }, "offline"],
    [{ auth: "ready", offline: false }, "shutdown"],
    [{ auth: "ready", offline: false, shutdown: false }, "paused"],
    [{ auth: "ready", offline: false, shutdown: false, paused: false }, "no-username"],
    [{ auth: "ready", offline: false, shutdown: false, paused: false, account: "has" }, "short"],
  ];
  for (const [delta, code] of order) assert.equal(gate("take", W({ ...all, ...delta })).code, code);
});

test("reason text comes from GATE_COPY (one sentence per code, screens never write their own)", () => {
  assert.equal(gate("create", W({ account: "none" })).reason, GATE_COPY["no-username"]);
  assert.equal(gate("take", W({ paused: true })).reason, GATE_COPY.paused);
  assert.equal(gate("take", W({ auth: "logged-out" })).reason, GATE_COPY.login);
  const s = "You need 2.00 USDC more in your betting balance to do this.";
  assert.equal(gate("take", W({ short: { sentence: s, path: "/add-money" } })).reason, s);
  assert.equal(gate("take", W({ short: { sentence: s, path: "/add-money" } })).addMoneyPath, "/add-money");
  assert.match(GATE_COPY["no-username"], /username/i);
});

test("pick-username: offered only to a logged-in user without one", () => {
  assert.equal(gate("pick-username", W({ account: "none" })).allowed, true);
  assert.equal(gate("pick-username", W({ account: "has" })).allowed, false);
  assert.equal(gate("pick-username", W({ auth: "logged-out", account: "not-checked" })).fix, "login");
});

test("login / logout", () => {
  assert.equal(gate("login", W({ auth: "logged-out", account: "not-checked" })).allowed, true);
  assert.equal(gate("login", READY).allowed, false);
  for (const auth of ["setting-up", "setup-failed", "ready"] as const) assert.equal(gate("logout", W({ auth })).allowed, true, auth);
  assert.equal(gate("logout", W({ auth: "logged-out" })).allowed, false);
});

test("accountStateOf maps App's username lookup states", () => {
  assert.equal(accountStateOf("off", true), "not-required");
  assert.equal(accountStateOf("off", false), "not-checked");
  assert.equal(accountStateOf("checking", false), "checking");
  assert.equal(accountStateOf("has", false), "has");
  assert.equal(accountStateOf("none", false), "none");
  assert.equal(accountStateOf("skipped", false), "none"); // Skip for now leaves the user without a name: same gate
  assert.equal(accountStateOf("down", false), "unknown");
});

test("authStateOf", () => {
  assert.equal(authStateOf({ signedIn: false, address: null, status: "init" }), "logged-out");
  assert.equal(authStateOf({ signedIn: true, address: null, status: "creating-wallet" }), "setting-up");
  assert.equal(authStateOf({ signedIn: true, address: null, status: "wallet-error: x" }), "setup-failed");
  assert.equal(authStateOf({ signedIn: true, address: "ab".repeat(32), status: "wallet-ready" }), "ready");
});

test("appCtx: shutdown implies paused; defaults are the safe ones", () => {
  assert.equal(appCtx({ ...READY, paused: false, shutdown: true }).paused, true);
  assert.equal(appCtx({}).auth, "logged-out");
});

test("identityOf: people are @username, You, or 'Unnamed account'; never a raw id", () => {
  const me = "ab".repeat(32);
  const hex = "a1b2" + "0".repeat(56) + "f9e0";
  assert.deepEqual(identityOf({ account: "bob.near", username: "bob", me }), { account: "bob.near", username: "bob", isMe: false, label: "@bob", named: true });
  assert.equal(identityOf({ account: me, username: "familiarcow", me }).label, "You");
  assert.equal(identityOf({ account: me, username: "familiarcow", me, selfAsName: true }).label, "@familiarcow");
  for (const acct of [hex, "judge.near", "a-very-long-named-account-id-here.near"]) {
    const p = identityOf({ account: acct, username: null, me });
    assert.equal(p.label, NO_USERNAME);
    assert.equal(p.named, false);
    assert.ok(!p.label.includes(".near") && !/[0-9a-f]{4}/.test(p.label));
  }
  assert.equal(identityOf({ account: hex, username: "@Alice", me: null }).label, "@alice");
});
