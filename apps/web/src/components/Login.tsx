import React, { useEffect, useReducer, useRef } from "react";
import { Button, TextField, Alert } from "../ui";
import { usePrivy, useLoginWithEmail } from "@privy-io/react-auth";
import { LOGIN_COPY } from "../../lib/loginCopy";
import { initialLogin, loginReducer, settleWithin, SEND_TIMEOUT_MS } from "../../lib/loginFlow";
import { Brand } from "./BrandMark";
import { BROWSE_AS_GUEST } from "../../lib/guest";

// LOGIN1 (UX-29): logged out, App renders ONLY this page (no nav, landing or site content, no overlay).
// Two steps, headless Privy email OTP (useLoginWithEmail): 1) email + "Send code", no code field;
// 2) after sendCode succeeded: "We sent a code to <email>", code field, Resend code, Use a different email.
// State/validation/error copy is pure in lib/loginFlow.ts (unit-tested). Once Privy reports `authenticated`,
// App swaps this page for the main app on the same URL (deep links land where they pointed).
// A1: `notice` = the one app-state Notice (paused / shut down / offline), shown INSIDE the card above the form (UIR1 §3.1), not at
// the top of a vertically centred page. Every Privy call is bounded by SEND_TIMEOUT_MS (lib/loginFlow settleWithin): "Sending…" /
// "Logging in…" can never hang without an error.
// GUEST1: `onGuest` = the secondary "Browse as guest" below the form: App sets the guest flag (sessionStorage) and nothing else -- no
// wallet, no Privy call, no registry write. The URL is kept, so a guest who was sent here by an action goes back to the same page.
export default function LoginPage({ line, notice, onGuest }: { line: string; notice?: React.ReactNode; onGuest?: () => void }) {
  const { ready } = usePrivy();
  const { sendCode, loginWithCode } = useLoginWithEmail();
  const [s, dispatch] = useReducer(loginReducer, initialLogin);

  useEffect(() => {
    if (s.cooldown <= 0) return;
    const t = setTimeout(() => dispatch({ type: "tick" }), 1000);
    return () => clearTimeout(t);
  }, [s.cooldown]);

  // Only the latest call may change the form (an answer that lands after its timeout, or after another press, is dropped).
  const attempt = useRef(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const doSend = async (to: string) => {
    const mine = ++attempt.current;
    const r = await settleWithin(sendCode({ email: to }), SEND_TIMEOUT_MS);
    if (!mounted.current || mine !== attempt.current) return;
    if (r.kind === "ok") dispatch({ type: "sent" });
    else if (r.kind === "error") dispatch({ type: "send-failed", error: r.error });
    else dispatch({ type: "send-timeout" });
  };
  // The reducer decides (validation, busy, cooldown); the Privy call only runs when the step it computed says so.
  const onSend = (e: React.FormEvent) => {
    e.preventDefault();
    const next = loginReducer(s, { type: "send" });
    dispatch({ type: "send" });
    if (next.busy && !s.busy) void doSend(s.email.trim());
  };
  const onResend = () => {
    const next = loginReducer(s, { type: "resend" });
    dispatch({ type: "resend" });
    if (next.busy && !s.busy && s.sentTo) void doSend(s.sentTo);
  };
  const onVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    const next = loginReducer(s, { type: "verify" });
    dispatch({ type: "verify" });
    if (!next.busy || s.busy) return;
    const mine = ++attempt.current;
    const r = await settleWithin(loginWithCode({ code: s.code.trim() }), SEND_TIMEOUT_MS);
    if (!mounted.current || mine !== attempt.current) return;
    // Success: Privy flips `authenticated` and App unmounts this page.
    if (r.kind === "error") dispatch({ type: "verify-failed", error: r.error });
    else if (r.kind === "timeout") dispatch({ type: "verify-timeout" });
  };

  return (
    <main data-testid="login-gate" className="login-page">
      <div className="login-card" data-testid="login-form" data-step={s.step}>
        <div className="login-brand"><Brand testId="login-brand" /></div>
        <p className="login-line" data-testid="login-line">{line}</p>
        {notice}
        {s.step === "email" ? (
          <form onSubmit={onSend} noValidate>
            <h1>{LOGIN_COPY.title}</h1>
            <TextField
              data-testid="email-input"
              label="Email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={s.email}
              disabled={s.busy}
              onChange={(e) => dispatch({ type: "email", value: e.currentTarget.value })}
            />
            <Button type="submit" variant="primary" data-testid="send-code" disabled={!ready || s.busy}>
              {s.busy ? "Sending…" : "Send code"}
            </Button>
          </form>
        ) : (
          <form onSubmit={onVerify} noValidate>
            <h1>{LOGIN_COPY.codeTitle}</h1>
            <p data-testid="code-sent">{LOGIN_COPY.codeSent(s.sentTo ?? "")}</p>
            <TextField
              data-testid="otp-input"
              label="6-digit code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={s.code}
              disabled={s.busy}
              onChange={(e) => dispatch({ type: "code", value: e.currentTarget.value })}
            />
            <Button type="submit" variant="primary" data-testid="submit-code" disabled={s.busy}>
              {s.busy ? "Logging in…" : "Log in"}
            </Button>
            <div className="login-secondary">
              <Button variant="ghost" data-testid="resend-code" disabled={s.busy || s.cooldown > 0} onClick={onResend}>
                {s.cooldown > 0 ? `Resend code (${s.cooldown}s)` : "Resend code"}
              </Button>
              <Button variant="ghost" data-testid="change-email" disabled={s.busy} onClick={() => dispatch({ type: "change-email" })}>
                Use a different email
              </Button>
            </div>
          </form>
        )}
        {s.error && <Alert data-testid="login-error">{s.error}</Alert>}
        {onGuest && (
          <div className="login-guest">
            <Button variant="secondary" data-testid="browse-as-guest" disabled={s.busy} onClick={onGuest}>{BROWSE_AS_GUEST}</Button>
          </div>
        )}
      </div>
    </main>
  );
}
