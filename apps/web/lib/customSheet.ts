// The custom (non-template) sheet the web form emits. WT1b (d): it is linted with the resolver's custom lint
// (lib/customLint.ts) before anything is opened; fields the form cannot yet supply surface as the resolver's named errors.
import type { TermSheet } from "./termSheet";

export function customSheetFrom(ts: Pick<TermSheet, "claimText" | "sources" | "deadlineUtcIso">) {
  return {
    claim: ts.claimText,
    sources_allowed: ts.sources.filter((s) => s.venue.trim()).map((s, i) => ({ id: `S${i + 1}`, publisher: `${s.venue} ${s.pair}`.trim() })),
    time: { window_end: ts.deadlineUtcIso },
  };
}
