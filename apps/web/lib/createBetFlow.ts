// MODAL1c1: pure helpers for the create-bet FlowModal (no React, runs under `tsx --test`).
import type { FlowStep } from "./flowModal";

export type CreateStepId = "type" | "fill" | "resolver" | "review";
// C1 (UIR1 §3.4): short labels that fit one line at 375 px; step 3 also holds who decides (and More options).
export const CREATE_STEPS: FlowStep[] = [
  { id: "type", title: "Type" },
  { id: "fill", title: "Details" },
  { id: "resolver", title: "Stake & who decides" },
  { id: "review", title: "Review" },
];
const IDS: CreateStepId[] = ["type", "fill", "resolver", "review"];

export const stepIndexFor = (id: CreateStepId): number => IDS.indexOf(id);
export const stepForIndex = (i: number): CreateStepId => IDS[Math.max(0, Math.min(IDS.length - 1, Math.trunc(i)))];

/** The form draft rides in the flow's string values bag as JSON. */
export function encodeCreateDraft(d: unknown): string { return JSON.stringify(d); }
export function decodeCreateDraft<T extends { step: string }>(raw: string | undefined | null): T | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d !== "object" || !IDS.slice(0, 3).includes(d.step)) return null;
    return d as T;
  } catch { return null; }
}
