// A1 (SM2 gaps A1-1..3, spikes/sm2/STATES.md §4 A1): the app shell's decisions, read from the composed AppCtx (lib/appState) only.
// App.tsx renders these; it never decides from raw Privy `authenticated`, the wallet status string or `signedIn && nearAddress`.
// Pure (tsx --test, tests/shell.unit.test.ts).
import type { AppCtx, AuthState, Gate } from "./appState";

export const LOGGED_OUT_TOAST = "You were logged out.";

export interface ShellView {
  /** Logged out and not a guest: the app is only the login page (LOGIN1). */
  loginPage: boolean;
  /** GUEST1: logged out, browsing as a guest: the read-only shell (Home, bets, Docs, the guide); every action opens the login. */
  guest: boolean;
  /** Any signed-in state (setting up, failed, ready): the shell and Home render. */
  signedIn: boolean;
  /** The key is ready: Account and every action's own gate can run. */
  ready: boolean;
  /** "Setting up your account…" (the key, or the first username lookup). */
  settingUp: boolean;
  /** "We couldn't finish setting up your account." + Try again. */
  setupFailed: boolean;
  /** REGISTRY_DOWN_MESSAGE + Try again. */
  registryDown: boolean;
  /** The shell's own Log out (AUTH-2): whenever Account (which has one) can't be relied on yet. */
  logout: boolean;
  /** The "Pick a username" sheet may open (first login by itself; a bet action / the nav's Create on demand). */
  namePickable: boolean;
  /** The nav's Create bet and the /new route. held = /new shows the create GateNotice instead of the form; toFix = pressing it runs
   *  the username fix (Pick a username / Try again); toLogin = a guest: pressing it opens "Log in to bet" (GUEST1); disabled = any
   *  other refusal (paused, offline, checking…; the page notice says why). */
  create: { held: boolean; toFix: boolean; toLogin: boolean; disabled: boolean };
}

const NAME_CODES = new Set<Gate["code"]>(["no-username", "username-unknown", "checking-username"]);

export function shellView(c: AppCtx, createGate: Gate): ShellView {
  const signedIn = c.auth !== "logged-out";
  const ready = c.auth === "ready";
  const held = !createGate.allowed && NAME_CODES.has(createGate.code);
  const toFix = !createGate.allowed && (createGate.fix === "pick-username" || createGate.code === "username-unknown");
  const guest = !signedIn && !!c.guest;
  const toLogin = guest && !createGate.allowed && createGate.fix === "login";
  return {
    loginPage: !signedIn && !guest,
    guest,
    signedIn,
    ready,
    settingUp: c.auth === "setting-up" || (ready && c.account === "checking"),
    setupFailed: c.auth === "setup-failed",
    registryDown: ready && c.account === "unknown",
    logout: signedIn && (!ready || c.account === "checking"),
    namePickable: ready && c.account !== "has" && c.account !== "not-required",
    create: { held, toFix, toLogin, disabled: !createGate.allowed && !toFix && !toLogin },
  };
}

/** The session ended by itself (Privy flipped `authenticated`, the key went away), not by the user's Log out. */
export function sessionEnded(was: AuthState, now: AuthState, userLoggedOut: boolean): boolean {
  return was !== "logged-out" && now === "logged-out" && !userLoggedOut;
}
