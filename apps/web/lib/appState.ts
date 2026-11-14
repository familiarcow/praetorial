// SM2: THE cross-machine gate. Every user action asks gate(action, ctx) whether it may run now, and gets back the ONE reason
// (a plain sentence from GATE_COPY) and the ONE fix (login / pick-username / add-money / retry / none). Screens never combine
// Privy, the username registry, the contract's paused/shutdown flags, connectivity or the balance themselves; they read this.
// Bet-phase eligibility (is a challenge open, is it my turn) stays in lib/betView.ts / lib/betLifecycle.ts / lib/takeView.ts:
// an action is offered when betView offers it AND gate() allows it. Rules and priority: spikes/sm2/STATES.md §Rules.
// Pure (no React / window) so it runs under `tsx --test` (tests/appState.unit.test.ts).

// ---------------------------------------------------------------- the machines this composes
/** Session: Privy login + the NEAR key/wallet behind it (App.tsx wallet effect). */
export type AuthState = "logged-out" | "setting-up" | "setup-failed" | "ready";
/** Praetorial account = a claimed @username in the registry (App.tsx username lookup). */
export type AccountState =
  | "not-checked" // logged out / no key yet
  | "not-required" // no registry configured (dev/tests only): nothing to claim against
  | "checking"
  | "none" // looked up: no username (incl. "Skip for now")
  | "has"
  | "unknown"; // the registry did not answer

export interface Short { sentence: string; path: string }

export interface AppCtx {
  auth: AuthState;
  account: AccountState;
  offline: boolean;
  /** A read failed and is being retried (lib/liveState). */
  viewFailed: boolean;
  /** Wrong network or another release (globalStates.outOfDateReason). */
  outOfDate: boolean;
  /** Contract: new offers paused. Shutdown implies paused. */
  paused: boolean;
  shutdown: boolean;
  /** F3 (SM2 gap F3-1): the user's claimed username (no "@"), or null. Account and the nav read it here, never the registry. */
  username?: string | null;
  /** GUEST1: browsing as a guest (read-only, no account). Only meaningful while logged out; appCtx drops it otherwise. */
  guest?: boolean;
  /** Set by the caller for ONE action: the betting balance does not cover what this action pays in (lib/fundingGate fundingShort). */
  short?: Short | null;
}

/** Normalises a context (shutdown implies paused; missing fields default to the safe value). */
export function appCtx(p: Partial<AppCtx>): AppCtx {
  const shutdown = !!p.shutdown;
  return {
    auth: p.auth ?? "logged-out",
    account: p.account ?? "not-checked",
    offline: !!p.offline,
    viewFailed: !!p.viewFailed,
    outOfDate: !!p.outOfDate,
    paused: !!p.paused || shutdown,
    shutdown,
    short: p.short ?? null,
    username: p.username ?? null,
    guest: !!p.guest && (p.auth ?? "logged-out") === "logged-out",
  };
}

/** App.tsx wallet status string ("init" | "creating-wallet" | "wallet-ready" | "wallet-error: ...") -> AuthState. */
export function authStateOf(s: { signedIn: boolean; address: string | null; status: string }): AuthState {
  if (!s.signedIn) return "logged-out";
  if (s.status.startsWith("wallet-error")) return "setup-failed";
  return s.address ? "ready" : "setting-up";
}

/** App.tsx username lookup state -> AccountState. `noRegistry` = no registry URL configured. */
export function accountStateOf(nameState: "off" | "checking" | "has" | "none" | "down" | "skipped", noRegistry: boolean): AccountState {
  switch (nameState) {
    case "off": return noRegistry ? "not-required" : "not-checked";
    case "checking": return "checking";
    case "has": return "has";
    case "none": case "skipped": return "none";
    case "down": return "unknown";
  }
}

// ---------------------------------------------------------------- actions
export const ACTIONS = [
  // open to everyone
  "browse", "view-bet", "share", "verify",
  // session / account
  "login", "logout", "pick-username",
  // new bets
  "create", "take", "duplicate",
  // live bets
  "be-referee", "change-referee", "rule", "challenge", "add-evidence", "request-result", "finalize", "concede",
  // money back
  "cancel", "retry-payout", "refund-all",
  // the user's own balance
  "add-money", "cash-out", "convert", "move-to-betting",
] as const;
export type UserAction = (typeof ACTIONS)[number];

/** How a username is required: "always" (also waits while unknown), "known-none" (blocked only when we KNOW there is none:
 *  deadline-bound actions are never held by a registry outage), "no". */
type NameRule = "always" | "known-none" | "no";
/** Which contract state the action needs: "new" = not paused (Open/Take), "live" = not shut down, "any" = also after shutdown,
 *  "funding" = not shut down (adding money to bet with is pointless once nothing can be bet), "none" = no contract call. */
type ContractRule = "new" | "live" | "any" | "funding" | "none";
export interface ActionRule { login: boolean; name: NameRule; contract: ContractRule; fresh: boolean; paysIn: boolean }

