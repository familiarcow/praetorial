import React from "react";
import { NETWORK } from "../../lib/network";
import { txExplorerUrl } from "../../lib/modalLogic";

/** Link to a transaction on the NEAR explorer for the build's network. Renders nothing without a hash. */
export function TxLink({ hash, network = NETWORK.networkId, testId = "tx-link" }: { hash: string | null | undefined; network?: "testnet" | "mainnet"; testId?: string }) {
  const href = hash ? txExplorerUrl(network, hash) : null;
  if (!href || !hash) return null;
  const short = hash.length > 14 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
  return <a data-testid={testId} style={{ textDecoration: "underline" }} href={href} target="_blank" rel="noopener noreferrer">View transaction {short} on the explorer (opens a new tab)</a>;
}
