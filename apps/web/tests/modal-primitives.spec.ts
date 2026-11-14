// MODAL1a: Modal / Drawer / ConfirmDialog / FlowModal driven through the dev-only harness page. Fully mocked (no chain, no Privy).
import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { screenPath } from "./lib/screens";

const URL = "/__harness/modals";
const dlg = (p: Page) => p.locator("dialog[open]").last();

async function noSeriousAxe(page: Page) {
  // Entrance animations fade opacity; axe's colour-contrast reads a half-faded Close button as low contrast. Check the settled UI.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  const r = await new AxeBuilder({ page }).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes[0]?.html?.slice(0, 120)}`)).toEqual([]);
}

test.beforeEach(async ({ page }) => { await page.goto(URL); await expect(page.getByTestId("harness")).toBeVisible(); });

test("Modal: role/aria, Esc closes, focus returns to the opener", async ({ page }) => {
  const opener = page.getByTestId("open-modal");
  await opener.click();
  const d = dlg(page);
  await expect(d).toBeVisible();
  await expect(d).toHaveAttribute("aria-modal", "true");
  const labelled = await d.getAttribute("aria-labelledby");
  expect(labelled).toBeTruthy();
  await expect(page.locator(`#${labelled}`)).toHaveText(/Example modal/);
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("Modal: overlay click closes", async ({ page }) => {
  await page.getByTestId("open-modal").click();
  await expect(dlg(page)).toBeVisible();
  await page.mouse.click(4, 4); // far corner = backdrop
  await expect(page.locator("dialog[open]")).toHaveCount(0);
});

test("Modal: Tab stays trapped inside; body scroll is locked", async ({ page }) => {
  await page.getByTestId("open-modal").click();
  const d = dlg(page);
  await expect(d).toBeVisible();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("dialog[open]"))).toBe(true);
  }
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("dialog[open]"))).toBe(true);
  }
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe("hidden");
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe("hidden");
});

test("Modal: centered on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId("open-modal").click();
  // the entrance animation scales from 0.95, so wait for the settled box
  await expect.poll(async () => { const b = (await dlg(page).boundingBox())!; return Math.abs(b.x + b.width / 2 - 640) < 4; }).toBe(true);
  expect((await dlg(page).boundingBox())!.y).toBeGreaterThan(20);
  await page.screenshot({ path: screenPath("modal1a/modal-1280.png") });
});

test("Modal: bottom sheet at 375px (pinned to the bottom, full width)", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await page.getByTestId("open-modal").click();
  const d = dlg(page);
  await expect(d).toBeVisible();
  await expect(page.getByTestId("modal-surface")).toHaveAttribute("data-presentation", "sheet");
  await expect.poll(async () => { const b = (await d.boundingBox())!; return b.width > 370 && Math.abs(b.y + b.height - 700) < 4; }).toBe(true);
  await page.screenshot({ path: screenPath("modal1a/modal-375.png") });
  await noSeriousAxe(page);
});