const R = (login: boolean, name: NameRule, contract: ContractRule, fresh: boolean, paysIn = false): ActionRule => ({ login, name, contract, fresh, paysIn });
// Mirrors contracts/escrow/src/lib.rs: new_offers_paused refuses only Open (handle_open) and Take (handle_take); shutdown refuses
// bond/objection/request_resolution/referee_rule/amend_referee/amend/finalize/concede, leaves cancel, retry_payout, drain and
// emergency_refund open.
export const ACTION_RULES: Record<UserAction, ActionRule> = {
  browse: R(false, "no", "none", false),
  "view-bet": R(false, "no", "none", false),
  share: R(false, "no", "none", false),
  verify: R(false, "no", "none", false),
  login: R(false, "no", "none", false),
  logout: R(false, "no", "none", false),
  "pick-username": R(true, "no", "none", false),
  create: R(true, "always", "new", true, true),
  take: R(true, "always", "new", true, true),
  duplicate: R(true, "no", "none", false), // copies terms into the create form; Open is gated there
  "be-referee": R(true, "always", "live", true),
  "change-referee": R(true, "always", "live", true),
  rule: R(true, "known-none", "live", true),
  challenge: R(true, "known-none", "live", true, true),
  "add-evidence": R(true, "known-none", "live", true),
  "request-result": R(true, "no", "live", true),
  finalize: R(true, "no", "live", true),
  concede: R(true, "no", "live", true),
  cancel: R(true, "no", "any", true),
  "retry-payout": R(true, "no", "any", true),
  "refund-all": R(true, "no", "any", true),
  "add-money": R(true, "no", "funding", true),
  "move-to-betting": R(true, "no", "funding", true),
  "cash-out": R(true, "no", "none", true),
  convert: R(true, "no", "none", true),
};

// ---------------------------------------------------------------- the gate
export type Fix = "login" | "pick-username" | "add-money" | "retry" | null;
export type GateCode =
  | "ok" | "login" | "setting-up" | "setup-failed" | "offline" | "out-of-date" | "stale" | "shutdown" | "paused"
  | "checking-username" | "no-username" | "username-unknown" | "short" | "already-logged-in" | "already-named" | "not-logged-in";
export interface Gate { allowed: boolean; code: GateCode; reason: string | null; fix: Fix; addMoneyPath?: string }

export const GATE_COPY: Record<Exclude<GateCode, "ok" | "short">, string> = {
  login: "Log in to do this.",
  "setting-up": "Your account is still being set up. This takes a few seconds.",
  "setup-failed": "We couldn't finish setting up your account. Try again.",
  offline: "You're offline. Reconnect and try again.",
  "out-of-date": "This page is out of date. Refresh to continue.",
  stale: "We can't load the latest numbers right now, so this is paused until they load. Retrying.",
  shutdown: "Praetorial is shut down. You can only get your money back now.",
  paused: "New bets are paused right now. Bets that are already live carry on.",
  "checking-username": "Checking your username…",
  "no-username": "Pick a username first. On Praetorial people bet with each other by username.",
  "username-unknown": "We can't check your username right now. Try again in a moment.",
  "already-logged-in": "You're already logged in.",
  "already-named": "You already have a username. You can change it in Account.",
  "not-logged-in": "You're not logged in.",
};

const OK: Gate = { allowed: true, code: "ok", reason: null, fix: null };
const no = (code: Exclude<GateCode, "ok" | "short">, fix: Fix): Gate => ({ allowed: false, code, reason: GATE_COPY[code], fix });

/** May `action` run now? Priority: login > account setup > offline/out-of-date/stale > shutdown > paused > username > funds. */
export function gate(action: UserAction, c: AppCtx): Gate {
  const r = ACTION_RULES[action];
  const shutdown = c.shutdown, paused = c.paused || c.shutdown;
  if (action === "login") return c.auth === "logged-out" ? OK : no("already-logged-in", null);
  if (action === "logout") return c.auth === "logged-out" ? no("not-logged-in", null) : OK;
  if (!r.login) return OK;
  // 1. session
  if (c.auth === "logged-out") return no("login", "login");
  if (c.auth === "setting-up") return no("setting-up", null);
  if (c.auth === "setup-failed") return no("setup-failed", "retry");
  if (action === "pick-username") return c.account === "has" ? no("already-named", null) : OK;
  // 2. connectivity / stale reads: never act on numbers we can't trust
  if (r.fresh) {
    if (c.offline) return no("offline", "retry");
    if (c.outOfDate) return no("out-of-date", "retry");
    if (c.viewFailed) return no("stale", "retry");
  }
  // 3. contract
  if (shutdown && (r.contract === "new" || r.contract === "live" || r.contract === "funding")) return no("shutdown", null);
  if (paused && r.contract === "new") return no("paused", null);
  // 4. Praetorial account
  if (r.name !== "no") {
    if (c.account === "none") return no("no-username", "pick-username");
    if (r.name === "always" && c.account === "checking") return no("checking-username", null);
    if (r.name === "always" && c.account === "unknown") return no("username-unknown", "retry");
  }
  // 5. funds
  if (r.paysIn && c.short) return { allowed: false, code: "short", reason: c.short.sentence, fix: "add-money", addMoneyPath: c.short.path };
  return OK;
}

// ---------------------------------------------------------------- identity
/** The one label for a person with no username. Raw ids are never a label (PEOPLE RULE): they appear only in Account details,
 *  Verify, Add money and Cash out. */
export const NO_USERNAME = "Unnamed account";

export interface Identity { account: string; username: string | null; isMe: boolean; label: string; named: boolean }

/** A person as the UI shows them: "You", "@alice", or NO_USERNAME. `selfAsName` shows the user's own @name (nav, Account). */
export function identityOf(p: { account: string; username?: string | null; me?: string | null; selfAsName?: boolean }): Identity {
  const username = p.username ? p.username.trim().replace(/^@/, "").toLowerCase() || null : null;
  const isMe = !!p.me && p.me === p.account;
  const label = isMe && !p.selfAsName ? "You" : username ? `@${username}` : isMe ? "You" : NO_USERNAME;
  return { account: p.account, username, isMe, label, named: !!username };
}
