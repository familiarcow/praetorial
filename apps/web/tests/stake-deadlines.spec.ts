// FE5 (S5): stake, fee, settlement window, resolve deadline, named taker. Fully mocked: NEAR RPC views via page.route,
// wallet via window.__e2eTestWallet. Limits are served by the mocked asset_limit / protocol_fee_bps views (never hard-coded in the app).
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const NEAR = (n: number) => `${n}${"0".repeat(24)}`;
const LIMITS = { min_per_side: NEAR(10), max_per_side: NEAR(50), min_fee_per_side: "2" + "0".repeat(23), storage_per_kib: "1" }; // min 10 NEAR, max 50, min fee 0.2 NEAR

async function setup(page: Page, limits: Record<string, string> = LIMITS) {
  await page.addInitScript(({ address }) => { (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => "22".repeat(64) }; }, { address: WALLET });
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      const name = params.method_name;
      const r = name === "is_paused" || name === "is_shutdown" ? false : name === "open_offers" ? [] : name === "asset_limit" ? limits : name === "protocol_fee_bps" ? 100 : null;
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  await page.route("**/ticker**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ venue: "x", price: 100000 }) }));
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto("/new");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
  await expect(page.getByTestId("create-offer-form")).toBeVisible();
}
async function toResolver(page: Page, limits?: Record<string, string>) {
  await setup(page, limits);
  await page.getByTestId("bet-type-card-nws_daily_high").click();
  await page.getByTestId("guided-station").selectOption("KNYC");
  await page.getByTestId("guided-date").fill("2027-12-08");
  await page.getByTestId("guided-op").selectOption(">=");
  await page.getByTestId("guided-x_f").fill("72");
  await page.getByTestId("fill-next").click();
  await expect(page.getByTestId("step-resolver")).toBeVisible();
}
const stake = (page: Page, v: string) => page.getByTestId("maker-amount").fill(v);

test.describe("FE5 stake and deadlines (S5)", () => {
  test("the minimum comes from the asset_limit view and shows under the stake (BET1b: one Min . fee line)", async ({ page }) => {
    await toResolver(page);
    await expect(page.getByTestId("stake-limits")).toHaveText("Min 10 NEAR \u00b7 fee 0.20 NEAR each");
  });
  test("a changed on-chain limit changes the form (read live, not constants)", async ({ page }) => {
    await toResolver(page, { ...LIMITS, min_per_side: NEAR(20), max_per_side: NEAR(80) });
    await expect(page.getByTestId("stake-limits")).toHaveText("Min 20 NEAR"); // the default 10 is under the minimum: no fee shown yet
    await stake(page, "15");
    await expect(page.getByTestId("stake-error")).toHaveText("Minimum stake is 20 NEAR");
  });
  test("the fee line follows side_fee live, incl. the minimum-fee floor", async ({ page }) => {
    await toResolver(page);
    await stake(page, "10");
    await expect(page.getByTestId("stake-limits")).toHaveText("Min 10 NEAR \u00b7 fee 0.20 NEAR each");
    await stake(page, "30");
    await expect(page.getByTestId("stake-limits")).toHaveText("Min 10 NEAR \u00b7 fee 0.30 NEAR each");
  });
  test("each stake validation message, live and on Review", async ({ page }) => {
    await toResolver(page);
    await stake(page, "9");
    await expect(page.getByTestId("stake-error")).toHaveText("Minimum stake is 10 NEAR");
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("stake-error")).toHaveText("Minimum stake is 10 NEAR"); // C1 (UIR1 §3.4): the error shows once, under its field; Review is refused
    await expect(page.getByTestId("form-error")).toHaveCount(0);
    await expect(page.getByTestId("review-card")).toHaveCount(0);
    await stake(page, "51");
    await expect(page.getByTestId("stake-error")).toHaveText("Maximum stake is 50 NEAR");
    await stake(page, "");
    await expect(page.getByTestId("stake-error")).toHaveText("Enter your stake.");
    await stake(page, "20");
    await expect(page.getByTestId("stake-error")).toHaveCount(0);
    await page.getByTestId("taker-amount").fill("60"); // the other person would put in 60 NEAR, above the max
    await expect(page.getByTestId("theirstake-error")).toHaveText("The other person's stake: Maximum stake is 50 NEAR");
  });
  test("BET1c: the challenge window is fixed at 24h (no selector) and shows on the review card", async ({ page }) => {
    await toResolver(page);
    await expect(page.getByTestId("settlement-period")).toHaveCount(0);
    await expect(page.getByTestId("more-options-summary")).toHaveText("Closes in 7 days · anyone can take · 24h to challenge");
    await page.getByTestId("more-options-toggle").click();
    await expect(page.getByTestId("challenge-window-line")).toContainText("24h to challenge");
    await expect(page.getByTestId("settlement-period")).toHaveCount(0);
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("review-term-window")).toHaveText("24h to challenge a ruling, 2 rounds."); // C1: Full terms
  });
  test("offer expiry offers 1 day, 7 days, 30 days (default 7 days); the summary follows", async ({ page }) => {
    await toResolver(page);
    await expect(page.getByTestId("offer-expiry")).toHaveCount(0);
    await page.getByTestId("more-options-toggle").click();
    await expect(page.getByTestId("more-options-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("offer-expiry").locator("option")).toHaveText(["1 day", "7 days", "30 days"]);
    await expect(page.getByTestId("offer-expiry")).toHaveValue("7d");
    await page.getByTestId("offer-expiry").selectOption("1d");
    await expect(page.getByTestId("more-options-summary")).toHaveText("Closes in 1 day · anyone can take · 24h to challenge");
    await page.getByTestId("invite-by-link").check();
    await expect(page.getByTestId("more-options-summary")).toHaveText("Closes in 1 day · invite-only link · 24h to challenge");
    await page.getByTestId("taker-account-input").fill("alice.testnet");
    await expect(page.getByTestId("more-options-summary")).toHaveText("Closes in 1 day · only alice.testnet can take · 24h to challenge");
    await page.getByTestId("more-options-toggle").click();
    await expect(page.getByTestId("offer-expiry")).toHaveCount(0);
  });
  test("human mode: no settlement window; resolve deadline defaults to event + 1 year and is editable", async ({ page }) => {
    await toResolver(page);
    await expect(page.getByTestId("resolve-deadline")).toHaveCount(0);
    await page.getByTestId("decider-person").check();
    await page.getByTestId("more-options-toggle").click(); // BET1c: More options is collapsed by default
    await expect(page.getByTestId("settlement-period")).toHaveCount(0);
    await expect(page.getByTestId("challenge-window-line")).toHaveCount(0);
    await expect(page.getByTestId("resolve-deadline")).toHaveValue(/^2028-12-0[89]$/);
    await expect(page.getByTestId("resolve-label")).toContainText("hasn't ruled by this date, you're both refunded.");
    await page.getByTestId("resolve-deadline").fill("2029-06-01");
    await expect(page.getByTestId("resolve-error")).toHaveCount(0);
  });
  test("BET1c: Who decides = two cards (AI selected by default); the blurbs are in the ? tip; a person shows the search", async ({ page }) => {
    await toResolver(page);
    await expect(page.getByTestId("decider-ai")).toBeChecked();
    await expect(page.getByTestId("referee-picker")).not.toContainText("Fast, no one to chase"); // blurbs only in the ? tip
    await page.getByTestId("decider-help").click();
    await expect(page.getByTestId("decider-help-text")).toContainText("Fast, no one to chase");
    await expect(page.getByTestId("decider-help-text")).toContainText("No appeals.");
    await expect(page.getByTestId("referee-search")).toHaveCount(0);
    await page.getByTestId("decider-person").check();
    await expect(page.getByTestId("referee-search")).toBeVisible();
    await expect(page.getByTestId("more-options-summary")).toHaveText(/^Closes in 7 days · anyone can take · referee rules by 2028-12-0[89]$/);
    await page.getByTestId("decider-ai").check();
    await expect(page.getByTestId("referee-search")).toHaveCount(0);
    await expect(page.getByTestId("more-options-summary")).toHaveText("Closes in 7 days · anyone can take · 24h to challenge");
  });
  test("resolve deadline: more than 4 years away, and not after the event", async ({ page }) => {
    await toResolver(page);
    await page.getByTestId("decider-person").check();
    await page.getByTestId("more-options-toggle").click(); // BET1c: More options is collapsed by default
    await page.getByTestId("resolve-deadline").fill("2031-01-01");
    await expect(page.getByTestId("resolve-error")).toHaveText("That date is more than 4 years away.");
    await page.getByTestId("resolve-deadline").fill("2027-01-01");
    await expect(page.getByTestId("resolve-error")).toHaveText("The deadline has to be after the event.");
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("resolve-error")).toHaveText("The deadline has to be after the event."); // C1 (UIR1 §3.4): the error shows once, under its field; Review is refused
    await expect(page.getByTestId("form-error")).toHaveCount(0);
    await expect(page.getByTestId("review-card")).toHaveCount(0);
  });
  test("named taker: not yourself, a real account, not the referee", async ({ page }) => {
    await toResolver(page);
    await page.getByTestId("more-options-toggle").click(); // BET1c: More options is collapsed by default
    await page.getByTestId("taker-account-input").fill(WALLET);
    await expect(page.getByTestId("taker-error")).toHaveText("You can't name yourself.");
    await page.getByTestId("taker-account-input").fill("nodots");
    await expect(page.getByTestId("taker-error")).toHaveText("That doesn't look like a valid account.");
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("taker-error")).toHaveText("That doesn't look like a valid account."); // C1 (UIR1 §3.4): the error shows once, under its field; Review is refused
    await expect(page.getByTestId("form-error")).toHaveCount(0);
    await expect(page.getByTestId("review-card")).toHaveCount(0);
    await page.getByTestId("taker-account-input").fill("alice.testnet");
    await expect(page.getByTestId("taker-error")).toHaveCount(0);
    await page.getByTestId("taker-account-input").fill("");
    await expect(page.getByTestId("taker-error")).toHaveCount(0);
  });
});
