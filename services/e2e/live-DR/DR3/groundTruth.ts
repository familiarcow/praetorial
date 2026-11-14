// DR3 ground truth: the IEM copy of the NWS CLI daily climate product, fetched by the HARNESS (public API, judge not consulted).
import { createHash } from "node:crypto";
import { parseIemCli, type CliDaily } from "../harness/parsers.js";

export type Op = ">=" | ">" | "<=" | "<";
export const nwsDirection = (op: Op): string => ({ ">=": "at or above", ">": "above", "<=": "at or below", "<": "below" })[op];
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** IEM afos retrieve.py returns products framed by \x01 ... \x03. */
export function splitProducts(text: string): string[] {
  const parts = text.split("\u0001").map((p) => p.replace(/\u0003[\s\S]*$/, "")).filter((p) => /CLIMATE SUMMARY FOR/.test(p));
  return parts.map((p) => "\u0001" + p);
}
/** Issue time of a product as a sortable number (local clock as printed; only compared within one station). */
function issuedKey(issued: string): number {
  const m = issued.match(/^(\d{3,4}) ([AP])M [A-Z]{3} [A-Z]{3} ([A-Z]{3}) (\d{1,2}) (\d{4})$/);
  if (!m) return 0;
  const hhmm = Number(m[1]), h = Math.floor(hhmm / 100) % 12 + (m[2] === "P" ? 12 : 0), mi = hhmm % 100;
  return Date.UTC(Number(m[5]), MON.indexOf(m[3]), Number(m[4]), h, mi);
}
export interface CliTruth extends CliDaily { outcome: "YES" | "NO"; rawSha256: string; products_seen: number; issuances_for_date: string[]; op: Op; x_f: number }
const decide = (op: Op, high: number, x: number): boolean => op === ">=" ? high >= x : op === ">" ? high > x : op === "<=" ? high <= x : high < x;

export function cliTruth(text: string, station: string, date: string, op: Op, x: number): CliTruth {
  const parsed = splitProducts(text).flatMap((raw) => { try { return [{ raw, p: parseIemCli(raw) }]; } catch { return []; } });
  const mine = parsed.filter((q) => q.p.station === "CLI" + station.slice(1));
  if (!mine.length) throw new Error(`no CLI product of station ${station} in the text (products: ${parsed.map((q) => q.p.station).join(",") || "none"})`);
  const forDate = mine.filter((q) => q.p.forDate === date).sort((a, b) => issuedKey(a.p.issued) - issuedKey(b.p.issued));
  if (!forDate.length) throw new Error(`no CLI product for ${station} ${date} (have ${mine.map((q) => q.p.forDate).join(",")})`);
  const last = forDate[forDate.length - 1];
  return { ...last.p, outcome: decide(op, last.p.highF, x) ? "YES" : "NO", rawSha256: createHash("sha256").update(last.raw).digest("hex"), products_seen: parsed.length, issuances_for_date: forDate.map((q) => q.p.issued), op, x_f: x };
}

/** Fetch the IEM copy (newest products first). Returns the raw text; the caller hashes + stores it. */
export async function fetchIemCli(station: string, limit = 8): Promise<string> {
  const url = `https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=CLI${station.slice(1)}&fmt=text&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`IEM ${r.status} for ${url}`);
  return r.text();
}
