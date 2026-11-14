// K0 (UIR1 §2.1 TimeLeft, familiarcow UX-37 #6): THE date formatter. People read relative times ("Closes in 2 days", "Final in 18 h");
// the exact local time + UTC is one tap away (src/kit/TimeLeft) and written out in Details. Seconds only in the last minute.
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "in 6 days" / "18 h ago" / "in 45 min" / "in 30 s" / "now". */
export function relTime(atMs: number, nowMs: number): string {
  const d = atMs - nowMs;
  const a = Math.abs(d);
  let w: string;
  if (a < 1000) return "now";
  if (a < MIN) w = `${Math.floor(a / 1000)} s`;
  else if (a < HOUR) w = `${Math.floor(a / MIN)} min`;
  else if (a < DAY) w = `${Math.floor(a / HOUR)} h`;
  else if (a < 60 * DAY) w = plural(Math.floor(a / DAY), "day");
  else if (a < 730 * DAY) w = plural(Math.floor(a / (30 * DAY)), "month");
  else w = plural(Math.floor(a / (365 * DAY)), "year");
  return d > 0 ? `in ${w}` : `${w} ago`;
}

export interface ExactTime { local: string; utc: string; iso: string }
/** The exact time in the reader's zone and in UTC. `locale`/`timeZone` default to the browser's (fixed in tests). */
export function exactTime(atMs: number, o: { locale?: string; timeZone?: string } = {}): ExactTime {
  const d = new Date(atMs);
  const fmt = (timeZone: string | undefined) => new Intl.DateTimeFormat(o.locale ?? "en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone,
  }).format(d);
  const local = `${fmt(o.timeZone)}${o.timeZone === "UTC" ? " UTC" : ""}`;
  return { local, utc: `${fmt("UTC")} UTC`, iso: d.toISOString() };
}

/** Exact UTC from a chain timestamp in ns (Details rows). */
export const utcFromNs = (ns: number | string): string => exactTime(Math.floor(Number(ns) / 1e6)).utc;

export interface TimeLeftText { text: string; urgent: boolean; past: boolean }
/** "Closes in 2 days" / "Closed 1 day ago"; urgent = less than an hour to go. */
export function timeLeft(a: { at: number; now: number; future: string; past?: string }): TimeLeftText {
  const past = a.at <= a.now;
  const rel = relTime(a.at, a.now);
  return { text: `${past ? a.past ?? a.future : a.future} ${rel}`, urgent: !past && a.at - a.now < HOUR, past };
}

/** How often a relative label must re-render to stay right (every second in the last minute, else every 30 s). */
export const tickMs = (atMs: number, nowMs: number): number => (Math.abs(atMs - nowMs) < 2 * MIN ? 1000 : 30_000);
