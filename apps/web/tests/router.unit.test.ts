// FE1 / S0 + FE-1: pure route table for the app shell (no React, no window).
import test from "node:test";
import assert from "node:assert/strict";
import { matchRoute, routeRequiresLogin, legacyRedirect, betPath, loginPageLine } from "../lib/router";

// NAV1 (UX-31): the shell is Home / About / Wallet; /my-bets and /browse are Home sections, /judges is part of About.
// DOCS1: About is now Docs (/docs); /about redirects there (tests/docs1Routes.unit.test.ts has the full Docs route table).
test("matchRoute: the spec routes (NAV1: Home, Docs (DOCS1: was About), Account (F3: was Wallet), create, bet)", () => {
  assert.deepEqual(matchRoute("/"), { name: "home" });
  assert.deepEqual(matchRoute("/docs"), { name: "docs", page: "what" });
  assert.deepEqual(matchRoute("/account"), { name: "account" });
  assert.deepEqual(matchRoute("/new"), { name: "new" });
  assert.deepEqual(matchRoute("/bet/7"), { name: "bet", id: 7 });
});

test("NAV1: the old screens redirect into the sections (browse, my bets -> Home; judge models -> Docs, DOCS1)", () => {
  assert.equal(legacyRedirect("/browse", "", ""), "/");
  assert.equal(legacyRedirect("/my-bets", "", ""), "/");
  assert.equal(legacyRedirect("/judges", "", ""), "/docs/verification#models");
});

test("matchRoute: trailing slash is ignored; bad ids and unknown paths are not-found", () => {
  assert.deepEqual(matchRoute("/new/"), { name: "new" });
  assert.deepEqual(matchRoute("/bet/7/"), { name: "bet", id: 7 });
  for (const p of ["/bet/", "/bet/abc", "/bet/-1", "/bet/1.5", "/bet/7/extra", "/nope", "/bet/99999999999999999999"]) {
    assert.deepEqual(matchRoute(p), { name: "not-found" }, p);
  }
});

test("routeRequiresLogin (UX-29 / LOGIN1): logged out, every app route is behind the login page (TPL3 guide and DOCS1 Docs are the public exceptions)", () => {
  for (const r of [{ name: "home" }, { name: "account" }, { name: "new" }, { name: "bet", id: 7 }, { name: "not-found" }] as const) {
    assert.equal(routeRequiresLogin(r), true, r.name);
  }
  assert.equal(routeRequiresLogin({ name: "docs", page: "what" }), false);
});

test("loginPageLine: deep links say where the user goes after login; other routes get the brand line", () => {
  assert.equal(loginPageLine({ name: "bet", id: 7 }), "Log in to see bet #7. You will go straight to it.");
  assert.equal(loginPageLine({ name: "new" }), "Log in to make a bet. You will come back to this page.");
  assert.equal(loginPageLine({ name: "account" }), "Log in to open your account. You will come back to this page.");
  for (const r of [{ name: "home" }, { name: "docs", page: "what" }, { name: "not-found" }] as const) {
    assert.equal(loginPageLine(r), "Trustless AI Escrow", r.name);
  }
});

test("betPath builds /bet/:id", () => {
  assert.equal(betPath(7), "/bet/7");
});

test("legacyRedirect: old ?bet=N (and invite links) land on /bet/N, keeping the invite; #judge-models -> Docs' models (NAV1, DOCS1)", () => {
  assert.equal(legacyRedirect("/", "?bet=7", ""), "/bet/7");
  const sig = "ab".repeat(64);
  assert.equal(legacyRedirect("/", `?bet=7&invite=${sig}`, ""), `/bet/7?invite=${sig}`);
  assert.equal(legacyRedirect("/", "", "#judge-models"), "/docs/verification#models");
  assert.equal(legacyRedirect("/", "?bet=abc", ""), null);
  assert.equal(legacyRedirect("/new", "?bet=7", ""), null);
  assert.equal(legacyRedirect("/", "", ""), null);
});

test("FE2 + NAV1 + F3: /add-money and /wallet redirect to /account, which is login-gated", () => {
  assert.equal(legacyRedirect("/add-money", "", ""), "/account");
  assert.equal(legacyRedirect("/wallet", "", ""), "/account");
  assert.equal(routeRequiresLogin({ name: "account" }), true);
});

test("F3 (UX-37 #8): Settings folded into Account; old /settings links land there", () => {
  assert.equal(legacyRedirect("/settings", "", ""), "/account");
  assert.equal(legacyRedirect("/settings/", "", ""), "/account");
  assert.deepEqual(matchRoute("/settings"), { name: "not-found" }, "only reached through the redirect");
});
