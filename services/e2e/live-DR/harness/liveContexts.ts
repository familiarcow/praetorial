// DR0 part 4: the three rehearsal browser identities and the test-wallet seam installer. No env value is read here
// beyond non-secret account ids (DR_*_ACCOUNT); nothing is logged or written; no login code is ever referenced.
export const SEAM = "__e2eTestWallet";

export type Role = "maker" | "taker" | "referee";
export interface ContextSpec { role: Role; /** maker signs in through Privy for real; taker/referee use the app's test-wallet seam */ wallet: "privy" | "e2eTestWallet"; accountEnv: string }

export const CONTEXTS: ContextSpec[] = [
  { role: "maker", wallet: "privy", accountEnv: "DR_MAKER_ACCOUNT" },
  { role: "taker", wallet: "e2eTestWallet", accountEnv: "DR_TAKER_ACCOUNT" },
  { role: "referee", wallet: "e2eTestWallet", accountEnv: "DR_REFEREE_ACCOUNT" },
];

/**
 * Init script (page.addInitScript / context.addInitScript) that installs window.__e2eTestWallet BEFORE the app loads,
 * matching apps/web/src/App.tsx: { nearAddress, signRawHash(address, hashHex) => Promise<hex signature> }.
 * Signing is delegated to a binding the spec exposes in Node (context.exposeBinding("__drSign", ...)), so no key
 * material is ever placed in page-visible script text.
 */
export function testWalletInitScript(nearAddress: string): string {
  return `(() => {
  window.${SEAM} = {
    nearAddress: ${JSON.stringify(nearAddress)},
    signRawHash: (address, hashHex) => window.__drSign(address, hashHex),
  };
  window.dispatchEvent(new Event("e2e-wallet-changed"));
})();`;
}
