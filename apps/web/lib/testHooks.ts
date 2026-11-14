// NAV1 (LOGIN1 finding): the mocked-e2e window seams (__e2eTestWallet fakes a signed-in wallet; __e2eRegistryUrl, __e2eDepositApi,
// __e2eSourceCheckTimeoutMs, __e2eConfirm bend services and timings) are test/dev only. vite.config.ts defines __PRAETORIAL_TEST_HOOKS__
// (lib/networkSelect.ts testHooksOn): `false` in a mainnet production build, so TEST_HOOKS_ENABLED folds to `false`, each getter below
// returns undefined and Rollup drops the window read: the bundle never names a seam, and a page that sets one gets the normal
// logged-out app. The dev server (mocked Playwright specs), testnet builds and node/tests keep them.
// Every seam is read ONLY through these getters (tests/testHooks.unit.test.ts checks the sources); scripts/mainnetDeployGuard.ts
// refuses a bundle that still names one (REFUSED_SEAMS).
declare const __PRAETORIAL_TEST_HOOKS__: boolean | undefined;
export const TEST_HOOKS_ENABLED: boolean = typeof __PRAETORIAL_TEST_HOOKS__ === "undefined" || __PRAETORIAL_TEST_HOOKS__ === true;

type W = Record<string, any>;
const w = (): W | undefined => (typeof window === "undefined" ? undefined : (window as unknown as W));

export interface TestWallet { nearAddress: string; signRawHash: (address: string, hashHex: string) => Promise<string> }
/** A mocked spec's stand-in for a signed-in Privy NEAR wallet. */
export function e2eTestWallet(): TestWallet | undefined { return TEST_HOOKS_ENABLED ? w()?.__e2eTestWallet : undefined; }
/** Points the username registry client at a mocked service. */
export function e2eRegistryUrl(): string | undefined { return TEST_HOOKS_ENABLED ? w()?.__e2eRegistryUrl : undefined; }
/** Turns the (mainnet-only) deposit-address API on in a testnet dev run. */
export function e2eDepositApi(): boolean { return TEST_HOOKS_ENABLED ? w()?.__e2eDepositApi === true : false; }
/** Shortens the source-check timeout. */
export function e2eSourceCheckTimeoutMs(): number | undefined { return TEST_HOOKS_ENABLED ? w()?.__e2eSourceCheckTimeoutMs : undefined; }
/** Shortens the Open read-back polling. */
export function e2eConfirm(): { delayMs?: number; attempts?: number } | undefined { return TEST_HOOKS_ENABLED ? w()?.__e2eConfirm : undefined; }
/** SECREV1 SR-3: the window.__e2e signer signs ANY hash with the user's key (an XSS or extension could drain the account), so it
 * exists only where the hooks are on; a mainnet production build gets {} and the deploy guard refuses "__e2eSignSeam". */
export function e2eSignSeam<F>(f: F): { signRawHash?: F; __e2eSignSeam?: true } {
  return TEST_HOOKS_ENABLED ? { signRawHash: f, __e2eSignSeam: true } : {};
}
/** TFIX2: forces a render error so a spec can see the top-level crash screen: "app" (App), "bet-page" (BetPage), "taken-by-me"
 * (BetPage, once the viewer is the taker: the mainnet bet #1 incident). */
export function e2eRenderCrash(): "app" | "bet-page" | "taken-by-me" | undefined { return TEST_HOOKS_ENABLED ? w()?.__e2eRenderCrash : undefined; }
/** The event a mocked spec fires after swapping the test wallet in. */
export function onE2eWalletChanged(f: () => void): () => void {
  if (!TEST_HOOKS_ENABLED || typeof window === "undefined") return () => {};
  window.addEventListener("e2e-wallet-changed", f);
  return () => window.removeEventListener("e2e-wallet-changed", f);
}