test("Modal: busy blocks Esc, overlay and the close button; works again after", async ({ page }) => {
  await page.getByTestId("open-busy-modal").click();
  await expect(dlg(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.click(4, 4);
  await expect(dlg(page)).toBeVisible();
  await expect(page.getByTestId("modal-close")).toBeDisabled();
  await page.getByTestId("busy-done").click();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
});

test("Drawer: opens, Esc closes, focus returns, axe clean", async ({ page }) => {
  const opener = page.getByTestId("open-drawer");
  await opener.click();
  const d = dlg(page);
  await expect(d).toBeVisible();
  await expect(d).toHaveAttribute("aria-modal", "true");
  await expect(d).toHaveAttribute("aria-labelledby", /.+/);
  await noSeriousAxe(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("ConfirmDialog: cancel and confirm fire once; destructive variant; axe clean", async ({ page }) => {
  await page.getByTestId("open-confirm").click();
  await expect(dlg(page)).toContainText("Cancel this offer?");
  await noSeriousAxe(page);
  await page.getByTestId("confirm-cancel").click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.getByTestId("confirm-log")).toHaveText("cancelled:1 confirmed:0");
  await page.getByTestId("open-confirm").click();
  await page.getByTestId("confirm-ok").click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.getByTestId("confirm-log")).toHaveText("cancelled:1 confirmed:1");
});

test("FlowModal: validation gate, back/next, progress", async ({ page }) => {
  await page.getByTestId("open-flow").click();
  await expect(page.getByTestId("flow-progress")).toHaveAttribute("aria-valuenow", "1");
  await page.getByTestId("flow-next").click();
  await expect(page.getByTestId("flow-error")).toHaveText("Enter an amount above zero.");
  await page.getByTestId("flow-input").fill("5");
  await page.getByTestId("flow-next").click();
  await expect(page.getByTestId("flow-progress")).toHaveAttribute("aria-valuenow", "2");
  await page.getByTestId("flow-back").click();
  await expect(page.getByTestId("flow-input")).toHaveValue("5");
  await noSeriousAxe(page);
});

test("FlowModal: discard guard on close mid-flow; keep editing and discard both work; discard clears the draft", async ({ page }) => {
  await page.getByTestId("open-flow").click();
  await page.getByTestId("flow-input").fill("5");
  await page.keyboard.press("Escape");
  await expect(page.getByText("Discard this?")).toBeVisible();
  await noSeriousAxe(page);
  await page.getByTestId("discard-keep").click();
  await expect(page.getByTestId("flow-input")).toHaveValue("5");
  await page.keyboard.press("Escape");
  await page.getByTestId("discard-confirm").click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.getByTestId("open-flow").click();
  await expect(page.getByTestId("flow-input")).toHaveValue("");
});

test("FlowModal: draft resumes after the modal is closed and the page reloaded (sessionStorage)", async ({ page }) => {
  await page.getByTestId("open-flow").click();
  await page.getByTestId("flow-input").fill("7");
  await page.getByTestId("flow-next").click();
  await page.reload();
  await page.getByTestId("open-flow").click();
  await expect(page.getByTestId("flow-progress")).toHaveAttribute("aria-valuenow", "2");
  await page.getByTestId("flow-back").click();
  await expect(page.getByTestId("flow-input")).toHaveValue("7");
});

test("FlowModal: success shows a TxLink to the explorer and clears the draft", async ({ page }) => {
  await page.getByTestId("open-flow").click();
  await page.getByTestId("flow-input").fill("5");
  await page.getByTestId("flow-next").click();
  await page.getByTestId("flow-submit").click();
  await expect(page.getByTestId("flow-success")).toBeVisible();
  await expect(page.getByTestId("tx-link")).toHaveAttribute("href", "https://testnet.nearblocks.io/txns/HARNESSHASH1");
  await expect(page.getByTestId("tx-link")).toHaveAttribute("target", "_blank");
  await noSeriousAxe(page);
  await page.keyboard.press("Escape"); // terminal: closes with no guard
  await expect(page.locator("dialog[open]")).toHaveCount(0);
});

test("FlowModal: submit is busy (close blocked), failure shows a plain reason and Try again returns with values kept", async ({ page }) => {
  await page.getByTestId("harness-mode").selectOption("fail");
  await page.getByTestId("open-flow").click();
  await page.getByTestId("flow-input").fill("5");
  await page.getByTestId("flow-next").click();
  await page.getByTestId("flow-submit").click();
  await expect(page.getByTestId("flow-busy")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("flow-busy")).toBeVisible(); // Esc ignored while in flight
  await page.evaluate(() => (window as any).__harnessRelease()); // page behind a modal is inert, so no button click
  await expect(page.getByTestId("flow-failure")).toContainText("Nothing was spent");
  await noSeriousAxe(page);
  await page.getByTestId("flow-retry").click();
  await expect(page.getByTestId("flow-submit")).toBeVisible();
  await page.getByTestId("flow-back").click();
  await expect(page.getByTestId("flow-input")).toHaveValue("5");
});

test("FlowModal: pending-on-chain step shows the TxLink and a plain 'still confirming' line", async ({ page }) => {
  await page.getByTestId("harness-mode").selectOption("pending");
  await page.getByTestId("open-flow").click();
  await page.getByTestId("flow-input").fill("5");
  await page.getByTestId("flow-next").click();
  await page.getByTestId("flow-submit").click();
  await page.evaluate(() => (window as any).__harnessRelease()); // page behind a modal is inert, so no button click
  await expect(page.getByTestId("flow-pending")).toContainText("still confirming");
  await expect(page.getByTestId("tx-link")).toHaveAttribute("href", /nearblocks\.io\/txns\/HARNESSHASH1$/);
  await noSeriousAxe(page);
});

test("FlowModal at 375px is a bottom sheet and axe clean; screenshot", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await page.getByTestId("open-flow").click();
  await expect(page.getByTestId("modal-surface")).toHaveAttribute("data-presentation", "sheet");
  await noSeriousAxe(page);
  await page.screenshot({ path: screenPath("modal1a/flow-375.png") });
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByTestId("modal-surface")).toHaveAttribute("data-presentation", "dialog");
  await page.screenshot({ path: screenPath("modal1a/flow-1280.png") });
});
