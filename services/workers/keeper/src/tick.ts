// Bounded-batch keeper tick for the Worker host. Behaviour parity with keeper/src/runner.ts
// tickMulti (same policy.ts planner, same 30 s per-action rate limit persisted BEFORE the tx,
// same MON4 outlayer_unhealthy + liveness alarms) but with the differences a 5 ms-CPU,
// ~50-subrequest, once-a-minute invocation forces:
//   * at most `maxViews` get_bet reads and `maxActions` actions per tick; a rotating cursor
//     and least-recently-attempted ordering drain any backlog fairly over successive ticks;
//   * bets seen terminal (Settled/Voided/Cancelled/Expired) are remembered and never re-read;
//   * state lives behind a StateStore (Durable Object SQLite in production);
//   * no archive job / resolver-sim / file logging: those stay on the node host (out of CF1a).
import { planActionsForContracts, type ContractAction } from "../../../keeper/src/policy.js";
import { planOutcomeRelay, type OutcomeRelayArgs } from "@praetorial/common/outcomeRelay.js";
import { livenessAlarms } from "../../../keeper/src/liveness.js";
import { submitTimeRefusal } from "../../../keeper/src/resolvingState.js";
import type { TaggedBet } from "@praetorial/common/discovery.js";
import type { PendingPayout } from "@praetorial/common/types.js";
import type { AlertSink } from "../../common/src/telegram.js";

export const RATE_LIMIT_MS = 30_000;
/** LIFE1: after a failed/refused action, wait BACKOFF_BASE_MS * 2^(n-1), capped at BACKOFF_MAX_MS. */
export const BACKOFF_BASE_MS = 5 * 60_000;
export const BACKOFF_MAX_MS = 6 * 3600_000;
export function backoffMs(n: number): number { return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, n - 1)); }
const ALERT_COOLDOWN_MS = 15 * 60_000;
const OUTLAYER_WINDOW_MS = 30 * 60_000;
const TERMINAL = new Set(["Settled", "Voided", "Cancelled", "Expired"]);
const PAYOUT_PAGE = 200;
const PAYOUT_MAX_PAGES = 3;

export interface KeeperState {
  maxBetIds: Record<string, number>;
  terminal: Record<string, number[]>;
  cursor: Record<string, number>;
  payoutFloor: Record<string, number>; // KEEPDRAIN1: every payout line with id < floor is done (done never reverts), so the scan starts here
  lastAttempt: Record<string, number>; // action key -> epoch ms
  lastAlert: Record<string, number>;
  outlayerFails: number[];
  outlayerAlerting: boolean;
  lastHeartbeat: number;
  lastTickMs?: number; // STACK1: epoch ms of the last completed scheduled() tick (read by GET /health)
  // LIFE1 (SM1 SVC-2): action key -> consecutive failures + epoch ms before which it is not sent again. Persisted with the
  // attempt marks, so a refused tx is not re-sent every minute across restarts; dropped once the action is no longer planned.
  backoff?: Record<string, { n: number; until: number }>;
}
export const emptyState = (): KeeperState => ({ maxBetIds: {}, terminal: {}, cursor: {}, payoutFloor: {}, lastAttempt: {}, lastAlert: {}, outlayerFails: [], outlayerAlerting: false, lastHeartbeat: 0 });

export interface StateStore { load(): Promise<KeeperState>; save(s: KeeperState): Promise<void>; }
export class MemoryStateStore implements StateStore {
  private s: string | null = null;
  async load() { return this.s ? { ...emptyState(), ...JSON.parse(this.s) } : emptyState(); }
  async save(s: KeeperState) { this.s = JSON.stringify(s); }
}

export interface ChainClient {
  view<T>(contractId: string, method: string, args?: Record<string, unknown>): Promise<T>;
  call<T>(contractId: string, method: string, args?: Record<string, unknown>, gasTgas?: number): Promise<T>;
  callPayable<T>(contractId: string, method: string, args: Record<string, unknown>, attachedYocto: bigint): Promise<T>;
}
// KEEPDRAIN1: drain_payouts has its OWN per-tick budget (maxDrains, 3 subrequests each): it only moves money already owed to a
// user and is idempotent on-chain, so it must never queue behind (or be starved by) resolution/expire actions or a drain backlog.
export interface Limits { maxActions: number; maxViews: number; maxDrains: number; maxRelays: number; heartbeatEveryMs: number; }
export const DEFAULT_LIMITS: Limits = { maxActions: 1, maxViews: 8, maxDrains: 4, maxRelays: 2, heartbeatEveryMs: 15 * 60_000 };

