// WEBDEP1 @deployed: read-only smoke against the live testnet preview. No Privy login, no signing, no writes.
import { test, expect, type Page } from "@playwright/test";
import { type IndexerOfferSummary } from "../../lib/indexerClient";
import { keepOffers, BROWSE_EMPTY } from "../../lib/browseCards";
import { ESCROW_CONTRACT_ID } from "../../lib/config";

const baseOrigin = process.env.DEPLOYED_URL!; // the page reaches the indexer through the Worker proxy (indexer sends no CORS headers)

function watch(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  return errors;
}
// LOGIN1 (UX-29): logged out, every route is only the login page; read-only checks of app screens use the wallet seam with
// no NEAR wallet (signed-in look, nothing can sign).
const seeAppReadOnly = (page: Page) => page.addInitScript(() => { (window as any).__e2eRegistryUrl = ""; (window as any).__e2eTestWallet = { nearAddress: null, signRawHash: async () => { throw new Error("smoke is read-only"); } }; });
const ready = (page: Page) => page.waitForFunction(() => (window as any).__e2e?.ready === true, undefined, { timeout: 30_000 });

test.describe("@deployed testnet preview smoke", () => {
  test("@deployed logged out: only the login page (email step), no console errors", async ({ page }) => {
    const errors = watch(page);
    await page.goto("/");
    await ready(page);
    await expect(page.getByTestId("login-gate")).toBeVisible();
    await expect(page.getByTestId("email-input")).toBeVisible();
    await expect(page.getByTestId("otp-input")).toHaveCount(0);
    await expect(page.getByTestId("landing")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("@deployed landing loads with no console errors (read-only seam)", async ({ page }) => {
    const errors = watch(page);
    await seeAppReadOnly(page);
    await page.goto("/");
    await ready(page);
    await expect(page.getByTestId("landing")).toBeVisible();
    await expect(page.getByTestId("landing-pitch")).toHaveText("Trustless AI Escrow");
    await expect(page.getByTestId("how-it-works")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("@deployed SPA fallback serves deep links (logged out: the login page, URL kept)", async ({ page }) => {
    await page.goto("/browse");
    await ready(page);
    await expect(page.getByTestId("login-gate")).toBeVisible();
    await expect(page).toHaveURL(/\/browse$/);
  });

  test("@deployed bet types list renders (read-only wallet seam, no login)", async ({ page }) => {
    const errors = watch(page);
    await page.addInitScript(() => { (window as any).__e2eRegistryUrl = ""; /* same seam as the mocked suite: skip the username gate */ (window as any).__e2eTestWallet = { nearAddress: "11".repeat(32), signRawHash: async () => { throw new Error("smoke is read-only"); } }; });
    await page.goto("/new");
    await ready(page);
    await expect(page.getByTestId("bet-type-picker")).toBeVisible();
    expect(await page.locator('[data-testid^="bet-type-card-"]').count()).toBeGreaterThan(1);
    expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
  });

  test("@deployed browse shows the indexer's open bets", async ({ page }) => {
    const errors = watch(page);
    await seeAppReadOnly(page);
    const offers = page.waitForResponse((r) => r.url() === `${baseOrigin}/_proxy/indexer/offers` && r.request().method() === "GET");
    await page.goto("/browse");
    const res = await offers;
    expect(res.status()).toBe(200);
    const list = (await res.json()) as IndexerOfferSummary[];
    expect(Array.isArray(list)).toBe(true);
    await expect(page.getByTestId("browse-page")).toBeVisible();
    // BROWSE1: Browse shows only untargeted rows of THIS build's escrow contract, and drops any row whose get_bet fails, so the
    // visible set is a subset of keepOffers(); every visible card must be readable (no raw hex, base units or ISO dates).
    const expected = keepOffers(list, ESCROW_CONTRACT_ID);
    await expect(page.getByTestId("offers-status").filter({ hasText: /couldn.t load|failed/i })).toHaveCount(0);
    await expect(page.getByTestId("offers-status").filter({ hasText: /Loading/ })).toHaveCount(0, { timeout: 30_000 }); // get_bet per row is live RPC
    const rows = page.locator('[data-testid^="offer-row-"]');
    const shown = await rows.count();
    expect(shown).toBeLessThanOrEqual(expected.length);
    if (shown === 0) await expect(page.getByTestId("offers-status")).toHaveText(BROWSE_EMPTY);
    else {
      // H1: the kit UserChip's decorative initial ("?" for an unnamed person) is aria-hidden; read the text without it.
      const text = await page.getByTestId("open-offers-list").evaluate((el) => { const c = el.cloneNode(true) as HTMLElement; c.querySelectorAll("[aria-hidden=true]").forEach((n) => n.remove()); document.body.appendChild(c); const t = c.innerText; c.remove(); return t; });
      expect(text).not.toMatch(/\?|terms unavailable|\d{8,}|\d{4}-\d{2}-\d{2}T|[0-9a-f]{40,}|\.near\b|\.testnet\b/);
    }
    expect(errors).toEqual([]);
  });
});
