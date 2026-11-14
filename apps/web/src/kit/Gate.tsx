// SM2: the UI end of lib/appState.ts. App.tsx provides the composed AppCtx and the four fixes once (AppStateProvider); a screen
// asks useGate(action) and renders <GateNotice action=.../> where the action would be. Screens never read Privy, the registry,
// the contract flags or connectivity themselves to decide whether an action is shown/enabled (tests/sm2Lint.unit.test.ts).
import React, { createContext, useContext } from "react";
import { appCtx, gate, type AppCtx, type Gate as GateResult, type Short, type UserAction } from "../../lib/appState";
import { Notice } from "./blocks";
import { Button } from "../ui";

export interface GateFixes {
  login: () => void;
  pickUsername: () => void;
  retry: () => void;
  addMoney: (path: string) => void;
  /** A username was claimed/changed outside the gate (Account "Pick a username", Settings): the app state learns it at once. */
  usernameChanged: (name: string) => void;
}
interface AppStateValue { ctx: AppCtx; fixes: GateFixes }

const NOOP: GateFixes = { login: () => {}, pickUsername: () => {}, retry: () => {}, addMoney: () => {}, usernameChanged: () => {} };
// Outside the provider (playground, harness, unit-mounted screens) nothing extra is gated: the screen's own checks still apply.
const OPEN_CTX = appCtx({ auth: "ready", account: "not-required" });
const Ctx = createContext<AppStateValue>({ ctx: OPEN_CTX, fixes: NOOP });

export function AppStateProvider({ ctx, fixes, children }: { ctx: AppCtx; fixes: GateFixes; children: React.ReactNode }) {
  return <Ctx.Provider value={{ ctx, fixes }}>{children}</Ctx.Provider>;
}
export const useAppState = (): AppStateValue => useContext(Ctx);

/** gate(action) against the app's current state. `short` = this action's balance shortfall (lib/fundingGate fundingShort). */
export function useGate(action: UserAction, opts: { short?: Short | null } = {}): GateResult {
  const { ctx } = useContext(Ctx);
  return gate(action, opts.short !== undefined ? { ...ctx, short: opts.short } : ctx);
}

/** GUEST1: while browsing as a guest (logged out), every action button stays pressable and opens "Log in to bet" instead (the URL is
 *  kept, so login lands back here). null when signed in, or outside the provider: the button's own checks apply. */
export function useLoginFirst(): (() => void) | null {
  const { ctx, fixes } = useContext(Ctx);
  return ctx.auth === "logged-out" ? fixes.login : null;
}

const FIX_LABEL: Record<Exclude<GateResult["fix"], null>, string> = {
  login: "Log in",
  "pick-username": "Pick a username",
  "add-money": "Add money",
  retry: "Try again",
};

/** The one way a blocked action explains itself: the reason sentence + the one fix button. Renders nothing when allowed.
 *  `only` limits it to some codes (a screen that already shows e.g. the paused banner passes only={["no-username"]}). */
export function GateNotice({ action, short, only, testId }: { action: UserAction; short?: Short | null; only?: GateResult["code"][]; testId?: string }) {
  const g = useGate(action, { short });
  const { fixes } = useAppState();
  if (g.allowed || (only && !only.includes(g.code))) return null;
  const run = () => {
    if (g.fix === "login") fixes.login();
    else if (g.fix === "pick-username") fixes.pickUsername();
    else if (g.fix === "retry") fixes.retry();
    else if (g.fix === "add-money" && g.addMoneyPath) fixes.addMoney(g.addMoneyPath);
  };
  const tone = g.code === "shutdown" || g.code === "setup-failed" ? "bad" : "warn";
  return (
    <Notice tone={tone} title={g.reason} data-testid={testId ?? `gate-${action}`} data-gate={g.code} data-fix={g.fix ?? ""}
      action={g.fix ? <Button data-testid={`gate-fix-${g.fix}`} onClick={run}>{FIX_LABEL[g.fix]}</Button> : undefined} />
  );
}
