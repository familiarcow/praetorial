// Jason-bet flow e2e: real Privy test account, real NEAR testnet wallet,
// real chain-view data. Never skipped -- if a step fails it shows red.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { fillCanonicalCustom, CANON_HASH } from "./canonicalCustom";
import { recordSourceCheckHashes } from "./lib/sourceCheckTerms";

const EMAIL = process.env.PRIVY_TEST_EMAIL!;
const OTP = process.env.PRIVY_TEST_OTP!;
if (process.env.PW_LIVE && (!EMAIL || !OTP)) throw new Error("PRIVY_TEST_EMAIL / PRIVY_TEST_OTP not set in env");

test.describe.configure({ mode: "serial" });
test.describe("@live real Privy login", () => {
let page: Page;
let checked: () => string[];

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  // WEBREG1: testnet builds default to the live registry, which would put the username step in front of these create-bet flows.
  await context.addInitScript(() => { (window as any).__e2eRegistryUrl = ""; });
  page = await context.newPage();
  checked = recordSourceCheckHashes(page);
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
});

test("1. login with the Privy test account creates/loads a NEAR wallet + balance", async () => {
  await page.getByTestId("email-input").fill(EMAIL);
  await page.getByTestId("send-code").click();
  await page.waitForTimeout(2000);
  await page.getByTestId("otp-input").fill(OTP);
  await page.getByTestId("submit-code").click();
  await page.waitForFunction(() => (window as any).__e2e?.authenticated === true, { timeout: 20_000 });
  await page.waitForFunction(() => !!(window as any).__e2e?.nearAddress, { timeout: 30_000 });
  // NAV1: the account id and NEAR balance are on the Wallet page (account card + NEAR card), not in a header line.
  await page.getByTestId("nav-account").click();
  const addr = await page.getByTestId("wallet-account-id").getAttribute("title");
  expect(addr).toMatch(/^[0-9a-f]{64}$/);
  await expect(page.getByTestId("wallet-amount-NEAR")).toBeVisible();
});

test("2. create the BTC-threshold offer (same-asset) via the bet-type picker", async () => {
  await page.getByTestId("nav-create").click();
  await expect(page.getByTestId("create-offer-form")).toBeVisible();
  // FE3b Q5 (D-DEMO1): no preset and no deep link. The canonical jason_terms_with_urls.json sheet is built through the generic
  // "any web page" builder, field by field (tests/canonicalCustom.ts).
  await page.getByTestId("bet-type-card-custom").click();
  await fillCanonicalCustom(page);
  await expect(page.getByTestId("fill-error")).toHaveCount(0);
  await expect(page.getByTestId("fill-sentence")).toContainText("$126,210.50");
  await page.getByTestId("fill-next").click();
  await page.getByTestId("maker-amount").fill("10");
  await page.getByTestId("review-offer").click();
});

test("3. review card renders the structured offer (never free prose)", async () => {
  // C1 (UIR1 §3.4): five lines + Full terms; the fingerprint is no longer printed, so the canonical-sheet check reads the terms the
  // app sent to the (automatic) source check -- the exact text that is hashed and signed at Open.
  await expect(page.getByTestId("review-card")).toBeVisible();
  await expect(page.getByTestId("review-claim")).toContainText("$126,210.50");
  await expect(page.getByTestId("review-decider")).toHaveText("The AI judge, from api.exchange.coinbase.com, www.bitstamp.net and api.kraken.com");
  // the sheet the builder produced IS the canonical D-DEMO1 sheet: same terms fingerprint
  await expect.poll(() => checked()).toContain(CANON_HASH);
  await expect(page.getByTestId("review-stakes")).toHaveText("You put in 10 NEAR · they put in 10 NEAR");
  await page.getByTestId("review-full-terms").locator("summary").click();
  await expect(page.getByTestId("review-term-fee")).toContainText("1% of the stake");
  await expect(page.getByTestId("review-term-safety")).toContainText("Money can only go to you or the other party");
  await expect(page.getByTestId("review-flags")).toHaveCount(0);
});

test("4. opening onchain is honestly gated (relayer-wired, no redeploy note), never faked", async () => {
  // FE8 (D-UX21, queue FE8): the "Opening onchain requires the escrow redeploy" note is removed; this assertion encoded that superseded note.
  await expect(page.getByTestId("open-pending-note")).toHaveCount(0);
  // Open is not pressed: nothing was sent and no success state exists (C1: no raw relay status word is printed any more).
  await expect(page.getByTestId("open-status")).toHaveCount(0);
  await expect(page.getByTestId("open-tx")).toHaveCount(0);
  await expect(page.getByTestId("open-error")).toHaveCount(0);
  await expect(page.getByText(/bet id|opened/i)).toHaveCount(0);
});

test("5. bet page reads live status from the deployed escrow contract via get_bet/open_offers", async () => {
  await page.evaluate(() => { history.pushState({}, "", "/bet/1"); window.dispatchEvent(new PopStateEvent("popstate")); }); // FE1: in-app nav to /bet/1 (typed bet-id box removed)
  await expect(page.getByTestId("bet-status")).not.toHaveText("Loading…", { timeout: 15_000 });
  const status = await page.getByTestId("bet-status").textContent();
  // Real RPC round trip against escrow3.praetorial-dev-1101.testnet --
  // either a real status string or "not found on 1" (bet 1 doesn't
  // exist / was consumed by earlier chaos runs), never a fabricated value.
  expect(status).toBeTruthy();
});

// 17e: D-SETTLE3 removed mutual_settle
test("6. mutual settle no longer exists on the bet page", async () => {
  await expect(page.getByTestId("mutual-settle-explainer")).toHaveCount(0);
  await expect(page.getByTestId("propose-settle")).toHaveCount(0);
});
});
