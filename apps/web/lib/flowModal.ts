// MODAL1a: pure state machine for FlowModal (no React/DOM, so it runs under `tsx --test`).
// One flow = ordered steps + a values bag + a phase. Money-moving flows end in success | pending | failure.

export type FlowValues = Record<string, string>;
export type FlowPhase = "editing" | "busy" | "success" | "pending" | "failure";

export interface FlowStep {
  id: string;
  title: string;
  /** Return a plain-words problem to block "Next", or null when the step is fine. */
  validate?: (values: FlowValues) => string | null;
}

export interface FlowState {
  index: number;
  values: FlowValues;
  phase: FlowPhase;
  error: string | null;
  reason: string | null;
  txHash: string | null;
  /** True once the user typed something or moved past step 1: closing then asks "Discard this?". */
  dirty: boolean;
}

export interface FlowDraft { v: 1; index: number; values: FlowValues }

export function initFlow(steps: FlowStep[], draft?: FlowDraft | null): FlowState {
  const base: FlowState = { index: 0, values: {}, phase: "editing", error: null, reason: null, txHash: null, dirty: false };
  if (!draft) return base;
  const index = Math.max(0, Math.min(steps.length - 1, Math.trunc(draft.index)));
  return { ...base, index, values: { ...draft.values }, dirty: true };
}

export function setValue(s: FlowState, key: string, value: string): FlowState {
  if (s.phase !== "editing") return s;
  return { ...s, values: { ...s.values, [key]: value }, error: null, dirty: true };
}

export function goNext(steps: FlowStep[], s: FlowState): FlowState {
  if (s.phase !== "editing") return s;
  const problem = steps[s.index]?.validate?.(s.values) ?? null;
  if (problem) return { ...s, error: problem };
  if (s.index >= steps.length - 1) return { ...s, error: null };
  return { ...s, index: s.index + 1, error: null, dirty: true };
}

export function goBack(s: FlowState): FlowState {
  if (s.phase !== "editing" || s.index === 0) return s;
  return { ...s, index: s.index - 1, error: null };
}

export function startBusy(s: FlowState): FlowState { return { ...s, phase: "busy", error: null, reason: null }; }
export function finishSuccess(s: FlowState, txHash: string | null = null): FlowState { return { ...s, phase: "success", txHash, error: null, reason: null }; }
export function finishPending(s: FlowState, txHash: string | null = null): FlowState { return { ...s, phase: "pending", txHash, error: null, reason: null }; }
export function finishFailure(s: FlowState, reason: string): FlowState { return { ...s, phase: "failure", reason }; }

/** Try again: back to editing on the last step, values kept. */
export function retryFlow(steps: FlowStep[], s: FlowState): FlowState {
  return { ...s, phase: "editing", reason: null, error: null, index: Math.max(0, steps.length - 1) };
}

export function isTerminal(s: FlowState): boolean { return s.phase === "success" || s.phase === "pending" || s.phase === "failure"; }

export function progressOf(steps: FlowStep[], s: FlowState): { current: number; total: number; percent: number } {
  const total = steps.length;
  if (s.phase === "success") return { current: total, total, percent: 100 };
  const current = s.index + 1;
  return { current, total, percent: Math.round((current / total) * 100) };
}

/** What a close request (Esc, overlay, X) should do right now. */
export function closeDecision(s: FlowState): "close" | "confirm-discard" | "blocked" {
  if (s.phase === "busy") return "blocked";
  if (s.phase === "editing" && s.dirty) return "confirm-discard";
  return "close";
}

// ---- resumable draft (sessionStorage; every call survives a missing/throwing storage) ----
export interface DraftStorage { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
const key = (k: string) => `flowdraft:${k}`;

/** Only an editing state is a draft. Busy/terminal states never persist (a half-sent tx must not be "resumed"). */
export function saveDraft(st: DraftStorage | null, k: string, s: FlowState): void {
  if (!st || s.phase !== "editing" || !s.dirty) return;
  try { st.setItem(key(k), JSON.stringify({ v: 1, index: s.index, values: s.values } satisfies FlowDraft)); } catch { /* storage full or blocked */ }
}

export function loadDraft(st: DraftStorage | null, k: string): FlowDraft | null {
  if (!st) return null;
  try {
    const raw = st.getItem(key(k));
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || d.v !== 1 || typeof d.index !== "number" || !Number.isFinite(d.index) || !d.values || typeof d.values !== "object") return null;
    return { v: 1, index: d.index, values: d.values as FlowValues };
  } catch { return null; }
}

export function clearDraft(st: DraftStorage | null, k: string): void {
  try { st?.removeItem(key(k)); } catch { /* ignore */ }
}

// ---- MODAL1c1: flows whose steps own their buttons (create bet) ----
/** Jump to a step (the step content decided to move, e.g. "Review offer" or "Edit"). Not while busy/terminal. */
export function goTo(steps: FlowStep[], s: FlowState, index: number): FlowState {
  if (s.phase !== "editing") return s;
  const i = Math.max(0, Math.min(steps.length - 1, Math.trunc(index)));
  return { ...s, index: i, error: null, dirty: true };
}

/** The submit ended without a result to show (declined, refused before sending): back to editing, same step, values kept. */
export function finishStay(s: FlowState): FlowState { return { ...s, phase: "editing", error: null, reason: null }; }
