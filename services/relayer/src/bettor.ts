// D-RLY1: "is this account an existing bettor (maker or taker of a bet on
// the escrow)?" -- decides whether a sender may draw from the reserved share
// of the global gas cap. Lookups are injected; production wiring uses the
// services indexer (GET /history?account=) or, without an indexer, the same
// escrow `get_bet` scan the keeper/monitor use (common/discovery.ts).
// ANY failure or timeout => NOT a bettor (never unlimited), and failures are
// never cached.
import type { NearClient } from "@praetorial/common/nearClient.js";
import { discoverAllBets } from "@praetorial/common/discovery.js";
import type { EscrowContractRef } from "@praetorial/common/config.js";
import type { Bet } from "@praetorial/common/types.js";

export type BettorLookup = (accountId: string) => Promise<boolean>;

export interface BettorCheckerOptions {
  ttlMs?: number; // default 60s
  timeoutMs?: number; // default 2s
  maxEntries?: number; // default 10_000 (attackers can mint unlimited sender ids)
  now?: () => number;
}

export function makeBettorChecker(lookup: BettorLookup, opts: BettorCheckerOptions = {}): BettorLookup {
  const ttlMs = opts.ttlMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const maxEntries = opts.maxEntries ?? 10_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { value: boolean; at: number }>();
  return async (accountId) => {
    const hit = cache.get(accountId);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        lookup(accountId),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error("bettor lookup timeout")), timeoutMs);
        }),
      ]);
      const v = value === true;
      cache.delete(accountId);
      cache.set(accountId, { value: v, at: now() });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
      return v;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/** Indexer-backed lookup: GET <base>/history?account=<id> -> entries with maker/taker. */
