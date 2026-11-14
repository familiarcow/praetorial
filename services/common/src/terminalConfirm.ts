// D-DSY1 (2): a TERMINAL outcome (Settled / Voided) is shown or announced only after a SECOND, independently configured
// RPC (rpcUrls[1]) returns the same state. The host-neutral logic lives in terminalConfirmCore.ts (shared with the CF1c2
// notifier Worker); this file re-exports it and keeps the node-only NearClient factory.
import { NearClient } from "./nearClient.js";
import type { ServiceConfig } from "./config.js";
import { secondRpcUrl } from "./terminalConfirmCore.js";
export * from "./terminalConfirmCore.js";

/** A view-only client pinned to rpcUrls[1] ONLY (no failover back to the primary: confirmation must come from a different
 * endpoint). null when fewer than two RPC URLs are configured. */
export function createSecondRpcClient(cfg: ServiceConfig): NearClient | null {
  const url = secondRpcUrl(cfg.rpcUrls);
  if (!url) return null;
  return new NearClient({ ...cfg, nodeUrl: url, rpcUrls: [url] }, { accountId: cfg.escrowContract, privateKey: "" });
}
