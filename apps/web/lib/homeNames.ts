// H1 (SM2 gap H1-2): the @usernames for the Home cards. One lookup layer: lib/betNames.ts (session cache, one in-flight call per
// account, the app's registry client); the screens never build a registry client. Best effort: a failed or missing lookup leaves
// the account unnamed, and the card says "Unnamed account" (betView personLabel), never the raw id.
import { useEffect, useMemo, useState } from "react";
import { lookupName, namesWithPending, useAppRegistry } from "./betNames";
import type { Names } from "./betView";

/** Names for `accounts`; re-renders as lookups land. */
export function useNames(accounts: string[]): Names {
  const registry = useAppRegistry();
  const [names, setNames] = useState<Names>({});
  const key = [...new Set(accounts)].sort().join("|");
  useEffect(() => {
    if (!registry || !key) return;
    let live = true;
    for (const a of key.split("|")) lookupName(registry, a).then((n) => { if (live) setNames((m) => (m[a] === n ? m : { ...m, [a]: n })); });
    return () => { live = false; };
  }, [key, registry]);
  // C1: not answered yet = loading ("…"), never a flash of "Unnamed account".
  return useMemo(() => namesWithPending(key ? key.split("|") : [], names as Record<string, string | null>, undefined, !!registry), [key, names, registry]);
}
