// UX-28 (mocked): a permanent "Balance" entry in the header on every signed-in page shows the betting balance and opens Add money,
// which has clear Deposit (move from wallet) and Withdraw (to wallet) buttons; wallet NEAR is shown with its own Deposit.
// A signed-in user with a NONZERO balance reaches Move and Withdraw from home in <= 2 clicks. Same mocks as fund1.spec.ts.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";

const WALLET = "11".repeat(32);
const SIG = "22".repeat(64);
const RPC = "https://test.rpc.fastnear.com";
const near = (s: string) => (BigInt(Math.round(Number(s) * 1e6)) * 10n ** 18n).toString();

async function mockRpc(page: Page, o: { native?: string; usdc?: string; wnearIntents?: string } = {}) {
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (params.request_type === "view_account") return ok({ amount: o.native ?? "0" });
    if (params.request_type === "call_function") {
      const args = JSON.parse(Buffer.from(params.args_base64 ?? "e30=", "base64").toString("utf8") || "{}");
      let r: unknown = null;
      if (params.method_name === "is_paused" || params.method_name === "is_shutdown") r = false;
      else if (params.method_name === "open_offers") r = [];
      else if (params.method_name === "mt_balance_of") r = args.token_id === "nep141:usdc.testnet" ? (o.usdc ?? "0") : (o.wnearIntents ?? "0");
      else if (params.method_name === "ft_balance_of") r = "0";
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
}
async function signedIn(page: Page) {
  await page.addInitScript(({ address, sig }) => { (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => sig }; }, { address: WALLET, sig: SIG });
}
const ready = (page: Page) => page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
const rich = { native: near("5"), usdc: "500000000", wnearIntents: near("20") };

// NAV1 (UX-31): the header "Balance" entry is replaced by the permanent Wallet tab (Home / About / Wallet), whose page shows the
// betting balance at the top. The UX-28 rule (reach Move and Withdraw from home in <= 2 clicks, on every signed-in page) still holds.
test.describe("UX-28 Balance entry (NAV1: the Wallet tab)", () => {
  test("home -> Account (1 click) -> Move opens Move (2 clicks)", async ({ page }) => {
    await signedIn(page); await mockRpc(page, rich);
    await page.goto("/"); await ready(page);
    const entry = page.getByTestId("nav-account");
    await expect(entry).toHaveText("Account"); // F3: "Wallet" is "Account" (it shows @username when the user has one)
    await entry.click();
    await expect(page.getByTestId("add-money")).toBeVisible();
    await expect(page.getByTestId("balance-row-USDC")).toHaveText("500.00 USDC");
    await expect(page.getByTestId("balance-row-NEAR")).toHaveText("20 NEAR");
    // NEAR on the NEAR account is shown with its own Move button (5 NEAR held, 4.95 movable after the 0.05 reserve).
    await expect(page.getByTestId("wallet-amount-NEAR")).toHaveText("In your NEAR account: 5 NEAR");
    const move = page.getByTestId("move-NEAR-native");
    await expect(move).toHaveText("Move 4.95 NEAR to betting");
    await move.click();
    await expect(page.locator("dialog[open]").last().getByTestId("move-terms")).toBeVisible();
  });

  // F3 (FUND4 SPEC §3: "Rows stay plain, and the actions live in the sheet"): cash out to the NEAR account is one tap further, in
  // the token sheet (Account -> USDC -> Cash out to my NEAR account). Move stays on the row (2 clicks).
  test("home -> Account (1 click) -> USDC (2) -> Cash out to my NEAR account opens the form (3 clicks)", async ({ page }) => {
    await signedIn(page); await mockRpc(page, rich);
    await page.goto("/"); await ready(page);
    await page.getByTestId("nav-account").click();
    await page.getByTestId("asset-row-USDC").click();
    const w = page.getByTestId("withdraw-btn-USDC");
    await expect(w).toHaveText("Cash out to my NEAR account");
    await w.click();
    await expect(page.getByTestId("withdraw-amount-USDC")).toBeVisible();
  });

  test("the Account tab is on every signed-in page, and not shown signed out", async ({ page }) => {
    await signedIn(page); await mockRpc(page, rich);
    for (const p of ["/", "/about", "/account", "/wallet", "/settings", "/bet/1"]) {
      await page.goto(p); await ready(page);
      await expect(page.getByTestId("nav-account"), p).toBeVisible();
    }
  });

  test("signed out: no Account tab", async ({ page }) => {
    await mockRpc(page, rich);
    await page.goto("/"); await ready(page);
    await expect(page.getByTestId("nav-account")).toHaveCount(0);
  });
});
