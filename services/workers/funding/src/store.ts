// F1: in-flight swap records + fixed-window rate limits, over a tiny KV (Durable Object storage in production, a Map in tests).
// Keys: `rec:<depositAddress>` -> SwapRecord; `acct:<account>:<depositAddress>` -> createdAt (per-account index);
//       `rl:<bucket>` -> {window, count}. Records are never deleted by the Worker: `list` filters to non-terminal + last 30 days.
import { TERMINAL_STATUSES, type OneClickStatus } from "../../../common/src/funding/oneclickTypes.js";

export type SwapKind = "fund" | "withdraw" | "convert";
export interface SwapRecord {
  depositAddress: string;
  depositMemo: string | null;
  account: string;
  kind: SwapKind;
  originAsset: string;
  destinationAsset: string;
  amountIn: string;
  minAmountIn: string;
  amountOut: string;
  minAmountOut: string;
  /** withdraw: the destination-chain address; fund/convert: the account (INTENTS) */
  recipient: string;
  /** the address deadline from the signed quote (ISO) */
  deadline: string;
  createdAt: number;
  updatedAt: number;
  status: OneClickStatus;
  correlationId: string;
  /** the full signed 1Click quote response, kept for dispute resolution (1Click docs ask for it). Never returned by /fund/list. */
  signedQuote: unknown;
  /** fund: "verified" = 1Click's signature checked; "btc_unverified" = D-PM3 BTC origin-chain exception (1Click signature bug,
   * echo checked field by field instead). Absent on records made before F1B and on withdraw/convert (always verified). */
  quoteSignature?: "verified" | "btc_unverified";
  /** withdraw/convert: the exact NEP-413 payload handed out by /withdraw/intent (stable JSON); null before */
  intentPayload: string | null;
  intentHash: string | null;
  submittedAt: number | null;
  lastError: string | null;
  /** from the last 1Click status: origin units seen, destination units delivered, origin units refunded + reason */
  received?: string | null;
  delivered?: string | null;
  refunded?: string | null;
  refundReason?: string | null;
}

export interface Kv {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  list<T>(prefix: string, limit: number): Promise<Map<string, T>>;
}
export function memoryKv(): Kv & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    async get(k) { return structuredClone(map.get(k)) as any; },
    async put(k, v) { map.set(k, structuredClone(v)); },
    async list(prefix, limit) {
      const out = new Map<string, any>();
      for (const k of [...map.keys()].sort()) { if (k.startsWith(prefix)) out.set(k, structuredClone(map.get(k))); if (out.size >= limit) break; }
      return out;
    },
  };
}

export const RECORD_TTL_MS = 30 * 86_400_000;
/** A non-terminal record stops counting as "open" this long after its address deadline (SPEC §4.6 Expired). */
export const EXPIRE_GRACE_MS = 30 * 60_000;
export const isTerminal = (s: OneClickStatus) => TERMINAL_STATUSES.includes(s);
export const isOpen = (r: SwapRecord, nowMs: number) => !isTerminal(r.status) && Date.parse(r.deadline) + EXPIRE_GRACE_MS > nowMs;

export interface LimitRule { key: string; limit: number; windowMs: number }
export type LimitResult = { ok: true } | { ok: false; key: string; retryAfterS: number };

export class FundingState {
  constructor(private readonly kv: Kv) {}

  /** Counts one hit against every rule, atomically: a refusal consumes nothing. */
  async consume(rules: LimitRule[], nowMs: number): Promise<LimitResult> {
    const cur: { r: LimitRule; w: number; count: number }[] = [];
    for (const r of rules) {
      const w = Math.floor(nowMs / r.windowMs);
      const rec = await this.kv.get<{ w: number; count: number }>(`rl:${r.key}`);
      const count = rec && rec.w === w ? rec.count : 0;
      if (count >= r.limit) return { ok: false, key: r.key, retryAfterS: Math.max(1, Math.ceil(((w + 1) * r.windowMs - nowMs) / 1000)) };
      cur.push({ r, w, count });
    }
    for (const c of cur) await this.kv.put(`rl:${c.r.key}`, { w: c.w, count: c.count + 1 });
    return { ok: true };
  }

  async get(depositAddress: string): Promise<SwapRecord | null> {
    return (await this.kv.get<SwapRecord>(`rec:${depositAddress}`)) ?? null;
  }

  /** Inserts a new record; refuses an address that already has one (1Click addresses are one-shot). */
  async insert(r: SwapRecord): Promise<boolean> {
    if (await this.kv.get(`rec:${r.depositAddress}`)) return false;
    await this.kv.put(`rec:${r.depositAddress}`, r);
    await this.kv.put(`acct:${r.account}:${r.depositAddress}`, r.createdAt);
    return true;
  }

  /** insert() unless the account already has `maxOpen` open records (one DO call, so two racing quotes cannot both pass). */
  async insertCapped(r: SwapRecord, maxOpen: number, nowMs: number): Promise<"ok" | "exists" | "too_many_open"> {
    if ((await this.countOpen(r.account, nowMs)) >= maxOpen) return "too_many_open";
    return (await this.insert(r)) ? "ok" : "exists";
  }

  async patch(depositAddress: string, p: Partial<SwapRecord>): Promise<SwapRecord | null> {
    const r = await this.get(depositAddress);
    if (!r) return null;
    const next = { ...r, ...p, depositAddress: r.depositAddress, account: r.account, kind: r.kind };
    await this.kv.put(`rec:${depositAddress}`, next);
    return next;
  }

  async listAccount(account: string, nowMs: number): Promise<SwapRecord[]> {
    const idx = await this.kv.list<number>(`acct:${account}:`, 1000);
    const out: SwapRecord[] = [];
    for (const k of idx.keys()) {
      const r = await this.get(k.slice(`acct:${account}:`.length));
      if (r && (!isTerminal(r.status) || nowMs - r.updatedAt <= RECORD_TTL_MS) && nowMs - r.createdAt <= RECORD_TTL_MS * 4) out.push(r);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  async countOpen(account: string, nowMs: number): Promise<number> {
    return (await this.listAccount(account, nowMs)).filter((r) => isOpen(r, nowMs)).length;
  }
}
