// CS1: the question of a bet in plain words, from the signed terms the web actually writes. Typed templates carry only
// {template, fields} (the resolver renders the full claim, sources and rules from the fields: resolver/core/src/template.rs
// materialize); custom sheets carry `claim`; very old sheets carried `claimText`. Null = unreadable (never a hash, BROWSE1b).
// Short card wording only: the exact resolver claim belongs in the bet's Details.
import { lintTemplate } from "./templates";
import { cityLabel } from "./nwsCities";

const usd = (n: number): string => `$${n.toLocaleString("en-US")}`;
const utc = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const CLOSE_OP: Record<string, string> = { ">=": "at or above", ">": "above", "<=": "at or below", "<": "below" };

/** The plain-words question for a parsed terms object, or null. */
export function questionFromTerms(t: any): string | null {
  if (!t || typeof t !== "object") return null;
  for (const k of ["claimText", "claim"]) if (typeof t[k] === "string" && t[k].trim()) return t[k].trim();
  const id = t.template?.id;
  if (typeof id !== "string" || lintTemplate(t).length) return null;
  const f = t.fields;
  switch (id) {
    case "btc_close_at_t": return `Bitcoin's 1-minute close at ${utc(f.t_utc)} is ${CLOSE_OP[f.op]} ${usd(f.x_usd)}`;
    case "btc_touch": return `Bitcoin touches ${usd(f.x_usd)} or ${f.direction === "at_or_above" ? "higher" : "lower"} before ${utc(f.deadline_utc)}`;
    case "game_winner": return `${f.pick.name} win their ${f.league} game on ${f.scheduled_date}`;
    case "nws_daily_high": return `The official NWS high in ${cityLabel(f.station)} on ${f.date} is ${f.x_f}°F or ${f.op === ">=" ? "warmer" : "cooler"}`;
  }
  return null;
}
