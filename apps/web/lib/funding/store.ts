// F2: in-flight swap persistence (SPEC §7.4). Two copies, merged:
//   - localStorage `praetorial:funding:v1:<account>` (max 30 records, finished ones dropped after 30 days). Written BEFORE a
//     deposit address is shown (and before a cash out is signed), so a reload or crash never loses one.
//   - the Worker's list (`GET /fund/list`, written by the Worker when it issues a real quote), so a second device sees it.
// Merge rule: the server wins on state; the local copy wins on `needReturn` (local-only); a finished (credited/refunded) record
// never goes back to an earlier state; records only one side knows are kept. A server outage never hides local records.
import type { SwapRecord } from "./types";
import { TERMINAL_STATES } from "./types";
import type { FundingClient } from "./fundingClient";

export const MAX_RECORDS = 30;
export const RECORD_TTL_MS = 30 * 24 * 3_600_000;
export const storageKey = (account: string): string => `praetorial:funding:v1:${account}`;

export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }
const defaultStorage = (): StorageLike | null => (typeof localStorage !== "undefined" ? localStorage : null);
const isOpen = (r: SwapRecord) => !TERMINAL_STATES.includes(r.state);
const FINAL = new Set(["credited", "refunded"]);

function valid(r: any, account: string): r is SwapRecord {
  return !!r && typeof r === "object" && r.account === account && typeof r.id === "string" && typeof r.depositAddress === "string"
    && typeof r.state === "string" && typeof r.createdAt === "number" && r.origin && r.destination;
}

/** Keep every open record, then the newest finished ones, up to MAX_RECORDS; drop finished records older than the TTL. */
function prune(records: SwapRecord[], now: number): SwapRecord[] {
  const fresh = records.filter((r) => isOpen(r) || now - r.createdAt <= RECORD_TTL_MS);
  const open = fresh.filter(isOpen).sort((a, b) => b.createdAt - a.createdAt);
  const done = fresh.filter((r) => !isOpen(r)).sort((a, b) => b.createdAt - a.createdAt);
  return [...open, ...done].slice(0, Math.max(MAX_RECORDS, open.length));
}

export function loadLocal(account: string, storage: StorageLike | null = defaultStorage(), now = Date.now()): SwapRecord[] {
  try {
    const raw = storage?.getItem(storageKey(account));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? prune(parsed.filter((r) => valid(r, account)), now) : [];
  } catch { return []; }
}

export function saveLocal(account: string, records: SwapRecord[], storage: StorageLike | null = defaultStorage(), now = Date.now()): void {
  try { storage?.setItem(storageKey(account), JSON.stringify(prune(records.filter((r) => r.account === account), now))); } catch { /* quota / private mode */ }
}

/** Insert or replace one record (by id) in its account's local list. */
export function upsertLocal(record: SwapRecord, storage: StorageLike | null = defaultStorage(), now = Date.now()): void {
  const list = loadLocal(record.account, storage, now).filter((r) => r.id !== record.id);
  saveLocal(record.account, [record, ...list], storage, now);
}

export function mergeRecords(account: string, local: SwapRecord[], server: SwapRecord[]): SwapRecord[] {
  const out = new Map<string, SwapRecord>();
  for (const r of local) if (r.account === account) out.set(r.id, r);
  for (const s of server) {
    if (s.account !== account) continue;
    const l = out.get(s.id);
    if (!l) { out.set(s.id, { ...s, needReturn: null, createdHere: false }); continue; } // SECREV1 SR-1: never signable from here
    if (FINAL.has(l.state) && !FINAL.has(s.state)) continue; // never regress a finished record
    out.set(s.id, { ...l, ...s, needReturn: l.needReturn, checkFailures: l.checkFailures, createdHere: l.createdHere === true });
  }
  return [...out.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export const inFlightOnly = (records: SwapRecord[]): SwapRecord[] => records.filter(isOpen);

/** Local + server, merged and written back locally. `serverOk: false` = we only have this device's records right now. */
export async function syncInFlight(account: string, deps: { client: FundingClient; storage?: StorageLike | null; now?: number }): Promise<{ records: SwapRecord[]; serverOk: boolean }> {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const now = deps.now ?? Date.now();
  const local = loadLocal(account, storage, now);
  let server: SwapRecord[] | null = null;
  try { server = await deps.client.list(account); } catch { server = null; }
  const records = server ? mergeRecords(account, local, server) : local;
  if (server) saveLocal(account, records, storage, now);
  return { records: prune(records, now), serverOk: server !== null };
}
