// FE3b (D-FE3b): plain-English fill errors, errors only after blur / Next, review "Sources:", Edit round-trip, and the canonical
// D-DEMO1 sheet built through the generic custom builder. Fully mocked (NEAR RPC + ticker + 1Click via page.route, wallet via
// window.__e2eTestWallet); never a real Privy login.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { recordSourceCheckHashes } from "./lib/sourceCheckTerms";
import { fillCanonicalCustom, CANON, CANON_HASH } from "./canonicalCustom";
import { openMoreOptions } from "./betDetailsHelpers";
import { openBetType } from "./betTypeNav";

const WALLET = "11".repeat(32);
const SIG = "22".repeat(64);
const RPC = "https://test.rpc.fastnear.com";

async function setup(page: Page) {
  await page.addInitScript(({ address, sig }) => { (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => sig }; }, { address: WALLET, sig: SIG });
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      const name = params.method_name;
      const r = name === "is_paused" || name === "is_shutdown" ? false : name === "open_offers" ? [] : name === "asset_limit" ? { storage_per_kib: "1" } : null;
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
const card = (page: Page, id: string) => page.getByTestId(`bet-type-card-${id}`);

async function fillTouch(page: Page) {
  await page.getByTestId("guided-direction").selectOption("at_or_above");
  await page.getByTestId("guided-x_usd").fill("76000");
  await page.getByTestId("guided-deadline_utc").fill("2027-12-07T12:00");
}

test.describe("FE3b", () => {
  test("Q2: an untouched half-filled form shows no 'missing field'; Next shows the problems in plain English", async ({ page }) => {
    await setup(page);
    await openBetType(page, "btc_touch");
    await page.getByTestId("guided-x_usd").fill("76000"); // typing only: focus is still inside the field
    await expect(page.getByTestId("fill-error")).toHaveCount(0);
    await expect(page.getByTestId("fill-next")).toBeDisabled(); // the Next block is unchanged
    await page.getByTestId("fill-next").click({ force: true }); // aria-disabled, not removed: a Next attempt reveals the problems
    await expect(page.getByTestId("fill-error")).toBeVisible();
    await expect(page.getByTestId("fill-error")).toContainText("Fill in every box before moving on.");
    await expect(page.getByTestId("fill-error")).not.toContainText("missing field");
    await expect(page.getByTestId("step-resolver")).toHaveCount(0);
  });

  test("Q2: leaving a field shows the problem; Q1: it is a plain sentence with the raw code under Details", async ({ page }) => {
    await setup(page);
    await openBetType(page, "btc_close_at_t");
    await page.getByTestId("guided-x_usd").fill("75900.5");
    await expect(page.getByTestId("fill-error")).toHaveCount(0); // still typing
    await page.getByTestId("guided-x_usd").blur();
    await expect(page.getByTestId("fill-error")).toBeVisible();
    await expect(page.getByTestId("fill-error")).toContainText("Enter the price as a whole number of dollars, like 76000.");
    await expect(page.getByTestId("fill-error")).not.toContainText("JSON integer", { useInnerText: true }); // the lint wording sits only in the closed Details
    await expect(page.locator('[data-testid^="fill-error-details-"]').filter({ hasText: "TPL_X_USD_NOT_WHOLE" })).toHaveCount(1); // details toggle keeps the code
  });

  test("Q3: typed-bet review sentence carries 'Sources:' from the template definition", async ({ page }) => {
    await setup(page);
    await openBetType(page, "btc_touch");
    await fillTouch(page);
    await page.getByTestId("fill-next").click();
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("review-decider")).toHaveText("Decided by code from Coinbase, Bitstamp and Kraken 1-minute prices"); // C1: the 5-line review; TPL1: Bitcoin is decided by code
    await expect(page.getByTestId("review-term-sources")).toHaveText("Coinbase BTC-USD, Bitstamp btcusd, Kraken XBT/USD");
  });

  test("Q4: Edit from the review keeps every entered field (amounts, odds, deadlines, window, taker, bet)", async ({ page }) => {
    await setup(page);
    await openBetType(page, "btc_touch");
    await fillTouch(page);
    await page.getByTestId("fill-next").click();
    await page.getByTestId("maker-amount").fill("25");
    await page.getByTestId("taker-amount").fill("50"); // BET1b: they put in 50 = odds 2
    await expect(page.getByTestId("settlement-period")).toHaveCount(0); // BET1c: challenge window fixed at 24h
    await page.getByTestId("more-options-toggle").click(); // BET1c: More options is collapsed by default
    await page.getByTestId("offer-expiry").selectOption("30d");
    await page.getByTestId("taker-account-input").fill("friend.testnet");
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("review-card")).toBeVisible();
    // C1: the five lines + the Full terms rows (the named taker's line waits for its @username lookup to settle, never "…")
    const snap = async () => {
      await expect(page.getByTestId("review-term-takers")).not.toHaveText(/…/);
      await expect(page.getByTestId("review-term-pay-now")).not.toHaveText("Loading…"); // the storage quote has landed
      return {
        claim: await page.getByTestId("review-claim").textContent(),
        stakes: await page.getByTestId("review-stakes").textContent(),
        decider: await page.getByTestId("review-decider").textContent(),
        terms: await page.getByTestId("review-full-terms").locator("dd").allTextContents(),
      };
    };
    const before = await snap();
    expect(before.stakes).toBe("You put in 25 NEAR · they put in 50 NEAR");
    expect(before.terms.join("\n")).toContain("24h to challenge a ruling");
    expect(before.terms.join("\n")).not.toContain("friend.testnet"); // PEOPLE RULE: the named taker is a person, not an account id
    await page.getByTestId("back-to-create").click();
    await expect(page.getByTestId("step-resolver")).toBeVisible();
    await expect(page.getByTestId("maker-amount")).toHaveValue("25");
    await expect(page.getByTestId("taker-amount")).toHaveValue("50");
    await expect(page.getByTestId("more-options-summary")).toHaveText("Closes in 30 days · only friend.testnet can take · 24h to challenge");
    await page.getByTestId("more-options-toggle").click(); // BET1c: More options is collapsed by default
    await expect(page.getByTestId("offer-expiry")).toHaveValue("30d");
    await expect(page.getByTestId("taker-account-input")).toHaveValue("friend.testnet");
    await page.getByTestId("review-offer").click();
    expect(await snap()).toEqual(before);
    await page.getByTestId("back-to-create").click();
    await page.getByTestId("resolver-back").click();
    await expect(page.getByTestId("guided-direction")).toHaveValue("at_or_above");
    await expect(page.getByTestId("guided-x_usd")).toHaveValue("76000");
    await expect(page.getByTestId("guided-deadline_utc")).toHaveValue("2027-12-07T12:00");
  });

  test("Q4: custom bet round-trips its sources and window through Edit", async ({ page }) => {
    await setup(page);
    await card(page, "custom").click();
    await fillCanonicalCustom(page);
    await page.getByTestId("fill-next").click();
    const checked = recordSourceCheckHashes(page);
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("review-card")).toBeVisible();
    await expect.poll(() => checked().length).toBe(1); // C1: the automatic check sent these terms
    await page.getByTestId("back-to-create").click();
    await page.getByTestId("resolver-back").click();
    await openMoreOptions(page); // BET1a: these fields live under More options
    await expect(page.getByTestId("cb-source-ticker-2")).toHaveValue("XBT/USD");
    await expect(page.getByTestId("cb-windowClose")).toHaveValue("2028-11-06T19:00");
    await page.getByTestId("fill-next").click();
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("review-card")).toBeVisible();
    // the same terms came back: same offer, so no second automatic check (an edited sheet would be a new offer and be checked again)
    await expect(page.getByTestId("check-sources-btn")).toHaveText("Check the sources");
    expect(checked().length).toBe(1);
  });

  test("Q5 + Q3: the generic custom builder produces the canonical D-DEMO1 sheet; review lists its source hosts", async ({ page }) => {
    await setup(page);
    await card(page, "custom").click();
    await fillCanonicalCustom(page);
    await expect(page.getByTestId("fill-next")).toBeEnabled();
    await expect(page.getByTestId("fill-error")).toHaveCount(0);
    await page.getByTestId("fill-next").click();
    await page.getByTestId("maker-amount").fill("10");
    const checked = recordSourceCheckHashes(page);
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("review-card")).toBeVisible();
    await expect.poll(() => checked()).toEqual([CANON_HASH]); // sha256 of the canonical sheet's canonical JSON (the terms the app checks and signs)
    await expect(page.getByTestId("review-decider")).toHaveText("The AI judge, from api.exchange.coinbase.com, www.bitstamp.net and api.kraken.com");
    await expect(page.getByTestId("review-flags")).toHaveCount(0);
    void CANON;
  });
});
