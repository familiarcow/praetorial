import React from "react";
import { statusPillFor, type Tone } from "../../lib/uiObjects";

const COLORS: Record<Tone, { fg: string; bg: string }> = {
  neutral: { fg: "#374151", bg: "#f3f4f6" }, info: { fg: "#1e40af", bg: "#dbeafe" }, warn: { fg: "#92400e", bg: "#fef3c7" },
  good: { fg: "#166534", bg: "#dcfce7" }, bad: { fg: "#991b1b", bg: "#fee2e2" },
};

/** Plain-words status for any contract BetStatus (all 12). Renders the label; the sentence is `StatusPill.sentence()` for callers that show it. */
export function StatusPill({ status, referee, chip, ...rest }: { status: string; referee?: string | null; /** a chip the caller already computed (lib/liveBet.statusChip) */ chip?: { id: string; label: string }; [k: `data-${string}`]: unknown }) {
  const base = statusPillFor(status, referee);
  const p = chip ? { ...base, id: chip.id as typeof base.id, label: chip.label } : base;
  const c = COLORS[p.tone];
  return <span {...(rest as object)} data-chip={p.id} data-tone={p.tone} style={{ display: "inline-block", padding: "2px 10px", borderRadius: 999, color: c.fg, background: c.bg, fontWeight: 600 }}>{p.label}</span>;
}