export function indexerBettorLookup(baseUrl: string, fetchImpl: typeof fetch = fetch): BettorLookup {
  return async (accountId) => {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/history?account=${encodeURIComponent(accountId)}`);
    if (!res.ok) throw new Error(`indexer /history: HTTP ${res.status}`);
    const rows = (await res.json()) as { maker?: string; taker?: string | null }[];
    if (!Array.isArray(rows)) throw new Error("indexer /history: bad response");
    return rows.some((r) => r.maker === accountId || r.taker === accountId);
  };
}

/** Escrow-view fallback: scans get_bet (as keeper/monitor do) and caches the
 * maker/taker set for `refreshMs` so a lookup is not a full scan each time. */
export function escrowBettorLookup(client: NearClient, escrowContract: string, refreshMs = 60_000, now: () => number = Date.now): BettorLookup {
  let accounts = new Set<string>();
  let loadedAt = -Infinity;
  let maxId = 0;
  return async (accountId) => {
    if (now() - loadedAt >= refreshMs) {
      const { bets, newMaxId } = await discoverAllBets(client, escrowContract, maxId);
      const next = new Set<string>();
      for (const bet of bets.values()) {
        next.add(bet.envelope.maker);
        if (bet.taker) next.add(bet.taker);
      }
      accounts = next;
      maxId = newMaxId;
      loadedAt = now();
    }
    return accounts.has(accountId);
  };
}

/** Multi-contract escrow-view lookup: a bettor is a maker/taker on ANY
 * configured escrow contract (a new deployment's bettors must not be locked
 * out of the reserved share). A contract that errors is skipped for this
 * refresh and its previous account set kept; it can only ever make the
 * answer more conservative, never mark a stranger as a bettor. */
export function escrowBettorLookupMulti(
  client: Pick<NearClient, "view">,
  contracts: EscrowContractRef[],
  refreshMs = 60_000,
  now: () => number = Date.now,
): BettorLookup {
  const perContract = new Map<string, { accounts: Set<string>; maxId: number }>();
  let loadedAt = -Infinity;
  return async (accountId) => {
    if (now() - loadedAt >= refreshMs) {
      for (const c of contracts) {
        try {
          const prev = perContract.get(c.id);
          const { bets, newMaxId } = await discoverAllBets(client as NearClient, c.id, prev?.maxId ?? 0);
          const next = new Set<string>();
          for (const bet of bets.values()) {
            next.add(bet.envelope.maker);
            if (bet.taker) next.add(bet.taker);
          }
          perContract.set(c.id, { accounts: next, maxId: newMaxId });
        } catch {
          // keep previous set for this contract
        }
      }
      loadedAt = now();
    }
    for (const { accounts } of perContract.values()) if (accounts.has(accountId)) return true;
    return false;
  };
}

/** CF1b2: indexer first; if it is absent or ANY lookup error happens, ask the escrow-view lookup instead
 * (host-neutral: the Worker and any other host compose the same way). The fallback can only widen a failed
 * lookup into a real answer; if it fails too the error propagates and makeBettorChecker maps it to "not a
 * bettor" without caching. A successful indexer answer (true or false) is final. */
export function bettorLookupWithFallback(primary: BettorLookup | undefined, fallback: BettorLookup): BettorLookup {
  if (!primary) return fallback;
  return async (accountId) => {
    try { return await primary(accountId); } catch { return fallback(accountId); }
  };
}

/** Persistent state for the bounded escrow scan (a Durable Object's SQLite in the Worker). Synchronous. */
export interface BettorScanStore {
  getMeta(key: "loadedAt" | "frontier" | "cycleStart"): number;
  setMeta(key: "loadedAt" | "frontier" | "cycleStart", value: number): void;
  /** Record/refresh a bet; checkedAt = scan time. */
  put(betId: number, maker: string, taker: string | null, checkedAt: number): void;
  /** Ids of known bets with no taker yet that were last checked before `before`, oldest check first. */
  openIdsCheckedBefore(before: number, limit: number): number[];
  has(accountId: string): boolean;
}

export interface BoundedScanOptions { refreshMs?: number; maxViews?: number; now?: () => number }

/** Same answer as escrowBettorLookup (maker/taker of any get_bet), but at most `maxViews` get_bet calls per
 * lookup and progress persisted in `store`: new ids are probed from the stored frontier (stop after 3
 * consecutive gaps, as discoverAllBets), still-open bets are re-checked round-robin so a later taker is seen.
 * Fresh cache (< refreshMs since a complete cycle) => zero RPC. An incomplete cycle answers true when the
 * account is already known, otherwise THROWS (=> non-bettor, uncached, retried next request): an unscanned
 * bettor is never reported as a stranger for the cache TTL, and a stranger is never reported as a bettor. */
export function boundedEscrowBettorLookup(client: Pick<NearClient, "view">, escrowContract: string, store: BettorScanStore, opts: BoundedScanOptions = {}): BettorLookup {
  const refreshMs = opts.refreshMs ?? 60_000;
  const maxViews = opts.maxViews ?? 40;
  const now = opts.now ?? Date.now;
  return async (accountId) => {
    const t = now();
    if (store.getMeta("loadedAt") > 0 && t - store.getMeta("loadedAt") < refreshMs) return store.has(accountId);
    let cycle = store.getMeta("cycleStart");
    if (!cycle) { cycle = t; store.setMeta("cycleStart", cycle); }
    let budget = maxViews;
    let complete = false;
    let id = store.getMeta("frontier") + 1;
    let misses = 0;
    while (budget > 0) {
      const bet = await client.view<Bet | null>(escrowContract, "get_bet", { bet_id: id });
      budget--;
      if (bet) { store.put(id, bet.envelope.maker, bet.taker ?? null, t); store.setMeta("frontier", id); misses = 0; }
      else if (++misses >= 3) { complete = true; break; }
      id++;
    }
    if (complete) {
      const open = store.openIdsCheckedBefore(cycle, budget + 1);
      for (const openId of open.slice(0, budget)) {
        const bet = await client.view<Bet | null>(escrowContract, "get_bet", { bet_id: openId });
        if (bet) store.put(openId, bet.envelope.maker, bet.taker ?? null, t);
        else store.put(openId, "", null, t); // vanished: keep slot out of the open queue (empty maker never matches)
      }
      if (open.length <= budget) { store.setMeta("loadedAt", now()); store.setMeta("cycleStart", 0); }
      else complete = false;
    }
    if (store.has(accountId)) return true;
    if (!complete) throw new Error("bettor scan incomplete this request");
    return false;
  };
}