export interface TickOpts {
  client: ChainClient;
  contracts: { id: string; version: string }[];
  store: StateStore;
  nowMs: () => number;
  alerts: AlertSink;
  limits?: Partial<Limits>;
  attachedYocto?: bigint;
  maxAttachedYocto?: bigint;
}

interface Alert { key: string; kind: string; severity: string; message: string; detail: string; }

export async function runKeeperTick(o: TickOpts): Promise<ContractAction[]> {
  const L: Limits = { ...DEFAULT_LIMITS };
  for (const [k, v] of Object.entries(o.limits ?? {})) if (typeof v === "number" && Number.isFinite(v)) (L as any)[k] = v;
  const now = o.nowMs();
  const state = await o.store.load();
  state.backoff ??= {};
  const backoff = state.backoff;
  const backedOff = (k: string) => (backoff[k]?.until ?? 0) > now;
  const fail = (k: string) => { const n = (backoff[k]?.n ?? 0) + 1; backoff[k] = { n, until: now + backoffMs(n) }; };
  const pending: Alert[] = [];

  // ---- discovery (bounded) ----
  const bets = new Map<string, TaggedBet>();
  let viewsLeft = L.maxViews;
  for (const [ci, c] of o.contracts.entries()) {
    // KEEPSUBMIT1c: per-contract fair share of the view budget; whatever an earlier contract leaves unused flows to the later ones.
    const budget = Math.floor(viewsLeft / (o.contracts.length - ci));
    const floorLeft = viewsLeft - budget;
    try {
      const terminal = new Set(state.terminal[c.id] ?? []);
      let max = state.maxBetIds[c.id] ?? 0;
      const known: number[] = [];
      for (let id = 1; id <= max; id++) if (!terminal.has(id)) known.push(id);
      const reserve = Math.min(1, budget); // keep room for ONE frontier probe every tick
      const take = Math.min(known.length, Math.max(0, budget - reserve));
      const start = known.length ? (state.cursor[c.id] ?? 0) % known.length : 0;
      const ids: number[] = [];
      for (let i = 0; i < take; i++) ids.push(known[(start + i) % known.length]);
      state.cursor[c.id] = known.length ? (start + take) % known.length : 0;
      const read = async (id: number) => {
        viewsLeft--;
        const bet = await o.client.view<any | null>(c.id, "get_bet", { bet_id: id });
        if (bet) {
          bets.set(`${c.id}:${id}`, { betId: id, bet, contractId: c.id, version: c.version });
          if (TERMINAL.has(bet.status)) terminal.add(id);
        }
        return bet;
      };
      for (const id of ids) await read(id);
      // Frontier: probe max+1 while it keeps hitting; stop at the first miss (never re-read the same missing id in a tick).
      while (viewsLeft > floorLeft) {
        const bet = await read(max + 1);
        if (!bet) break;
        max += 1;
      }
      state.maxBetIds[c.id] = max;
      state.terminal[c.id] = [...terminal].sort((a, b) => a - b);
    } catch (err: any) {
      console.error(`discover ${c.id} failed: ${err?.message ?? err}`);
    }
  }

  // ---- shutdown + payouts (one view each per contract) ----
  const shutdown = new Set<string>();
  const pendingPayoutBetIds: { contractId: string; betId: number }[] = [];
  for (const c of o.contracts) {
    try { if ((await o.client.view<boolean>(c.id, "is_shutdown", {})) === true) shutdown.add(c.id); } catch { /* older contract: not shut down */ }
    try {
      const all: PendingPayout[] = [];
      let from = state.payoutFloor?.[c.id] ?? 0;
      state.payoutFloor ??= {};
      for (let p = 0; p < PAYOUT_MAX_PAGES; p++) {
        const page = await o.client.view<PendingPayout[]>(c.id, "pending_payouts_view", { from, limit: PAYOUT_PAGE });
        all.push(...page);
        if (page.length < PAYOUT_PAGE) break;
        const next = Math.max(...page.map((x) => Number(x.id))) + 1;
        if (!(next > from)) break;
        from = next;
      }
      // Lines are dense by id and `done` never reverts: advance the floor to the first undone line (or past the last line seen).
      const undone = all.filter((x) => !x.done).map((x) => Number(x.id));
      const lastSeen = all.length ? Math.max(...all.map((x) => Number(x.id))) : (state.payoutFloor[c.id] ?? 0) - 1;
      state.payoutFloor[c.id] = undone.length ? Math.min(...undone) : lastSeen + 1;
      for (const betId of new Set(all.filter((x) => !x.done).map((x) => x.bet_id))) pendingPayoutBetIds.push({ contractId: c.id, betId });
    } catch (err: any) {
      console.error(`pending_payouts_view ${c.id} failed: ${err?.message ?? err}`);
    }
  }

  const nowNs = now * 1_000_000;
  const key = (a: ContractAction) => `${a.contractId}:${a.action.kind}:${a.action.bet_id}`;
  const planned = planActionsForContracts(bets, nowNs, shutdown, pendingPayoutBetIds)
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (state.lastAttempt[key(x.a)] ?? 0) - (state.lastAttempt[key(y.a)] ?? 0) || x.i - y.i)
    .map((x) => x.a);

  // ---- execution (bounded) ----
  const attached = o.attachedYocto ?? 0n;
  const executed: ContractAction[] = [];
  // CF1e3: select + mark every action of this tick, then ONE durable save BEFORE any tx is sent (was one save per action: the state
  // JSON dominated keeper CPU). A restart can still never re-fire an action: its attempt mark is persisted before its tx.
  const chosen: ContractAction[] = [];
  let nonDrain = 0, drains = 0;
  for (const ca of planned) {
    const isDrain = ca.action.kind === "drain_payouts";
    if (isDrain ? drains >= L.maxDrains : nonDrain >= L.maxActions) continue;
    const last = state.lastAttempt[key(ca)];
    if (last !== undefined && now - last < RATE_LIMIT_MS) continue;
    if (backedOff(key(ca))) continue;
    chosen.push(ca);
    if (isDrain) drains++; else nonDrain++;
    state.lastAttempt[key(ca)] = now;
  }
  if (chosen.length) await o.store.save(state);
  for (const ca of chosen) {
    const { contractId, action } = ca;
    try {
      if (action.kind === "request_resolution") {
        if (o.maxAttachedYocto !== undefined && attached > o.maxAttachedYocto) throw new Error("per-call NEAR cap exceeded");
        if (attached === 0n) await o.client.call(contractId, "request_resolution", { bet_id: action.bet_id }, 300);
        else await o.client.callPayable(contractId, "request_resolution", { bet_id: action.bet_id }, attached);
        mon4(state, true, now, "", pending);
      } else if (action.kind === "expire") {
        await o.client.call(contractId, "expire", { bet_id: action.bet_id });
      } else if (action.kind === "drain_payouts") {
        await o.client.call(contractId, "drain_payouts", { bet_id: action.bet_id, limit: 20 }, 300);
      } else {
        await o.client.call(contractId, action.kind, { bet_id: action.bet_id }, 300);
      }
      executed.push(ca);
      delete backoff[key(ca)];
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      fail(key(ca));
      pending.push({ key: `keeper_action_error:${action.kind}:${contractId}:${action.bet_id}`, kind: "keeper_action_error", severity: "warning", message: `keeper ${action.kind} failed on ${contractId} bet #${action.bet_id}`, detail: msg });
      if (action.kind === "request_resolution") mon4(state, false, now, msg, pending);
    }
  }

  // ---- KEEPSUBMIT1: relay the resolver's stored signed result to the permissionless submit_outcome (own budget: maxRelays) ----
  // The attempt mark is persisted BEFORE the tx (30 s window, same as every action); a failed call alerts and is retried after the window.
  const relays: { contractId: string; betId: number; args: OutcomeRelayArgs }[] = [];
  for (const [, tb] of bets) {
    const plan = planOutcomeRelay(tb.contractId, tb.betId, tb.bet);
    // LIFE1 (SM1 CON-2 trigger 2): a stored RETRY past its next_check_ns (or a stale observation / early VOID:unavailable) is refused
    // by submit_outcome forever; relaying it only burns gas. The monitor raises it as a stuck Resolving bet instead.
    if (plan.ok && submitTimeRefusal(tb.bet, tb.bet.last_resolution_raw ?? "", plan.outcome, nowNs) === null) relays.push({ contractId: tb.contractId, betId: tb.betId, args: plan.args });
  }
  const rkey = (r: { contractId: string; betId: number }) => `${r.contractId}:submit_outcome:${r.betId}`;
  relays.sort((x, y) => (state.lastAttempt[rkey(x)] ?? 0) - (state.lastAttempt[rkey(y)] ?? 0));
  const relayChosen = relays.filter((r) => { const last = state.lastAttempt[rkey(r)]; return (last === undefined || now - last >= RATE_LIMIT_MS) && !backedOff(rkey(r)); }).slice(0, L.maxRelays);
  for (const r of relayChosen) state.lastAttempt[rkey(r)] = now;
  if (relayChosen.length) await o.store.save(state);
  for (const r of relayChosen) {
    try {
      await o.client.call(r.contractId, "submit_outcome", r.args as unknown as Record<string, unknown>, 300);
      delete backoff[rkey(r)];
    } catch (err: any) {
      fail(rkey(r));
      pending.push({ key: `keeper_action_error:submit_outcome:${r.contractId}:${r.betId}`, kind: "keeper_action_error", severity: "warning", message: `keeper submit_outcome failed on ${r.contractId} bet #${r.betId}`, detail: String(err?.message ?? err) });
    }
  }
  const relayLive = new Set(relays.map(rkey));

  pending.push(...livenessAlarms(bets, nowNs));

  // ---- alerts (deduped, persisted cooldown) + heartbeat ----
  for (const a of pending) {
    const prev = state.lastAlert[a.key];
    if (prev !== undefined && now - prev < ALERT_COOLDOWN_MS) continue;
    state.lastAlert[a.key] = now;
    await o.alerts.send(`[${a.severity.toUpperCase()}] ${a.kind} ${a.key}: ${a.message} -- ${a.detail}`);
  }
  if (now - state.lastHeartbeat >= L.heartbeatEveryMs) {
    state.lastHeartbeat = now;
    await o.alerts.send(`keeper heartbeat ok: ${bets.size} bets read, ${executed.length} actions, ${o.contracts.length} contract(s)`);
  }
  for (const [k, t] of Object.entries(state.lastAlert)) if (now - t > 24 * 3600_000) delete state.lastAlert[k];
  // CF1e3: an attempt mark only matters while its action is still planned or inside the 30 s rate window; dropping the rest keeps the
  // persisted state (JSON parsed + stringified every tick, the dominant keeper CPU cost) bounded by the live backlog, not by 24 h of history.
  const live = new Set([...planned.map(key), ...relayLive]);
  for (const [k, t] of Object.entries(state.lastAttempt)) if (now - t > 24 * 3600_000 || (!live.has(k) && now - t >= RATE_LIMIT_MS)) delete state.lastAttempt[k];
  // A backoff outlives the rotation (a bet is read only every few ticks): drop it only once its bet was read this tick and the
  // action is no longer planned (the chain moved on), or a day after it expired.
  const readNow = (k: string) => { const m = /^(.*):[a-z_]+:(\d+)$/.exec(k); return !!m && bets.has(`${m[1]}:${m[2]}`); };
  for (const [k, b] of Object.entries(backoff)) if (now - b.until > 24 * 3600_000 || (readNow(k) && !live.has(k))) delete backoff[k];
  state.lastTickMs = now;
  await o.store.save(state);
  return executed;
}

/** MON4 OutlayerHealthTracker semantics (3 failures within 30 min -> critical; first success after -> info). */
function mon4(state: KeeperState, ok: boolean, now: number, detail: string, out: Alert[], threshold = 3): void {
  if (ok) {
    state.outlayerFails = [];
    if (state.outlayerAlerting) {
      state.outlayerAlerting = false;
      out.push({ key: "outlayer_unhealthy:recovered", kind: "outlayer_unhealthy", severity: "info", message: "OutLayer recovered: request_resolution runs are succeeding again", detail: "" });
    }
    return;
  }
  state.outlayerFails = [...state.outlayerFails, now].filter((t) => now - t <= OUTLAYER_WINDOW_MS);
  if (state.outlayerFails.length < threshold) return;
  state.outlayerAlerting = true;
  out.push({ key: "outlayer_unhealthy", kind: "outlayer_unhealthy", severity: "critical", message: `OutLayer unhealthy: ${state.outlayerFails.length} consecutive request_resolution runs errored`, detail: `last: ${detail}` });
}
