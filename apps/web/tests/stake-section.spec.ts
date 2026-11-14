// BET1b (UX-33 section 3): the Stake section. "You put in [amount] [token]" / "They put in [amount] [token]" (same token, even by
// default), a token picker with logos, one "Min . fee" line, no odds box, no cross-asset taker options (D-SCOPE5).
// Fully mocked (testnet build: USDC + NEAR are the tokens with testnet ids; the six-token mainnet list is unit-tested).
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { readFileSync } from "node:fs";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const WASM = JSON.parse(readFileSync(new URL("../lib/release.json", import.meta.url), "utf8")).resolver_wasm_hash;
const USDC_ID = "nep141:usdc.testnet";
const LIMITS: Record<string, Record<string, string>> = {
  "nep141:wrap.testnet": { min_per_side: "2" + "0".repeat(24), max_per_side: "1" + "0".repeat(34), min_fee_per_side: "1" + "0".repeat(23), storage_per_kib: "1" },
  [USDC_ID]: { min_per_side: "10000000", max_per_side: "1" + "0".repeat(34), min_fee_per_side: "500000", storage_per_kib: "1" },
};

async function setup(page: Page, limitCalls: string[] = []) {
  await page.addInitScript(({ address }) => { (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => "22".repeat(64) }; }, { address: WALLET });
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      let r: unknown = null;
      const args = JSON.parse(Buffer.from(params.args_base64 ?? "", "base64").toString() || "{}");
      switch (params.method_name) {
        case "is_paused": case "is_shutdown": r = false; break;
        case "open_offers": r = []; break;
        case "asset_limit": limitCalls.push(args.asset_id); r = LIMITS[args.asset_id] ?? null; break;
        case "protocol_fee_bps": r = 100; break;
        case "resolver_keys": r = ["a", "b", WASM]; break;
        case "mt_balance_of": r = "1" + "0".repeat(30); break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  await page.route("**/ticker**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ venue: "x", price: 1 }) }));
  await page.goto("/new");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
  await page.getByTestId("bet-type-card-nws_daily_high").click();
  await page.getByTestId("guided-station").selectOption("KNYC");
  await page.getByTestId("guided-date").fill("2027-12-08");
  await page.getByTestId("guided-op").selectOption(">=");
  await page.getByTestId("guided-x_f").fill("72");
  await page.getByTestId("fill-next").click();
  await expect(page.getByTestId("stake-section")).toBeVisible();
}
async function pickToken(page: Page, symbol: string) {
  await page.getByTestId("stake-asset").click();
  await page.locator(".astryx-selector-option-row", { hasText: symbol }).click();
  await expect(page.getByTestId("stake-asset")).toContainText(symbol);
}

test.describe("BET1b stake section", () => {
  test("two lines, even by default; they follow you until edited; no odds box, no cross-asset options", async ({ page }) => {
    await setup(page);
    const s = page.getByTestId("stake-section");
    await expect(s).toContainText("You put in");
    await expect(s).toContainText("They put in");
    await expect(page.getByTestId("maker-amount")).toHaveValue("10");
    await expect(page.getByTestId("taker-amount")).toHaveValue("10");
    await page.getByTestId("maker-amount").fill("25");
    await expect(page.getByTestId("taker-amount")).toHaveValue("25");
    await expect(page.getByTestId("taker-token")).toHaveText("NEAR");
    for (const gone of ["odds-input", "taker-options", "maker-asset", "oneclick-status"]) await expect(page.getByTestId(gone)).toHaveCount(0);
    await expect(page.getByText("Also accept")).toHaveCount(0);
    await expect(page.getByText("Taker options")).toHaveCount(0);
    await expect(page.getByText(/Odds \(taker:maker\)/)).toHaveCount(0);
  });

  test("editing theirs sets the odds; the review card shows both stakes, the odds and only the same-token taker option", async ({ page }) => {
    await setup(page);
    await page.getByTestId("maker-amount").fill("10");
    await page.getByTestId("taker-amount").fill("30");
    await page.getByTestId("maker-amount").fill("20"); // theirs stays as typed once edited
    await expect(page.getByTestId("taker-amount")).toHaveValue("30");
    await expect(page.getByTestId("stake-even")).toBeVisible();
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("review-card")).toBeVisible();
    // C1: one stakes line (no Maker/Taker/odds/taker-options rows; same token only, D-SCOPE5)
    await expect(page.getByTestId("review-stakes")).toHaveText("You put in 20 NEAR · they put in 30 NEAR");
    await expect(page.getByTestId("review-term-their-stake")).toHaveText("30 NEAR");
  });

  test("'Make it even' puts their amount back to yours", async ({ page }) => {
    await setup(page);
    await page.getByTestId("taker-amount").fill("15");
    await page.getByTestId("stake-even").click();
    await expect(page.getByTestId("taker-amount")).toHaveValue("10");
    await expect(page.getByTestId("stake-even")).toHaveCount(0);
    await page.getByTestId("maker-amount").fill("12");
    await expect(page.getByTestId("taker-amount")).toHaveValue("12");
  });

  test("token picker with logos: USDC works end to end through review, limits read for that token, never '$'", async ({ page }) => {
    const limitCalls: string[] = [];
    await setup(page, limitCalls);
    await page.getByTestId("stake-asset").click();
    await expect(page.locator(".astryx-selector-option-row")).toContainText(["USDC", "NEAR"]); // the tokens with an id on this network
    await expect(page.getByTestId("asset-logo-USDC").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await pickToken(page, "USDC");
    await expect(page.getByTestId("taker-token")).toHaveText("USDC");
    await expect.poll(() => limitCalls.includes(USDC_ID)).toBe(true);
    await page.getByTestId("maker-amount").fill("10");
    await expect(page.getByTestId("stake-limits")).toHaveText("Min 10 USDC · fee 0.50 USDC each");
    await page.getByTestId("maker-amount").fill("9");
    await expect(page.getByTestId("stake-error")).toHaveText("Minimum stake is 10 USDC");
    await page.getByTestId("maker-amount").fill("25");
    await page.getByTestId("taker-amount").fill("50");
    await expect(page.getByTestId("stake-limits")).toHaveText("Min 10 USDC · fee 0.50 USDC each"); // 1% of 25 and of 50 is not over the 0.50 minimum
    await page.getByTestId("taker-amount").fill("200");
    await expect(page.getByTestId("stake-limits")).toHaveText("Min 10 USDC · fee 0.50 USDC you, 2.00 USDC them");
    await page.getByTestId("taker-amount").fill("50");
    await expect(page.getByTestId("stake-section")).not.toContainText("$");
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("review-card")).toBeVisible();
    await expect(page.getByTestId("review-stakes")).toHaveText("You put in 25.00 USDC · they put in 50.00 USDC"); // C1: lib/money, USDC 2 dp
    await expect(page.getByTestId("review-term-pay-now")).toHaveText(/^25\.00 USDC( \(exactly 25\.\d+ USDC\))?$/);
  });

  test("inline errors: their stake below the minimum, and the 10:1 limit", async ({ page }) => {
    await setup(page);
    await page.getByTestId("maker-amount").fill("10");
    await page.getByTestId("taker-amount").fill("1");
    await expect(page.getByTestId("theirstake-error")).toHaveText("The other person's stake: Minimum stake is 2 NEAR");
    await page.getByTestId("taker-amount").fill("101");
    await expect(page.getByTestId("theirstake-error")).toHaveText("They can put in at most 10 times what you put in (100 NEAR).");
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("theirstake-error")).toHaveText("They can put in at most 10 times what you put in (100 NEAR)."); // C1 (UIR1 §3.4): the error shows once, under its field; Review is refused
    await expect(page.getByTestId("form-error")).toHaveCount(0);
    await expect(page.getByTestId("review-card")).toHaveCount(0);
    await page.getByTestId("taker-amount").fill("");
    await expect(page.getByTestId("theirstake-error")).toHaveText("Enter what they put in.");
  });

  test("Edit from the review keeps the token and both amounts (FE3)", async ({ page }) => {
    await setup(page);
    await pickToken(page, "USDC");
    await page.getByTestId("maker-amount").fill("40");
    await page.getByTestId("taker-amount").fill("60");
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("review-card")).toBeVisible();
    await page.getByTestId("back-to-create").click();
    await expect(page.getByTestId("step-resolver")).toBeVisible();
    await expect(page.getByTestId("stake-asset")).toContainText("USDC");
    await expect(page.getByTestId("maker-amount")).toHaveValue("40");
    await expect(page.getByTestId("taker-amount")).toHaveValue("60");
  });
});
