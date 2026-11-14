// SRCW1 (5): per-IP 10/hour and global 300/day execution caps. Both fail closed (the caller maps a refusal to 429 + alert).
// State is one record per IP ({bucket,count}, overwritten each hour: no unbounded growth) + one global record.
export const IP_PER_HOUR = 10;
export const GLOBAL_PER_DAY = 300;
/** LIVE2: hard ceiling on a configured per-IP cap (a typo like 100000 must not disable the limiter). */
export const IP_PER_HOUR_MAX = 1000;
/** LIVE2: SOURCECHECK_IP_PER_HOUR (wrangler [vars], testnet only) -> per-IP hourly cap. Anything but a whole number in
 * 1..IP_PER_HOUR_MAX falls back to the default IP_PER_HOUR (fail to the safe, stricter value). */
export function ipPerHourFromEnv(v: unknown): number {
  const t = typeof v === "string" ? v.trim() : typeof v === "number" && Number.isInteger(v) ? String(v) : "";
  if (!/^\d+$/.test(t)) return IP_PER_HOUR;
  const n = Number(t);
  return n >= 1 && n <= IP_PER_HOUR_MAX ? n : IP_PER_HOUR;
}
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface CounterStore { get(key: string): Promise<{ bucket: number; count: number } | undefined>; put(key: string, v: { bucket: number; count: number }): Promise<void>; }
export function memoryStore(): CounterStore {
  const m = new Map<string, { bucket: number; count: number }>();
  return { async get(k) { return m.get(k); }, async put(k, v) { m.set(k, v); } };
}
export type ConsumeResult = { ok: true } | { ok: false; scope: "ip" | "global"; retryAfterS: number };

export class SourceCheckLimiter {
  constructor(private readonly store: CounterStore, private readonly ipPerHour = IP_PER_HOUR, private readonly globalPerDay = GLOBAL_PER_DAY) {}
  /** Counts one execution against the IP and the day, atomically: a refusal consumes nothing. */
  async consume(ip: string, nowMs: number): Promise<ConsumeResult> {
    const hb = Math.floor(nowMs / HOUR_MS), db = Math.floor(nowMs / DAY_MS);
    const ipRec = await this.store.get(`ip:${ip}`); const gRec = await this.store.get("global");
    const ipCount = ipRec && ipRec.bucket === hb ? ipRec.count : 0;
    const gCount = gRec && gRec.bucket === db ? gRec.count : 0;
    if (gCount >= this.globalPerDay) return { ok: false, scope: "global", retryAfterS: Math.ceil(((db + 1) * DAY_MS - nowMs) / 1000) };
    if (ipCount >= this.ipPerHour) return { ok: false, scope: "ip", retryAfterS: Math.ceil(((hb + 1) * HOUR_MS - nowMs) / 1000) };
    await this.store.put(`ip:${ip}`, { bucket: hb, count: ipCount + 1 });
    await this.store.put("global", { bucket: db, count: gCount + 1 });
    return { ok: true };
  }
}
