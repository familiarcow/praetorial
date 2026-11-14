// GUEST1 (familiarcow 11-13): "Browse as guest" -- read-only browsing with no account. Pure (tsx --test, tests/guest1.unit.test.ts).
// The flag is per tab (sessionStorage): no wallet, no Privy call, no registry write. Signing in clears it; logging out never sets
// it (Log out returns to the login page, not to guest). Guests can look; every action still needs an account (lib/appState gate:
// a guest is "logged-out", so every login-rule action answers fix "login", which opens the login page on the same URL).
import type { Route } from "./router";

export const GUEST_KEY = "praetorial:guest";
export const GUEST_BANNER = "You're browsing as a guest. Log in to bet.";
/** The login page's line after a guest pressed an action (the URL is kept, so login lands back on the same page). */
export const LOGIN_TO_BET_LINE = "Log in to bet. You will come back to this page.";
export const BROWSE_AS_GUEST = "Browse as guest";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readGuest(s: Store | null | undefined): boolean {
  try { return s?.getItem(GUEST_KEY) === "1"; } catch { return false; }
}
export function writeGuest(s: Store | null | undefined, on: boolean): void {
  try { if (on) s?.setItem(GUEST_KEY, "1"); else s?.removeItem(GUEST_KEY); } catch { /* storage blocked: the in-memory flag still works */ }
}

/** The pages a guest can open: Home (open + recent bets), any bet, Docs, the AI guide (and not-found). /new and /account are actions. */
export function guestRoute(r: Route): boolean {
  return r.name === "home" || r.name === "bet" || r.name === "docs" || r.name === "guide" || r.name === "not-found";
}
