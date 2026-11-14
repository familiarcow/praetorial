// F4 (FUND4 SPEC §4.6-4.7, §7.4): the ONE live copy of the user's Add money records, shared by the sheet, the header strip and the
// toasts, so a deposit is polled once however many places show it. Records are this device's (lib/funding/store, written BEFORE
// the address is shown) merged with the funding Worker's list (a second device sees them). State changes come only from
// lib/funding/tracker.advance (SM2 M6); the poll policy is tracker.pollIntervalMs (5 s on screen, 10 s converting, 30 s in the
// background, paused while the tab is hidden, stopped at a final state).
import { useEffect, useSyncExternalStore } from "react";
import type { SwapRecord } from "../../../lib/funding/types";
import { advance, isTerminal, pollIntervalMs } from "../../../lib/funding/tracker";
import { loadLocal, upsertLocal, syncInFlight } from "../../../lib/funding/store";
import { createFundingClient, type FundingClient } from "../../../lib/funding/fundingClient";
import { depositApiEnabled } from "../../../lib/depositAddress";
import { e2eDepositApi, TEST_HOOKS_ENABLED } from "../../../lib/testHooks";
import { CURRENT_NETWORK } from "../../../lib/assets";

/** Add money runs through the one-time-address flow (mainnet, or a mocked spec's mainnet seam). Testnet keeps test NEAR + Move. */
export const addMoneySheetOn = (): boolean => depositApiEnabled() || e2eDepositApi();

/** The background calls to the funding Worker (its list: a second device's deposits; status polls) run on mainnet, like F3's
 * Account card (lib/accountBalances). A mocked spec that mocks the Worker opts in with window.__e2eFundingWorker (test builds
 * only), so specs that never mock it don't call it. Quotes are the user's own action and always go to the Worker. */
const workerOn = (): boolean =>
  CURRENT_NETWORK === "mainnet" || (TEST_HOOKS_ENABLED && typeof window !== "undefined" && (window as { __e2eFundingWorker?: boolean }).__e2eFundingWorker === true);

let client: FundingClient | null = null;
export const fundingClient = (): FundingClient => (client ??= createFundingClient());

interface Snap { account: string | null; records: SwapRecord[]; focus: string | null }
let snap: Snap = { account: null, records: [], focus: null };
const listeners = new Set<() => void>();
type Change = (prev: SwapRecord | undefined, next: SwapRecord) => void;
const changes = new Set<Change>();
const set = (s: Partial<Snap>) => { snap = { ...snap, ...s }; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export const onRecordChange = (f: Change) => { changes.add(f); return () => { changes.delete(f); }; };

/** Insert/replace a record: saved locally first (a reload or crash never loses it), then shown. */
export function putRecord(r: SwapRecord): void {
  upsertLocal(r);
  const prev = snap.records.find((x) => x.id === r.id);
  set({ records: [r, ...snap.records.filter((x) => x.id !== r.id)].sort((a, b) => b.createdAt - a.createdAt) });
  if (prev) changes.forEach((f) => f(prev, r));
}

/** Load this account's records: this device at once, then the server list (merged; a server outage keeps the local ones). */
export async function loadRecords(account: string): Promise<void> {
  if (snap.account !== account) set({ account, records: loadLocal(account) });
  if (!addMoneySheetOn() || !workerOn()) return;
  const r = await syncInFlight(account, { client: fundingClient() });
  if (snap.account === account) set({ records: r.records });
}

/** One status check through the Worker, folded in by tracker.advance (a failed check counts toward "checking", never "failed"). */
export async function pollRecord(id: string): Promise<void> {
  const r = snap.records.find((x) => x.id === id);
  if (!r || isTerminal(r)) return;
  let status = null;
  try { status = await fundingClient().status(r.depositAddress, r.depositMemo); } catch { status = null; }
  const cur = snap.records.find((x) => x.id === id) ?? r;
  const next = advance(cur, status, Date.now());
  if (next !== cur) putRecord(next);
}

/** The record shown in the sheet polls fast (5 s); everything else at the background rate. */
export const setFocus = (id: string | null) => set({ focus: id });

export function useFundingRecords(): SwapRecord[] {
  return useSyncExternalStore(subscribe, () => snap.records, () => snap.records);
}

/** Mounted once (App): loads the account's records and polls the open Add money ones on tracker.pollIntervalMs. */
export function useFundingPoller(account: string | null): void {
  useEffect(() => {
    if (!account) return;
    void loadRecords(account).catch(() => undefined);
    const last = new Map<string, number>();
    let busy = false;
    const tick = async () => {
      if (busy || !addMoneySheetOn() || !workerOn()) return;
      busy = true;
      try {
        const now = Date.now();
        for (const r of snap.records) {
          if (r.account !== account || (r.kind !== "fund" && r.signed !== true)) continue; // F5: signed cash outs / converts too
          const every = pollIntervalMs(r.state, { sheetOpen: snap.focus === r.id, hidden: typeof document !== "undefined" && document.hidden });
          if (every === null) continue;
          if (now - (last.get(r.id) ?? 0) < every) continue;
          last.set(r.id, now);
          await pollRecord(r.id);
        }
      } finally { busy = false; }
    };
    const t = setInterval(() => void tick(), 1000);
    const vis = () => { if (!document.hidden) void tick(); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [account]);
}
