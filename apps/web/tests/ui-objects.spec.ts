// MODAL1b: the shared UI objects in the dev-only harness. Fully mocked (no chain, no Privy).
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./e2eGuard";
import { screenPath } from "./lib/screens";

const URL = "/__harness/modals";
const ALL = ["Open", "Taken", "Resolving", "Proposed", "Challenged", "Evidence", "Rejudge", "Finalized", "Settled", "Voided", "Cancelled", "Expired"];
const LABELS = ["Open", "Live", "Ruling in progress", "Ruling made", "Challenged", "Collecting evidence", "Second look", "Paying out", "Done", "Refunded", "Cancelled", "Expired"];

test.beforeEach(async ({ page }) => { await page.goto(URL); await expect(page.getByTestId("objects")).toBeVisible(); });

test("objects: amounts for all six assets keep every digit", async ({ page }) => {
  const want: Record<string, string> = { USDC: "1.5 USDC", USDT: "10 USDT", // NAV1 (UX-31): token units, never "$"
    BTC: "0.12345678 BTC", ZEC: "1 ZEC", ETH: "1.000000000000000001 ETH", NEAR: "1.000000000000000000000001 NEAR" };
  for (const [s, t] of Object.entries(want)) await expect(page.getByTestId(`amount-${s}`)).toHaveText(t);
  await expect(page.getByTestId("badge-btc-testnet")).toContainText("mainnet only");
});

test("objects: a pill for every contract status", async ({ page }) => {
  for (let i = 0; i < ALL.length; i++) await expect(page.getByTestId(`pill-${ALL[i]}`)).toHaveText(LABELS[i]);
  await expect(page.getByTestId("pill-sentence")).toContainText("judge-account");
});

test("objects: countdown, fee breakdown, empty, error, toast", async ({ page }) => {
  await expect(page.getByTestId("countdown-fixed")).toHaveText("3h 5m");
  await expect(page.getByTestId("countdown-done")).toHaveText("0:00");
  const fee = page.getByTestId("fee");
  await expect(fee).toContainText("100.00 USDC");
  await expect(fee).toContainText("1.00 USDC");
  await expect(fee.locator('[data-row="total"]')).toContainText("101.00 USDC");
  await expect(page.getByTestId("empty")).toContainText("You haven't made a bet yet.");
  await expect(page.getByTestId("error-notice")).toHaveAttribute("role", "alert");
  await page.getByTestId("open-toast").click();
  await expect(page.getByTestId("toast")).toHaveText(/Link copied/);
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByTestId("toast")).toHaveCount(0);
});

test("objects: axe 0 serious/critical; screenshots at 375 and 1280", async ({ page }) => {
  for (const [w, h] of [[1280, 900], [375, 800]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
    const r = await new AxeBuilder({ page }).analyze();
    const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${v.id}: ${v.nodes[0]?.html?.slice(0, 140)}`)).toEqual([]);
    await page.getByTestId("objects").screenshot({ path: screenPath(`modal1b/objects-${w}.png`) });
  }
});
