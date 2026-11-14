// F5 (FUND4 SPEC §5.5, familiarcow UX-37 FUND 12 "Convert only into the 6", SM2 STATES.md M7), mocked: Convert end to end on the
// stand-in Worker (tests/funding/withdraw-mock.ts; real NEP-413 payloads, real ed25519 signature). A "Not usable for bets yet"
// row (USDC on Ethereum) -> Convert -> only the 6 bet tokens offered (default: the same token) -> estimate -> the user signs ->
// "added to your betting balance"; a bet token converts from its sheet into another of the 6; 375 px, axe, screenshots.
import { type Page } from "@playwright/test"; import { test, expect } from "../e2eGuard";
import AxeBuilder from "@axe-core/playwright";
import { hashNep413Payload } from "../../lib/funding/intentCheck";
import { mockF5, ready, ME, ID } from "./withdraw-mock";

const SHOTS = process.env.F5_SHOTS === "1" ? "../../spikes/f5/shots" : "test-results/screens/f5";
const sheet = (page: Page) => page.getByTestId("convert-sheet");
async function noSeriousAxe(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  const r = await new AxeBuilder({ page }).include("[data-testid=convert-sheet]").analyze();
  expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.html?.slice(0, 120)}`)).toEqual([]);
}
const ONE_USDC = (b: any) => (b.originAsset === ID.ETH_USDC ? { amountOut: "999800", minAmountOut: "989802", timeEstimateSec: 10, withdrawFee: "0" } : {});

test.describe("F5 Convert", () => {
  test.use({ viewport: { width: 375, height: 812 } });
  for (const [name, size] of [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 900 }]] as const) {
    test(`${name}px: stray USDC (Ethereum) -> Convert into USDC (only the 6) -> estimate -> the user signs -> added to the betting balance`, async ({ page }) => {
      await page.setViewportSize(size);
      const { worker, signs } = await mockF5(page, { stray: { [ID.ETH_USDC]: "1000000" } }, { quote: ONE_USDC });
      await page.goto("/account"); await ready(page);
      const row = page.locator(`[data-testid=stray-row][data-asset="${ID.ETH_USDC}"]`);
      await expect(row.getByTestId("stray-convert")).toHaveText("Convert to USDC");
      await row.getByTestId("stray-convert").click();
      await expect(sheet(page).getByTestId("cv-title")).toHaveText("Convert 1.00 USDC (Ethereum)");
      await expect(sheet(page).getByRole("radio")).toHaveText(["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"]);
      await expect(sheet(page).getByTestId("cv-to-USDC")).toHaveAttribute("aria-checked", "true");
      await expect(sheet(page).getByTestId("cv-amount")).toHaveValue("1");
      await expect(sheet(page).getByTestId("cv-you-get")).toHaveText("You'll get ≈ 0.99 USDC · about 10 s");
      const dry = worker.calls.filter((c) => c.path === "/withdraw/quote");
      expect(dry.at(-1)!.body).toEqual({ account: ME, kind: "convert", originAsset: ID.ETH_USDC, amountIn: "1000000", destinationAsset: ID.USDC, dry: true }); // no recipient: always the user's own balance
      await noSeriousAxe(page);
      await page.screenshot({ path: `${SHOTS}/f5-convert-${name}.png`, fullPage: true });
      await sheet(page).getByTestId("cv-confirm").click();
      await expect(sheet(page).getByTestId("co-track-message")).toHaveText("Converting 1.00 USDC (Ethereum) to USDC…");
      const rec = [...worker.recs.values()][0]!;
      expect(signs).toEqual([Buffer.from(hashNep413Payload(rec.payload)).toString("hex")]);
      expect(rec.submitted).toBe(true);
      await expect(sheet(page).getByTestId("co-track-message")).toHaveText("0.99 USDC added to your betting balance.", { timeout: 20_000 });
      await noSeriousAxe(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
      await page.screenshot({ path: `${SHOTS}/f5-converted-${name}.png`, fullPage: true });
      await sheet(page).getByTestId("co-cta-done").click();
      await expect(sheet(page)).toHaveCount(0);
    });
  }

  test("a bet token converts from its sheet into another of the 6 (never itself); too small says the minimum", async ({ page }) => {
    const { worker } = await mockF5(page, {}, { tooLow: "1218977" });
    await page.goto("/account"); await ready(page);
    await page.getByTestId("asset-row-USDC").click();
    await page.getByTestId("token-convert-USDC").click();
    await expect(sheet(page).getByTestId("cv-title")).toHaveText("Convert 42.10 USDC");
    await expect(sheet(page).getByRole("radio")).toHaveText(["USDT", "NEAR", "BTC", "ETH", "ZEC"]);
    await expect(sheet(page).getByTestId("cv-amount")).toHaveValue(""); // a bet token: never pre-filled with the whole balance
    await sheet(page).getByTestId("cv-amount").fill("1");
    await expect(sheet(page).getByTestId("cv-error")).toHaveText("Too small to convert. Minimum is 1.22 USDC.");
    await expect(sheet(page).getByTestId("cv-confirm")).toBeDisabled();
    expect(worker.calls.filter((c) => c.path === "/withdraw/quote").every((c) => c.body.destinationAsset === ID.USDT)).toBe(true);
  });

  test("the user cancels in the wallet: nothing converted", async ({ page }) => {
    const { worker } = await mockF5(page, { stray: { [ID.ETH_USDC]: "1000000" }, refuse: true }, { quote: ONE_USDC });
    await page.goto("/account"); await ready(page);
    await page.getByTestId("stray-convert").click();
    await expect(sheet(page).getByTestId("cv-you-get")).toBeVisible();
    await sheet(page).getByTestId("cv-confirm").click();
    await expect(sheet(page).getByTestId("cv-error")).toHaveText("You cancelled. Nothing was sent.");
    expect(worker.signedSubmits()).toBe(0);
  });
});
