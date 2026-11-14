// FE7 (S7): ReviewCard v2, AI and human variants. Fully mocked: NEAR RPC, source check, relayer, wallet seam.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { readFileSync } from "node:fs";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const WASM = JSON.parse(readFileSync(new URL("../lib/release.json", import.meta.url), "utf8")).resolver_wasm_hash;

async function setup(page: Page) {
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
      switch (params.method_name) {
        case "is_paused": case "is_shutdown": r = false; break;
        case "open_offers": r = []; break;
        case "asset_limit": r = { storage_per_kib: "1" }; break;
        case "resolver_keys": r = ["a", "b", WASM]; break;
        case "mt_balance_of": r = "1" + "0".repeat(30); break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  await page.route("**/ticker**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ venue: "x", price: 1 }) }));
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto("/new");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
}
async function toReview(page: Page, human: boolean, tip = false) {
  await setup(page);
  await page.getByTestId("bet-type-card-nws_daily_high").click();
  await page.getByTestId("guided-station").selectOption("KNYC");
  await page.getByTestId("guided-date").fill("2027-12-08");
  await page.getByTestId("guided-op").selectOption(">=");
  await page.getByTestId("guided-x_f").fill("72");
  await page.getByTestId("fill-next").click();
  if (human) {
    await page.getByTestId("decider-person").check();
    await page.getByTestId("referee-search").fill("alic");
    await page.getByTestId("referee-result-0").click();
    if (tip) await page.getByTestId("tip-maker-checkbox").check();
  }
  await page.getByTestId("maker-amount").fill("10");
  await page.getByTestId("review-offer").click();
  await expect(page.getByTestId("review-card")).toBeVisible();
}

// C1 (UIR1 §3.4, familiarcow UX-37 #5): the FE7 blocks (pay-now, deadlines, worst case, refunds) are the rows of the collapsed "Full terms".
test.describe("FE7 review card v2", () => {
  test("AI variant: pay-now, deadlines, worst case, refund rules in Full terms; the AI decides", async ({ page }) => {
    await toReview(page, false);
    const terms = page.getByTestId("review-full-terms");
    await expect(terms).toHaveJSProperty("open", false);
    await terms.locator("summary").click();
    await expect(terms.locator("dt")).toContainText(["Your stake", "Your storage charge", "You pay now"]);
    await expect(page.getByTestId("review-term-pay-now")).toHaveText(/^\d[\d.]* NEAR( \(exactly \d[\d.]* NEAR\))?$/);
    await expect(page.getByTestId("review-term-fee")).toContainText("at least");
    await expect(page.getByTestId("review-term-offer-closes")).toContainText("UTC");
    await expect(page.getByTestId("review-term-event")).not.toBeEmpty();
    await expect(page.getByTestId("review-term-window")).toHaveText("24h to challenge a ruling, 2 rounds.");
    await expect(page.getByTestId("review-term-worst-case")).toContainText("You can't lose more than what you pay now.");
    const r = page.getByTestId("review-term-refunds");
    await expect(r).toContainText("Nobody takes it: full refund.");
    await expect(r).toContainText("The AI can't decide (VOID): you both get your stakes back and no fee is charged.");
    await expect(r).toContainText("If the app is shut down, anyone can trigger a full refund.");
    await expect(page.getByTestId("review-decider")).toHaveText(/^The AI judge/);
  });
  test("human variant: a person decides (no AI), referee-silent refund, tip row", async ({ page }) => {
    await toReview(page, true, true);
    await expect(page.getByTestId("review-decider")).toHaveText(/^@\w+, a person \(no AI\)$/);
    await expect(page.getByTestId("review-term-window")).toHaveText(/^@\w+ can rule any time until .+ UTC\. If they don't, you're both refunded\.$/);
    await expect(page.getByTestId("review-full-terms").locator("dt", { hasText: "Challenges" })).toHaveCount(0);
    await expect(page.getByTestId("review-term-refunds")).toContainText("The referee never rules: you're both refunded on");
    await expect(page.getByTestId("review-term-refunds")).not.toContainText("The AI can't decide");
    await expect(page.getByTestId("review-term-tip")).toContainText("Tip to the referee:");
  });
});
