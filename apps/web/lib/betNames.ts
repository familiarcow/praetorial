// B1 (familiarcow 2026-11-11: "we register them by their praetorial username ... creating a consistent UX"): the @usernames of everyone on a
// bet (maker, taker, referee, challengers, evidence filers, a proposed new referee), looked up once per account from the registry
// (HttpUserRegistry.byAccount) and cached for the session. Best effort: a failed or missing lookup leaves the account unnamed, and
// the screen shows "Unnamed account" (lib/betView.ts personLabel), never the raw id.
import { useEffect, useMemo, useState } from "react";
import type { Bet } from "./escrowAdapter";
import type { Names } from "./betView";
import { HttpUserRegistry, type UserRegistry } from "./refereeRegistry";
import { REGISTRY_URL } from "./config";
import { e2eRegistryUrl } from "./testHooks";

const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

/** Every account a bet page names (incl. a named taker: taker_allow { Account }). */
export function accountsOnBet(bet: Bet): string[] {
  const out = new Set<string>([bet.envelope.maker]);
  if (bet.taker) out.add(bet.taker);
  if (bet.envelope.referee?.account) out.add(bet.envelope.referee.account);
  const allow = bet.envelope.taker_allow as unknown;
  if (allow && typeof allow === "object" && typeof (allow as { Account?: unknown }).Account === "string") out.add((allow as { Account: string }).Account);
  if (bet.challenged_by) out.add(bet.challenged_by);
  for (const b of bet.bonds ?? []) out.add(b.holder);
  for (const x of bet.exhibits ?? []) out.add(x.submitted_by);
  for (const v of [bet.referee_proposal?.maker_value, bet.referee_proposal?.taker_value]) {
    try { const j = v ? JSON.parse(v) : null; if (typeof j?.account === "string") out.add(j.account); } catch { /* not a proposal */ }
  }
  return [...out];
}

/** C1: a lookup that never answers ends as "no name" after this long (so a person is never "…" forever); not cached. */
export const LOOKUP_TIMEOUT_MS = 10_000;
const TIMED_OUT = Symbol("timeout");

export function lookupName(reg: UserRegistry, account: string): Promise<string | null> {
  if (cache.has(account)) return Promise.resolve(cache.get(account)!);
  let p = inflight.get(account);
  if (!p) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((r) => { timer = setTimeout(() => r(TIMED_OUT), LOOKUP_TIMEOUT_MS); });
    const asked = reg.byAccount(account).then((u) => u?.username ?? null, () => null);
    p = Promise.race([asked, timeout]).then((n) => {
      clearTimeout(timer);
      inflight.delete(account);
      if (n === TIMED_OUT) return null;
      cache.set(account, n);
      return n;
    });
    inflight.set(account, p);
  }
  return p;
}

/** C1: the names a screen renders. Accounts whose lookup has not answered yet are present with value undefined (= loading, shown as
 *  "…", lib/betView NAME_LOADING) from the very first render, so a named person never flashes as "Unnamed account". With no registry
 *  configured nobody is looked up, so nobody is loading (everyone is unnamed). */
export function namesWithPending(accounts: string[], state: Record<string, string | null>, known: Map<string, string | null> = cache, hasRegistry = true): Names {
  const out: Names = {};
  for (const a of accounts) {
    if (a in state) out[a] = state[a];
    else if (known.has(a)) out[a] = known.get(a)!;
    else if (hasRegistry) out[a] = undefined;
  }
  return out;
}

/** The app's registry client for name lookups (SM2: screens never build one; this lib is the one lookup layer). null = none set. */
export function useAppRegistry(): UserRegistry | null {
  const url = e2eRegistryUrl() ?? REGISTRY_URL;
  return useMemo(() => (url ? new HttpUserRegistry(url) : null), [url]);
}

/** Names for everyone on `bet`; re-renders as lookups land. `registry` null = no registry configured (everyone unnamed). */
export function useBetNames(bet: Bet | null, registry: UserRegistry | null): Record<string, string | null> {
  const [names, setNames] = useState<Record<string, string | null>>({});
  const key = bet ? accountsOnBet(bet).join("|") : "";
  useEffect(() => {
    if (!bet || !registry) return;
    let live = true;
    for (const a of accountsOnBet(bet)) {
      if (cache.has(a)) { const n = cache.get(a)!; setNames((m) => (m[a] === n ? m : { ...m, [a]: n })); continue; }
      lookupName(registry, a).then((n) => { if (live) setNames((m) => (m[a] === n ? m : { ...m, [a]: n })); });
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, registry]);
  return useMemo(() => namesWithPending(key ? key.split("|") : [], names, cache, !!registry) as Record<string, string | null>, [key, names, registry]);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Replace each whole account id in `text` (longest first; never inside a longer id) with `label(account)`. Library messages
 *  (payoutScreen, refereeChange) name people by account id; the screen names them as people. */
export function nameAccountsIn(text: string, accounts: Iterable<string>, label: (account: string) => string): string {
  return [...new Set(accounts)].filter(Boolean).sort((a, b) => b.length - a.length)
    .reduce((t, a) => t.replace(new RegExp(`(?<![\\w.-])${escapeRe(a)}(?![\\w-]|\\.\\w)`, "g"), () => label(a)), text);
}

/** FE16b (stale money): "You put in 10.00 USDC to win 0.5 NEAR." -> "You put in — to win —." Amounts are a number followed by an all-caps token symbol. */
export function hideAmounts(text: string): string {
  return text.replace(/(?:<\s*)?\d[\d,]*(?:\.\d+)?\s?[A-Z][A-Z0-9]{1,7}\b/g, "—");
}
