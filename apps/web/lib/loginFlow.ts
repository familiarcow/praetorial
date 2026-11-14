// LOGIN1 (UX-29): pure state for the full-page, two-step email login (src/components/LoginPage.tsx).
// Step 1 "email": email field + one button, NO code field. Step 2 "code" only after Privy's sendCode succeeded:
// "We sent a code to <email>", code field, Resend (after a cooldown) and Use a different email (back to step 1).
// No React / window so it runs under `tsx --test`. Errors are always plain sentences (lib/loginCopy).
import { RESEND_SECONDS, isValidCode, isValidEmail, otpErrorMessage, sendErrorMessage } from "./loginCopy";

export type LoginStep = "email" | "code";
export interface LoginState {
  step: LoginStep;
  email: string;
  /** The address the current code went to (set once sendCode succeeded). */
  sentTo: string | null;
  code: string;
  error: string | null;
  /** A sendCode / loginWithCode call is in flight. */
  busy: boolean;
  /** Seconds until "Resend code" is allowed again. */
  cooldown: number;
}

export type LoginAction =
  | { type: "email"; value: string }
  | { type: "code"; value: string }
  | { type: "send" } // step 1 submit
  | { type: "resend" } // step 2 "Resend code"
  | { type: "sent" } // sendCode resolved
  | { type: "send-failed"; error: unknown }
  | { type: "verify" } // step 2 submit
  | { type: "verify-failed"; error: unknown }
  | { type: "send-timeout" } // A1: sendCode did not answer within SEND_TIMEOUT_MS
  | { type: "verify-timeout" } // A1: loginWithCode did not answer within SEND_TIMEOUT_MS
  | { type: "change-email" }
  | { type: "tick" };

/** A1 (UIR1 §3.1): Privy's client retries an unanswered / 5xx send with backoff (measured: ~40 s with no answer, ~20 s on 503s), so
 *  "Sending…" looked hung. Each Privy call gets this long; then the form gives up with one plain sentence and a usable button. */
export const SEND_TIMEOUT_MS = 15_000;
export const SEND_TIMEOUT_TEXT = "We couldn't send the code. Try again.";
export const VERIFY_TIMEOUT_TEXT = "We couldn't check the code. Try again.";

export type Settled<T> = { kind: "ok"; value: T } | { kind: "error"; error: unknown } | { kind: "timeout" };
/** The promise's outcome, or "timeout" after `ms`. A late answer is dropped (and never an unhandled rejection). */
export function settleWithin<T>(p: Promise<T>, ms: number): Promise<Settled<T>> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ kind: "timeout" }), ms);
    p.then(
      (value) => { clearTimeout(t); resolve({ kind: "ok", value }); },
      (error) => { clearTimeout(t); resolve({ kind: "error", error }); },
    );
  });
}

export const initialLogin: LoginState = { step: "email", email: "", sentTo: null, code: "", error: null, busy: false, cooldown: 0 };

export function loginReducer(s: LoginState, a: LoginAction): LoginState {
  switch (a.type) {
    case "email": return { ...s, email: a.value, error: null };
    case "code": return { ...s, code: a.value, error: null };
    case "send":
      if (s.busy) return s;
      if (!isValidEmail(s.email)) return { ...s, error: "Enter a valid email address." };
      return { ...s, busy: true, error: null };
    case "resend":
      if (s.busy || s.cooldown > 0 || s.step !== "code") return s;
      return { ...s, busy: true, error: null };
    case "sent":
      return { ...s, step: "code", sentTo: s.sentTo ?? s.email.trim(), code: "", busy: false, error: null, cooldown: RESEND_SECONDS };
    case "send-failed": return { ...s, busy: false, error: sendErrorMessage(a.error) };
    case "verify":
      if (s.busy) return s;
      if (!isValidCode(s.code)) return { ...s, error: "Enter the 6-digit code from your email." };
      return { ...s, busy: true, error: null };
    case "verify-failed": return { ...s, busy: false, error: otpErrorMessage(a.error) };
    case "send-timeout": return s.busy ? { ...s, busy: false, error: SEND_TIMEOUT_TEXT } : s;
    case "verify-timeout": return s.busy ? { ...s, busy: false, error: VERIFY_TIMEOUT_TEXT } : s;
    case "change-email": return { ...initialLogin, email: s.sentTo ?? s.email };
    case "tick": return s.cooldown > 0 ? { ...s, cooldown: s.cooldown - 1 } : s;
  }
}
// REVIEW1 (SM1 AUTH-2) shellLogoutVisible moved to lib/shell.ts shellView().logout (A1: read from AppCtx).
