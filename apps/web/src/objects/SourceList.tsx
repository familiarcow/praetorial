import React from "react";

/** The sources a bet is judged from. */
export function SourceList({ sources, ...rest }: { sources: Array<{ venue: string; pair?: string }>; [k: `data-${string}`]: unknown }) {
  return <ul {...(rest as object)}>{sources.map((s, i) => <li key={`${s.venue}${s.pair ?? ""}${i}`}>{s.venue}{s.pair ? ` ${s.pair}` : ""}</li>)}</ul>;
}
