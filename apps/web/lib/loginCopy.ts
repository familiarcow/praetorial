// FE2 / S1: login copy and error mapping. Raw Privy/RPC errors are never shown to the user.
export const RESEND_SECONDS = 30;
export const LOGIN_COPY = {
  title: "Log in with your email", // A1: headings carry no full stop
  codeTitle: "Check your email",
  codeSent: (email: string) => `We sent a code to ${email}.`,
  settingUp: "Setting up your account…",
};
const WRONG_CODE = "That code didn't work. Try again or send a new one.";

export const isValidEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
export const isValidCode = (c: string) => /^\d{6}$/.test(c.trim());

export function otpErrorMessage(err: unknown): string {
  const e = err as { message?: string; code?: string; status?: number } | null;
  const text = `${e?.code ?? ""} ${e?.message ?? ""}`.toLowerCase();
  if (e?.status === 429 || /too many|rate.?limit|429/.test(text)) return "Too many tries. Wait a minute, then try again.";
  if (/expired/.test(text)) return "That code has expired. Send a new one.";
  if (e instanceof TypeError || /failed to fetch|network|timeout|unavailable|50\d|load failed/.test(text)) return "We can't reach the login service right now. Check your connection and try again in a minute.";
  return WRONG_CODE;
}

/** LOGIN1: sendCode failures (step 1 / Resend). Rate limit and outage reuse the OTP wording; anything else is about the email. */
export function sendErrorMessage(err: unknown): string {
  const m = otpErrorMessage(err);
  return m === WRONG_CODE ? "We couldn't send a code to that email. Check it and try again." : m;
}

export function walletErrorMessage(_raw?: string): string {
  return "We couldn't set up your account. Try again.";
}
