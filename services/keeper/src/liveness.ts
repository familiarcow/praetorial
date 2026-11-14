// LH5 / D-HORIZON2: keeper liveness. The alarm is a log line plus an optional webhook (env), raised
// from the keeper's own tick: no new service. Pure functions; the clock is supplied by the caller.
import type { Alert } from "../../monitor/src/alerts.js";
import { LogOnlyAlertChannel, MultiAlertChannel, WebhookAlertChannel, type AlertChannel } from "../../monitor/src/alertChannel.js";

const NS = 1_000_000_000;
const MIN = 60 * NS;
const HOUR = 3600 * NS;
const DAY = 24 * HOUR;

/** A close-at-T bet may be requested from T + 5 min (Kraken 1m depth keeps T available for 6 h). */
export const REQUEST_AFTER_T_NS = 5 * MIN;
/** Alarm at half the 6 h request window. */
export const CLOSE_AT_T_ALARM_NS = 3 * HOUR;
/** Weather / game: alarm this long after the event day ends. */
export const DAY_BET_ALARM_NS = 4 * DAY;
const RECOVERY_NS = 7 * DAY; // D-RESOLVE1: resolve_deadline = event end + 7 d

export type LivenessKind = "close_at_t" | "day_end" | null;

function templateOf(bet: any): string | null {
  const terms = bet?.envelope?.terms;
  if (typeof terms !== "string") return null;
  try {
    const id = JSON.parse(terms)?.template?.id;
    return typeof id === "string" ? id : null;
  } catch { return null; }
}

/** The instant the event is over and the result can be asked for, or null for custom / hash-only terms. */
export function eventTimeNs(bet: any): { kind: "close_at_t" | "day_end"; ns: number } | null {
  const id = templateOf(bet);
  if (id === "btc_close_at_t" || id === "btc_touch") return { kind: "close_at_t", ns: Number(bet.envelope.funding_deadline) };
  if (id === "nws_daily_high" || id === "game_winner") return { kind: "day_end", ns: Number(bet.envelope.resolve_deadline) - RECOVERY_NS };
  return null;
}

/** CS1: the NWS climate report (CLI) for a day comes out after the station's local midnight (preliminary ~01:30 local).
 *  Asking earlier only buys a resolver RETRY, whose D-RESOLVE1 ladder steps 24 h (and spends one of max_paid_runs). */
export const NWS_REPORT_LAG_NS = 3 * HOUR;

/** Earliest instant the keeper should request a result: T + 5 min for close-at-T/touch sheets, the climate day end + the
 *  report lag for NWS daily-high sheets, else null (no extra wait; the resolver's game feed knows when a game is final). */
export function requestNotBeforeNs(bet: any): number | null {
  const e = eventTimeNs(bet);
  if (!e) return null;
  if (e.kind === "close_at_t") return e.ns + REQUEST_AFTER_T_NS;
  return templateOf(bet) === "nws_daily_high" ? e.ns + NWS_REPORT_LAG_NS : null;
}

const LIVE = new Set(["Taken", "Resolving", "Challenged", "Evidence"]);

export function livenessAlarms(
  bets: Map<string, { contractId: string; betId: number; bet: any }>,
  nowNs: number,
): Alert[] {
  const out: Alert[] = [];
  for (const [, tb] of bets) {
    const b = tb.bet;
    if (!LIVE.has(b.status) || b.outcome !== null || b.envelope?.referee) continue;
    const e = eventTimeNs(b);
    if (!e) continue;
    const limit = e.kind === "close_at_t" ? CLOSE_AT_T_ALARM_NS : DAY_BET_ALARM_NS;
    if (nowNs < e.ns + limit) continue;
    const lateH = Math.floor((nowNs - e.ns) / HOUR);
    out.push({
      key: `keeper_liveness:${tb.contractId}:${tb.betId}`,
      kind: "keeper_liveness",
      severity: "critical",
      message: `bet #${tb.betId} (${tb.contractId}) has no outcome ${lateH}h after its event time: keeper liveness`,
      detail: `status=${b.status} runs_used=${b.runs_used}/${b.envelope.max_paid_runs} pending_request=${b.pending_resolution_request}; anyone can press "Request the result now" on the bet page`,
    });
  }
  return out;
}

/** Log line always; a webhook too when KEEPER_ALARM_WEBHOOK_URL is set. */
export function buildAlarmChannel(
  env: Record<string, string | undefined>,
  deps: { log?: (m: string) => void; fetch?: (url: string, init: any) => Promise<{ ok: boolean; status: number }> } = {},
): AlertChannel {
  const chans: AlertChannel[] = [new LogOnlyAlertChannel(deps.log ?? ((m) => console.error(m)))];
  const url = env.KEEPER_ALARM_WEBHOOK_URL;
  if (url) chans.push(new WebhookAlertChannel(url, deps.fetch));
  return new MultiAlertChannel(chans);
}
