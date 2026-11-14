// FE2 / S1: login copy and error states.
import test from "node:test";
import assert from "node:assert/strict";
import { LOGIN_COPY, otpErrorMessage, walletErrorMessage, isValidEmail, isValidCode, RESEND_SECONDS } from "../lib/loginCopy";

test("spec copy strings", () => {
  assert.equal(LOGIN_COPY.title, "Log in with your email");
  assert.equal(LOGIN_COPY.codeSent("a@b.co"), "We sent a code to a@b.co.");
  assert.equal(LOGIN_COPY.settingUp, "Setting up your account…");
});
test("OTP errors: wrong, expired, rate-limited, Privy down -> plain messages, never raw", () => {
  assert.equal(otpErrorMessage(new Error("Invalid code")), "That code didn't work. Try again or send a new one.");
  assert.equal(otpErrorMessage({ code: "invalid_credentials" }), "That code didn't work. Try again or send a new one.");
  assert.match(otpErrorMessage(new Error("Code expired")), /expired.*send a new one/i);
  assert.match(otpErrorMessage({ message: "too many requests", status: 429 }), /too many|wait/i);
  const down = otpErrorMessage(new TypeError("Failed to fetch"));
  assert.match(down, /can't reach the login service/i);
  assert.doesNotMatch(down, /fetch|TypeError/);
  assert.equal(otpErrorMessage(new Error("something odd")), "That code didn't work. Try again or send a new one.");
});
test("wallet failure never shows the raw string and offers retry copy", () => {
  assert.equal(walletErrorMessage("wallet-error: boom"), "We couldn't set up your account. Try again.");
  assert.equal(walletErrorMessage(undefined), "We couldn't set up your account. Try again.");
});
test("email format and 6-digit code validation; resend after 30s", () => {
  assert.ok(isValidEmail("a@b.co"));
  for (const e of ["", "a", "a@b", "a b@c.co", "@b.co"]) assert.equal(isValidEmail(e), false, e);
  assert.ok(isValidCode("123456"));
  for (const c of ["12345", "1234567", "12345a", ""]) assert.equal(isValidCode(c), false, c);
  assert.equal(RESEND_SECONDS, 30);
});
