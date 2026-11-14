// LOGIN1 (UX-29): logged out, every route renders only the login page. Mocked specs that test app screens sign in first via
// the window.__e2eTestWallet seam (see App.tsx), installed before the app loads.
import { type Page } from "@playwright/test";

export const SEAM_SIGNATURE_HEX = "22".repeat(64);

/** Signed in, but the NEAR wallet is still being set up (nearAddress null): the app renders, BetPage gets no wallet.
 * The stand-in for the old logged-out "public read" specs (a viewer who can see but not sign). */
export async function signInNoWallet(page: Page) {
  await page.addInitScript(() => {
    (window as any).__e2eTestWallet = { nearAddress: null, signRawHash: async () => { throw new Error("no wallet"); } };
  });
}
