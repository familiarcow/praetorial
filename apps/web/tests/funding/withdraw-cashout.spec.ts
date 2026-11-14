// F5 (FUND4 SPEC §5, familiarcow UX-37 FUND 14 / D-FUND4a, SM2 STATES.md M7), mocked: Cash out end to end on a stand-in Worker that
// issues real NEP-413 payloads and verifies the signature (tests/funding/withdraw-mock.ts). The test wallet signs with a real
// ed25519 key. Nothing is sent anywhere.
//   happy path USDC -> USDT on Tron (Send as picker, address check, review, the user's signature, tracker to "Sent"); an invalid
//   checksum; a memo chain + exchange -> blocked; too small parses the minimum; a payload that doesn't match -> stopped, no
//   signature asked; the user cancels -> nothing sent; a reload with an unsigned cash out -> Confirm; the submit's answer lost ->
//   "checking", never "failed"; the Worker down; Move's unknown outcome is "checking" (SM2 F5-2); 375 px, axe, screenshots.
import { type Page } from "@playwright/test"; import { test, expect } from "../e2eGuard";
import AxeBuilder from "@axe-core/playwright";
import { hashNep413Payload } from "../../lib/funding/intentCheck";
import { mockF5, ready, ME, TRON_ADDR, ID } from "./withdraw-mock";
import { withdrawRecord, status } from "./fixtures";

