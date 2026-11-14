// A1 (UIR1 §3.9): the "Pick a username" sheet's words and enablement, pure (tsx --test). src/components/UsernameStep.tsx renders it.
// One title (no "1. Username" step label, no progress bar), one live availability line, the rules collapsed under "Rules" and opened
// by themselves only when the typed name breaks one. The registry's /claim answer stays the authority (a "taken" there is shown too).
import { claimErrorMessage, normalizeUsername, validateUsername, type Availability } from "./username";

export const USERNAME_SHEET_TITLE = { pick: "Pick a username", change: "Change username" } as const;

export type SheetStatus = { kind: "idle" } | { kind: "checking" } | { kind: "local"; text: string } | { kind: "avail"; a: Availability; name: string };
export interface SheetView { title: string; line: string; tone: "good" | "bad" | "muted"; rulesOpen: boolean; canSave: boolean; saveLabel: string }

export function usernameSheetView(p: { raw: string; status: SheetStatus; busy: boolean; current: string | null }): SheetView {
  const rename = p.current != null;
  const name = normalizeUsername(p.raw);
  const same = rename && name === p.current!.toLowerCase();
  const s = p.status;
  let line = "", tone: SheetView["tone"] = "muted";
  if (s.kind === "checking") line = "Checking…";
  else if (s.kind === "local") { line = s.text; tone = "bad"; }
  else if (same) line = "That is already your username.";
  else if (s.kind === "avail") {
    const a = s.a;
    if (a.state === "free") { line = `@${s.name} is available`; tone = "good"; }
    else if (a.state === "taken") { line = claimErrorMessage({ ok: false, error: "username_taken" }, s.name).message; tone = "bad"; }
    else if (a.state === "lookalike") { line = `That name looks too much like @${a.of}. Pick a different one.`; tone = "bad"; }
    else if (a.state === "unknown") line = "We couldn't check that name right now. You can still try to save it.";
  }
  const canSave = !p.busy && !same && validateUsername(name) === null && s.kind === "avail" && (s.a.state === "free" || s.a.state === "unknown");
  return {
    title: rename ? USERNAME_SHEET_TITLE.change : USERNAME_SHEET_TITLE.pick,
    line, tone,
    rulesOpen: s.kind === "local",
    canSave,
    saveLabel: p.busy ? "Saving…" : rename ? "Change username" : "Save username",
  };
}
