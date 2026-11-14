// LOGIN1 (UX-29): the two-step email login. Step 1 is email only (no code field); step 2 appears only after
// Privy's sendCode succeeded and shows "We sent a code to <email>", the code field, Resend and Use a different email.
import test from "node:test";
import assert from "node:assert/strict";
import { initialLogin, loginReducer, type LoginState, type LoginAction } from "../lib/loginFlow";
import { RESEND_SECONDS } from "../lib/loginCopy";

const run = (actions: LoginAction[], s: LoginState = initialLogin) => actions.reduce(loginReducer, s);

test("starts on the email step: no code field, nothing sent, no error", () => {
  assert.equal(initialLogin.step, "email");
  assert.equal(initialLogin.sentTo, null);
  assert.equal(initialLogin.error, null);
  assert.equal(initialLogin.busy, false);
});

test("an invalid email stays on step 1 with a plain inline error and never starts a send", () => {
  const s = run([{ type: "email", value: "not-an-email" }, { type: "send" }]);
  assert.equal(s.step, "email");
  assert.equal(s.busy, false);
  assert.equal(s.error, "Enter a valid email address.");
});

test("a valid email starts the send (busy) but the code step only shows once sendCode succeeded", () => {
  const sending = run([{ type: "email", value: "  a@b.co " }, { type: "send" }]);
  assert.equal(sending.step, "email");
  assert.equal(sending.busy, true);
  assert.equal(sending.error, null);
  const sent = loginReducer(sending, { type: "sent" });
  assert.equal(sent.step, "code");
  assert.equal(sent.sentTo, "a@b.co");
  assert.equal(sent.busy, false);
  assert.equal(sent.cooldown, RESEND_SECONDS);
});

test("a failed send stays on step 1 with a plain message (never the raw Privy error)", () => {
  const s = run([{ type: "email", value: "a@b.co" }, { type: "send" }, { type: "send-failed", error: new TypeError("Failed to fetch") }]);
  assert.equal(s.step, "email");
  assert.equal(s.busy, false);
  assert.match(s.error!, /can't reach the login service/);
  const odd = run([{ type: "email", value: "a@b.co" }, { type: "send" }, { type: "send-failed", error: new Error("weird_privy_thing 400") }]);
  assert.equal(odd.error, "We couldn't send a code to that email. Check it and try again.");
  assert.doesNotMatch(odd.error!, /weird|400/);
});

const onCode = run([{ type: "email", value: "a@b.co" }, { type: "send" }, { type: "sent" }]);

test("step 2: a code that is not 6 digits gets an inline error and is not submitted", () => {
  const s = run([{ type: "code", value: "12a" }, { type: "verify" }], onCode);
  assert.equal(s.step, "code");
  assert.equal(s.busy, false);
  assert.equal(s.error, "Enter the 6-digit code from your email.");
});

test("step 2: wrong and expired codes show plain messages and stay on the code step", () => {
  const wrong = run([{ type: "code", value: "123456" }, { type: "verify" }, { type: "verify-failed", error: new Error("Invalid code") }], onCode);
  assert.equal(wrong.step, "code");
  assert.equal(wrong.error, "That code didn't work. Try again or send a new one.");
  const expired = run([{ type: "code", value: "123456" }, { type: "verify" }, { type: "verify-failed", error: new Error("Code expired") }], onCode);
  assert.match(expired.error!, /expired.*send a new one/i);
});

test("Resend is disabled during the cooldown, counts down, then re-sends to the same email", () => {
  assert.equal(loginReducer(onCode, { type: "resend" }), onCode, "no resend during cooldown");
  let s = onCode;
  for (let i = 0; i < RESEND_SECONDS; i++) s = loginReducer(s, { type: "tick" });
  assert.equal(s.cooldown, 0);
  assert.equal(loginReducer(s, { type: "tick" }).cooldown, 0, "never negative");
  const resending = loginReducer({ ...s, code: "111111", error: "x" }, { type: "resend" });
  assert.equal(resending.busy, true);
  assert.equal(resending.error, null);
  assert.equal(resending.step, "code");
  const again = loginReducer(resending, { type: "sent" });
  assert.equal(again.step, "code");
  assert.equal(again.sentTo, "a@b.co");
  assert.equal(again.code, "", "old code cleared");
  assert.equal(again.cooldown, RESEND_SECONDS);
});

test("Use a different email goes back to step 1 with the email kept for editing and the code cleared", () => {
  const s = run([{ type: "code", value: "123" }, { type: "change-email" }], onCode);
  assert.equal(s.step, "email");
  assert.equal(s.email, "a@b.co");
  assert.equal(s.code, "");
  assert.equal(s.sentTo, null);
  assert.equal(s.error, null);
  assert.equal(s.cooldown, 0);
});

test("editing a field clears the previous error", () => {
  const s = run([{ type: "email", value: "x" }, { type: "send" }, { type: "email", value: "x@" }]);
  assert.equal(s.error, null);
});

test("while busy, a second send/verify is ignored (no double submit)", () => {
  const sending = run([{ type: "email", value: "a@b.co" }, { type: "send" }]);
  assert.equal(loginReducer(sending, { type: "send" }), sending);
  const verifying = run([{ type: "code", value: "123456" }, { type: "verify" }], onCode);
  assert.equal(verifying.busy, true);
  assert.equal(loginReducer(verifying, { type: "verify" }), verifying);
});

// ---- A1: a send / verify that never answers can't leave the form busy (UIR1 §3.1: "Sending…" hung ~40 s, a 503 ~20 s).
import { SEND_TIMEOUT_MS, SEND_TIMEOUT_TEXT, VERIFY_TIMEOUT_TEXT, settleWithin } from "../lib/loginFlow";

test("A1: settleWithin answers ok / error / timeout, whichever comes first", async () => {
  assert.equal(SEND_TIMEOUT_MS, 15_000);
  assert.deepEqual(await settleWithin(Promise.resolve(7), 50), { kind: "ok", value: 7 });
  const e = new Error("x");
  assert.deepEqual(await settleWithin(Promise.reject(e), 50), { kind: "error", error: e });
  assert.deepEqual(await settleWithin(new Promise(() => {}), 20), { kind: "timeout" });
  // late answers after the timeout are ignored (no unhandled rejection either)
  assert.deepEqual(await settleWithin(new Promise((_, rej) => setTimeout(() => rej(new Error("late")), 40)), 10), { kind: "timeout" });
});

test("A1: send-timeout / verify-timeout clear busy with one plain sentence and keep the step", () => {
  const sending = run([{ type: "email", value: "a@b.co" }, { type: "send" }]);
  assert.equal(sending.busy, true);
  const t = loginReducer(sending, { type: "send-timeout" });
  assert.deepEqual([t.busy, t.step, t.error], [false, "email", SEND_TIMEOUT_TEXT]);
  assert.equal(SEND_TIMEOUT_TEXT, "We couldn't send the code. Try again.");
  const onCode = run([{ type: "email", value: "a@b.co" }, { type: "send" }, { type: "sent" }, { type: "code", value: "123456" }, { type: "verify" }]);
  const v = loginReducer(onCode, { type: "verify-timeout" });
  assert.deepEqual([v.busy, v.step, v.error, v.code], [false, "code", VERIFY_TIMEOUT_TEXT, "123456"]);
  // a timeout that arrives when nothing is in flight changes nothing
  assert.equal(loginReducer(t, { type: "send-timeout" }), t);
});