const SHOTS = process.env.F5_SHOTS === "1" ? "../../spikes/f5/shots" : "test-results/screens/f5";
const sheet = (page: Page) => page.getByTestId("cash-out-sheet");
async function noSeriousAxe(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  const r = await new AxeBuilder({ page }).include("[data-testid=cash-out-sheet]").analyze();
  expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.html?.slice(0, 120)}`)).toEqual([]);
}
const noHScroll = async (page: Page, w: number) => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
const stored = (page: Page) => page.evaluate((me) => JSON.parse(localStorage.getItem(`praetorial:funding:v1:${me}`) ?? "[]"), ME);

/** Account -> Cash out -> USDC -> amount -> Send as USDT on Tron -> address. */
async function toAddress(page: Page, amount = "20") {
  await page.goto("/account"); await ready(page);
  await page.getByTestId("account-cash-out").click();
  await expect(sheet(page).getByTestId("co-pick")).toBeVisible();
  await sheet(page).locator(`[data-testid=co-holding][data-asset="${ID.USDC}"]`).click();
  await sheet(page).getByTestId("co-amount").fill(amount);
  await sheet(page).getByTestId("co-amount-next").click();
  await expect(sheet(page).getByTestId("co-sendas")).toBeVisible(); // USDC with no Add money history: no default network
  await sheet(page).getByTestId("co-sendas-search").fill("trc20");
  await sheet(page).getByTestId("co-sendas-USDT-tron").click();
  await expect(sheet(page).getByTestId("co-sendas-current")).toContainText("Send as USDT on Tron");
}
async function toReview(page: Page) {
  await toAddress(page);
  await sheet(page).getByTestId("co-address-input").fill(TRON_ADDR);
  await sheet(page).getByTestId("co-address-next").click();
  await expect(sheet(page).getByTestId("co-review-receive")).toHaveText("19.80 USDT on Tron");
}

test.describe("F5 Cash out", () => {
  test.use({ viewport: { width: 375, height: 812 } }); // mobile first; the two full-flow tests also run at 1280
  for (const [name, size] of [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 900 }]] as const) {
    test(`${name}px: USDC -> USDT on Tron: pick, amount, Send as, address check, review, the user signs, tracker to Sent; axe; no h-scroll`, async ({ page }) => {
      await page.setViewportSize(size);
      const { worker, signs } = await mockF5(page);
      await page.goto("/account"); await ready(page);
      await page.getByTestId("account-cash-out").click();
      // 1: what you hold (non-zero only), in token units.
      await expect(sheet(page).getByTestId("co-holding")).toHaveCount(1);
      await expect(sheet(page).getByTestId("co-holding")).toContainText("42.10 USDC");
      await noSeriousAxe(page);
      await page.screenshot({ path: `${SHOTS}/f5-pick-${name}.png`, fullPage: true });
      await sheet(page).getByTestId("co-holding").click();
      // Amount: more than you have is refused; Max fills the whole balance.
      await sheet(page).getByTestId("co-amount").fill("50");
      await expect(sheet(page).getByTestId("co-amount-error")).toHaveText("That's more than you have (42.10 USDC).");
      await expect(sheet(page).getByTestId("co-amount-next")).toBeDisabled();
      await sheet(page).getByTestId("co-max").click();
      await expect(sheet(page).getByTestId("co-amount")).toHaveValue("42.1");
      await sheet(page).getByTestId("co-amount").fill("20");
      await page.screenshot({ path: `${SHOTS}/f5-amount-${name}.png`, fullPage: true });
      await sheet(page).getByTestId("co-amount-next").click();
      // 2: Send as -- the same symbol on every network first ("Popular for USDC"), then everything else (cross-symbol allowed).
      await expect(sheet(page).getByTestId("co-sendas-same").locator("li").first()).toContainText("USDC");
      await expect(sheet(page).getByTestId("co-sendas-all")).toContainText("USDT");
      await noSeriousAxe(page);
      await page.screenshot({ path: `${SHOTS}/f5-sendas-${name}.png`, fullPage: true });
      await sheet(page).getByTestId("co-sendas-search").fill("trc20");
      await sheet(page).getByTestId("co-sendas-USDT-tron").click();
      // 3: the address, checked as you type (Tron base58check).
      await expect(sheet(page).getByTestId("co-address-next")).toBeDisabled();
      await sheet(page).getByTestId("co-address-input").fill(TRON_ADDR.slice(0, -1) + "8");
      await expect(sheet(page).getByTestId("co-address-error")).toHaveText("That isn't a valid Tron address.");
      await expect(sheet(page).getByTestId("co-address-next")).toBeDisabled();
      await sheet(page).getByTestId("co-address-input").fill(`${TRON_ADDR} `);
      await expect(sheet(page).getByTestId("co-address-error")).toHaveCount(0);
      await expect(sheet(page).getByTestId("co-exchange-note")).toHaveText("Exchanges sometimes don't credit deposits from smart contracts. If unsure, send a small amount first.");
      await expect(sheet(page).getByTestId("co-memo")).toHaveCount(0); // Tron is not a memo chain
      await expect(sheet(page).getByTestId("co-address-next")).toBeEnabled();
      await page.screenshot({ path: `${SHOTS}/f5-address-${name}.png`, fullPage: true });
      await sheet(page).getByTestId("co-address-next").click();
      // 4: review (an estimate; nothing saved, nothing signed yet).
      await expect(sheet(page).getByTestId("co-review-send")).toHaveText("20.00 USDC");
      await expect(sheet(page).getByTestId("co-review-receive")).toHaveText("19.80 USDT on Tron");
      await expect(sheet(page).getByTestId("co-review-at-least")).toHaveText("19.60 USDT");
      await expect(sheet(page).getByTestId("co-review-to")).toHaveText("TN3W…b3m9 (Tron)");
      await expect(sheet(page).getByTestId("co-review-fee")).toHaveText("0.21 USDT · about 1 min");
      await sheet(page).getByTestId("co-review-address").locator("summary").click();
      await expect(sheet(page).getByTestId("co-review-full-address")).toHaveText(TRON_ADDR); // trimmed
      const dry = worker.calls.filter((c) => c.path === "/withdraw/quote");
      expect(dry.map((c) => c.body)).toEqual([{ account: ME, kind: "withdraw", originAsset: ID.USDC, amountIn: "20000000", destinationAsset: ID.TRON_USDT, recipient: TRON_ADDR, dry: true }]);
      expect(signs).toEqual([]);
      expect(await stored(page)).toEqual([]);
      await noSeriousAxe(page);
      await page.screenshot({ path: `${SHOTS}/f5-review-${name}.png`, fullPage: true });
      // 5: Cash out -> a real price -> the record saved BEFORE signing -> the user signs OUR recomputed hash -> submitted.
      await sheet(page).getByTestId("co-confirm").click();
      await expect(sheet(page).getByTestId("co-tracker")).toBeVisible();
      await expect(sheet(page).getByTestId("co-track-message")).toHaveText("Sending 19.80 USDT to TN3W…b3m9…");
      const real = worker.calls.filter((c) => c.path === "/withdraw/quote").at(-1)!;
      expect(real.body.dry).toBe(false);
      const rec = [...worker.recs.values()][0]!;
      expect(signs).toEqual([Buffer.from(hashNep413Payload(rec.payload)).toString("hex")]);
      const submit = worker.calls.find((c) => c.path === "/withdraw/submit")!;
      expect(Object.keys(submit.body.signedData).sort()).toEqual(["payload", "public_key", "signature", "standard"]);
      expect(rec.submitted).toBe(true);
      const saved = await stored(page);
      expect(saved.map((r: any) => [r.kind, r.signed, r.recipient, r.origin.assetId, r.destination.assetId, r.amountIn])).toEqual([["withdraw", true, TRON_ADDR, ID.USDC, ID.TRON_USDT, "20000000"]]);
      await page.screenshot({ path: `${SHOTS}/f5-sending-${name}.png`, fullPage: true });
      // Tracker: PROCESSING -> SUCCESS.
      await expect(sheet(page).getByTestId("co-track-message")).toHaveText("Sent: 19.80 USDT is on its way to TN3W…b3m9.", { timeout: 20_000 });
      await expect(sheet(page).getByTestId("co-tracker")).toHaveAttribute("data-state", "credited");
      await noSeriousAxe(page);
      await noHScroll(page, size.width);
      await page.screenshot({ path: `${SHOTS}/f5-sent-${name}.png`, fullPage: true });
      await sheet(page).getByTestId("co-cta-done").click();
      await expect(sheet(page)).toHaveCount(0);
    });
  }

  test("memo chain (XRP): an exchange address that needs a tag is blocked; 'my own wallet' goes on", async ({ page }) => {
    await mockF5(page);
    await page.goto("/account"); await ready(page);
    await page.getByTestId("account-cash-out").click();
    await sheet(page).getByTestId("co-holding").click();
    await sheet(page).getByTestId("co-amount").fill("20");
    await sheet(page).getByTestId("co-amount-next").click();
    await sheet(page).getByTestId("co-sendas-search").fill("xrp");
    await sheet(page).getByTestId("co-sendas-XRP-xrp").click();
    await sheet(page).getByTestId("co-address-input").fill("rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y");
    await expect(sheet(page).getByTestId("co-memo")).toContainText("Is this an exchange address that needs a tag or memo?");
    await expect(sheet(page).getByTestId("co-address-next")).toBeDisabled();
    await sheet(page).getByTestId("co-memo-yes").click();
    await expect(sheet(page).getByTestId("co-memo-block")).toHaveText("We can't add a tag or memo yet. Send to a wallet you control, then move it to the exchange.");
    await expect(sheet(page).getByTestId("co-address-next")).toBeDisabled();
    await page.screenshot({ path: `${SHOTS}/f5-memo-blocked-375.png`, fullPage: true });
    await sheet(page).getByTestId("co-memo-no").click();
    await expect(sheet(page).getByTestId("co-memo-block")).toHaveCount(0);
    await expect(sheet(page).getByTestId("co-address-next")).toBeEnabled();
  });

  test("too small: the minimum parsed from the service's answer, in the token you send (rounded up); nothing to confirm", async ({ page }) => {
    await mockF5(page, {}, { tooLow: "1218977" });
    await toAddress(page, "1");
    await sheet(page).getByTestId("co-address-input").fill(TRON_ADDR);
    await sheet(page).getByTestId("co-address-next").click();
    await expect(sheet(page).getByTestId("co-review-error")).toHaveText("Too small to send to Tron. Minimum is 1.22 USDC.");
    await expect(sheet(page).getByTestId("co-confirm")).toBeDisabled();
    await page.screenshot({ path: `${SHOTS}/f5-too-small-375.png`, fullPage: true });
  });

  for (const [what, tamper] of [
    ["another amount", (m: any) => { m.intents[0].tokens = { [ID.USDC]: "20000001" }; }],
    ["another receiver", (m: any) => { m.intents[0].receiver_id = "evil.near"; }],
    ["an extra transfer", (m: any) => { m.intents.push({ intent: "transfer", receiver_id: "evil.near", tokens: { [ID.USDC]: "1" } }); }],
  ] as const) {
    test(`payload mismatch (${what}): stopped, the wallet is never asked, nothing submitted`, async ({ page }) => {
      const { worker, signs } = await mockF5(page, {}, { tamper });
      await toReview(page);
      await sheet(page).getByTestId("co-confirm").click();
      await expect(sheet(page).getByTestId("co-review-error")).toHaveText("We stopped this cash out because the details didn't match. Nothing was sent.");
      expect(signs).toEqual([]);
      expect(worker.signedSubmits()).toBe(0);
      if (what === "another amount") await page.screenshot({ path: `${SHOTS}/f5-mismatch-375.png`, fullPage: true });
      // Not "in progress" on Account: it was never signed.
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("inflight-card")).toHaveCount(0);
    });
  }

  test("the user cancels in the wallet: nothing sent, the same price can be confirmed on the next tap", async ({ page }) => {
    const { worker, signs } = await mockF5(page);
    await page.addInitScript(() => { (window as any).__f5Refuse = true; });
    await toReview(page);
    await sheet(page).getByTestId("co-confirm").click();
    await expect(sheet(page).getByTestId("co-review-error")).toHaveText("You cancelled. Nothing was sent.");
    expect(worker.signedSubmits()).toBe(0);
    expect(signs).toEqual([]);
    expect((await stored(page)).map((r: any) => r.signed)).toEqual([false]);
    await page.screenshot({ path: `${SHOTS}/f5-cancelled-375.png`, fullPage: true });
    const quotes = () => worker.calls.filter((c) => c.path === "/withdraw/quote" && c.body.dry === false).length;
    expect(quotes()).toBe(1);
    await page.evaluate(() => { (window as any).__f5Refuse = false; });
    await sheet(page).getByTestId("co-confirm").click();
    await expect(sheet(page).getByTestId("co-track-message")).toHaveText("Sending 19.80 USDT to TN3W…b3m9…");
    expect(quotes()).toBe(1); // reused: one record, one deposit address
    expect(worker.signedSubmits()).toBe(1);
  });

  test("reload with a cash out saved but never signed: Account shows it; Confirm signs it (no new price)", async ({ page }) => {
    const deadline = new Date(Date.now() + 20 * 60_000).toISOString();
    const { worker } = await mockF5(page, { local: [withdrawRecord({ account: ME, signed: false, deadline, createdAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000 })] });
    // The Worker knows this record (it issued the price): seed it as a real quote.
    const addr = withdrawRecord().depositAddress;
    worker.recs.set(addr, { body: { account: ME, originAsset: ID.USDC, amountIn: "20000000" }, quote: { ...withdrawRecord(), deadline } as any, payload: null, submitted: false, seq: 0 });
    await page.goto("/account"); await ready(page);
    await expect(page.getByTestId("inflight-card")).toContainText("1 transfer in progress");
    await page.getByTestId("inflight-line").getByRole("button").click();
    await expect(sheet(page).getByTestId("co-track-message")).toHaveText("You didn't confirm this cash out.");
    await page.screenshot({ path: `${SHOTS}/f5-unsigned-375.png`, fullPage: true });
    await sheet(page).getByTestId("co-cta-confirm").click();
    await expect(sheet(page).getByTestId("co-track-message")).toHaveText("Sending 19.80 USDT to TN3W…b3m9…");
    expect(worker.calls.filter((c) => c.path === "/withdraw/quote")).toEqual([]);
    expect(worker.signedSubmits()).toBe(1);
  });

  test("unsigned + Cancel: it stops showing as in progress", async ({ page }) => {
    const deadline = new Date(Date.now() + 20 * 60_000).toISOString();
    await mockF5(page, { local: [withdrawRecord({ account: ME, signed: false, deadline, createdAt: Date.now(), updatedAt: Date.now() })] });
    await page.goto("/account"); await ready(page);
    await page.getByTestId("inflight-line").getByRole("button").click();
    await sheet(page).getByTestId("co-cta-cancel").click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.getByTestId("inflight-card")).toHaveCount(0);
  });

  test("signed, then the answer is lost on the way: 'checking', never 'failed'; the tracker follows the real status", async ({ page }) => {
    const { worker } = await mockF5(page, {}, { submitDown: true });
    await toReview(page);
    await sheet(page).getByTestId("co-confirm").click();
    await expect(sheet(page).getByTestId("co-track-message")).toHaveText("We can't check this right now. It's still being processed. Retrying…");
    await expect(sheet(page).getByTestId("co-tracker")).not.toHaveAttribute("data-state", "failed");
    expect(worker.signedSubmits()).toBe(1);
    await page.screenshot({ path: `${SHOTS}/f5-checking-375.png`, fullPage: true });
  });

  test("refunded: the money is back in the betting balance", async ({ page }) => {
    await mockF5(page, {}, { after: [status("REFUNDED", { refundedAmount: "20000000", refundReason: "PRICE" })] });
    await toReview(page);
    await sheet(page).getByTestId("co-confirm").click();
    await expect(sheet(page).getByTestId("co-track-message")).toHaveText("We couldn't send it. 20.00 USDC is back in your betting balance.", { timeout: 20_000 });
    await page.screenshot({ path: `${SHOTS}/f5-refunded-375.png`, fullPage: true });
  });

  test("the funding service is down: plain 'unavailable, your balances are safe', nothing to confirm", async ({ page }) => {
    await mockF5(page, {}, { down: true });
    await toAddress(page);
    await sheet(page).getByTestId("co-address-input").fill(TRON_ADDR);
    await sheet(page).getByTestId("co-address-next").click();
    await expect(sheet(page).getByTestId("co-review-error")).toHaveText("Adding money and cashing out are unavailable right now. Your balances are safe.");
    await expect(sheet(page).getByTestId("co-confirm")).toBeDisabled();
  });

  test("token sheet: Cash out starts on that token; NEAR defaults to Send as NEAR; the NEAR-account option stays for USDC/NEAR", async ({ page }) => {
    await mockF5(page, { wnear: (5n * 10n ** 24n).toString() });
    await page.goto("/account"); await ready(page);
    await page.getByTestId("asset-row-NEAR").click();
    await expect(page.getByTestId("token-sheet-NEAR")).toBeVisible();
    await expect(page.getByTestId("withdraw-btn-NEAR")).toHaveText("Cash out to my NEAR account");
    await page.getByTestId("token-cash-out-NEAR").click();
    await expect(sheet(page).getByTestId("co-holding-line")).toHaveText("NEAR · 5 NEAR");
    await sheet(page).getByTestId("co-max").click();
    await sheet(page).getByTestId("co-amount-next").click();
    await expect(sheet(page).getByTestId("co-sendas-current")).toContainText("Send as NEAR on NEAR");
    await sheet(page).getByTestId("co-address-input").fill(ME); // your own NEAR account is a fine destination on NEAR
    await expect(sheet(page).getByTestId("co-address-next")).toBeEnabled();
  });

  test("SM2 F5-2: Move to betting whose outcome is unknown says 'checking' (pending), never 'failed', like Cash out to my NEAR account", async ({ page }) => {
    await mockF5(page, { nearUsdc: "7000000" });
    await page.route("http://localhost:8788/**", (r) => r.request().method() === "OPTIONS"
      ? r.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST" } })
      : r.fulfill({ status: 202, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: false, status: "unknown", txHash: "UNKNOWNTX", error: "sent to NEAR, but the result is not known yet" }) }));
    await page.goto("/account"); await ready(page);
    await page.getByTestId("move-USDC-token").click();
    const dlg = page.locator("dialog[open]").last();
    await dlg.getByTestId("move-confirm").click();
    await expect(dlg.getByTestId("flow-pending")).toBeVisible({ timeout: 20_000 });
    await expect(dlg.getByTestId("move-result")).toHaveAttribute("data-kind", "checking");
    await expect(dlg.getByTestId("move-result")).toHaveText("Checking whether it went through. Don't send it again yet; check back in a minute.");
    await expect(dlg.getByTestId("flow-failure")).toHaveCount(0);
  });
});
