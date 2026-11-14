import React from "react";
import { feeBreakdown } from "../../lib/uiObjects";

/** Stake, fee and tip lines plus the exact total, from the contract's fee rule (lib/stakeDeadlines.sideFee). */
export function FeeBreakdown({ symbol, stakeUnits, feeBps, minFeePerSide, tipUnits, ...rest }: { symbol: string; stakeUnits: bigint; feeBps: number; minFeePerSide: bigint; tipUnits?: bigint; [k: `data-${string}`]: unknown }) {
  const b = feeBreakdown({ symbol, stakeUnits, feeBps, minFeePerSide, tipUnits });
  return (
    <dl {...(rest as object)} style={{ margin: 0 }}>
      {b.rows.map((r) => <div key={r.id} data-row={r.id} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><dt>{r.label}</dt><dd style={{ margin: 0 }}>{r.text}</dd></div>)}
      <div data-row="total" style={{ display: "flex", justifyContent: "space-between", gap: 12, fontWeight: 600 }}><dt>Total you put in</dt><dd style={{ margin: 0 }}>{b.totalText}</dd></div>
    </dl>
  );
}
