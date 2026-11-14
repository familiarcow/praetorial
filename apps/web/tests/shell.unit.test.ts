// A1 (SM2 gaps A1-1..3): every app-shell decision is read from the composed AppCtx (lib/appState), never from raw Privy / the wallet
// status string: the login page, routes, Log out, the setup notices, the create button and the first-login "Pick a username" sheet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appCtx, gate, type AppCtx } from "../lib/appState";
import { shellView, sessionEnded, LOGGED_OUT_TOAST } from "../lib/shell";

const v = (p: Partial<AppCtx>) => { const c = appCtx(p); return shellView(c, gate("create", c)); };

test("logged out: only the login page", () => {
  const s = v({ auth: "logged-out" });
  assert.deepEqual([s.loginPage, s.signedIn, s.ready, s.logout], [true, false, false, false]);
});

test("setting up / setup failed: the app shell with Log out always reachable (AUTH-2) and one notice", () => {
  const up = v({ auth: "setting-up" });
  assert.deepEqual([up.loginPage, up.signedIn, up.ready, up.logout, up.settingUp, up.setupFailed], [false, true, false, true, true, false]);
  const failed = v({ auth: "setup-failed" });
  assert.deepEqual([failed.logout, failed.setupFailed, failed.settingUp], [true, true, false]);
});

test("ready: Log out lives on Account, except while the username is still being checked", () => {
  assert.equal(v({ auth: "ready", account: "has" }).logout, false);
  assert.equal(v({ auth: "ready", account: "none" }).logout, false, "browsing is open, Account (with Log out) is reachable");
  const checking = v({ auth: "ready", account: "checking" });
  assert.deepEqual([checking.logout, checking.settingUp], [true, true]);
  assert.equal(v({ auth: "ready", account: "unknown" }).registryDown, true);
  assert.equal(v({ auth: "ready", account: "has" }).registryDown, false);
});

test("browsing stays open with no username (A1-2): the page renders; the sheet can be picked; create goes to the fix", () => {
  const none = v({ auth: "ready", account: "none" });
  assert.deepEqual([none.ready, none.namePickable], [true, true]);
  assert.deepEqual(none.create, { held: true, toFix: true, toLogin: false, disabled: false });
  assert.equal(v({ auth: "ready", account: "has" }).namePickable, false);
  assert.equal(v({ auth: "ready", account: "not-required" }).namePickable, false);
});

test("create button: checking holds (disabled, the form never flashes); unknown -> Try again; paused -> disabled; fine -> open", () => {
  assert.deepEqual(v({ auth: "ready", account: "checking" }).create, { held: true, toFix: false, toLogin: false, disabled: true });
  assert.deepEqual(v({ auth: "ready", account: "unknown" }).create, { held: true, toFix: true, toLogin: false, disabled: false });
  assert.deepEqual(v({ auth: "ready", account: "has", paused: true }).create, { held: false, toFix: false, toLogin: false, disabled: true });
  assert.deepEqual(v({ auth: "ready", account: "has" }).create, { held: false, toFix: false, toLogin: false, disabled: false });
});

test("session expiry (A1-3): a signed-in session that ends without Log out is 'You were logged out.'", () => {
  assert.equal(LOGGED_OUT_TOAST, "You were logged out.");
  assert.equal(sessionEnded("ready", "logged-out", false), true);
  assert.equal(sessionEnded("setting-up", "logged-out", false), true);
  assert.equal(sessionEnded("ready", "logged-out", true), false, "the user pressed Log out");
  assert.equal(sessionEnded("logged-out", "logged-out", false), false);
  assert.equal(sessionEnded("logged-out", "ready", false), false);
});
