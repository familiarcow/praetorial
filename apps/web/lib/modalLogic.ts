// MODAL1a: small pure helpers shared by the modal containers.

export type DismissReason = "esc" | "overlay" | "button";

/** Esc, overlay click and the close button all close, except while a tx is in flight. */
export function dismissAction(_why: DismissReason, o: { busy: boolean }): "close" | "ignore" {
  return o.busy ? "ignore" : "close";
}

type Focusable = { isConnected: boolean; focus(): void };

/** Give focus back to whatever opened the modal; fall back when it left the page. */
export function returnFocus(opener: Focusable | null, fallback: Focusable | null): boolean {
  const t = opener && opener.isConnected ? opener : fallback && fallback.isConnected ? fallback : null;
  if (!t) return false;
  t.focus();
  return true;
}

export function txExplorerUrl(network: "testnet" | "mainnet", hash: string): string | null {
  if (!hash) return null;
  const host = network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
  return `${host}/txns/${encodeURIComponent(hash)}`;
}

/** The test harness page exists only in dev builds (Vite sets DEV=false in `vite build`, so the branch is dead code there). */
export const HARNESS_PATH = "/__harness/modals";
export function harnessEnabled(env: { DEV?: boolean }, pathname: string): boolean {
  return env.DEV === true && pathname === HARNESS_PATH;
}
