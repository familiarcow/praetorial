import React from "react";
import { NETWORK } from "../../lib/network";
import { assetBadgeFor } from "../../lib/uiObjects";

/** Small asset label; an asset that is not live on this network says why. */
export function AssetBadge({ symbol, network = NETWORK.networkId, ...rest }: { symbol: string; network?: "testnet" | "mainnet"; [k: `data-${string}`]: unknown }) {
  const b = assetBadgeFor(symbol, network);
  return (
    <span {...(rest as object)} data-asset={symbol} data-enabled={b.enabled ? "1" : "0"} title={b.reason ?? `${b.decimals} decimals`}
      style={{ display: "inline-block", padding: "0 8px", borderRadius: 999, border: "1px solid #6b7280", fontSize: "0.85em", color: b.enabled ? "#1f2937" : "#4b5563" }}>
      {b.symbol}{b.reason ? " (mainnet only)" : ""}
    </span>
  );
}
