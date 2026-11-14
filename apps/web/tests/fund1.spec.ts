// FUND1 (mocked): NEAR visible in the account always has a working way to move it, or a plain reason; the missing amount is exact;
// on testnet an empty wallet gets a "Get test NEAR" path. Same mocks as deposit-address.spec.ts.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";

const WALLET = "11".repeat(32);
const SIG = "22".repeat(64);
const RPC = "https://test.rpc.fastnear.com";
const RELAYER = "http://localhost:8788";
const near = (s: string) => (BigInt(Math.round(Number(s) * 1e6)) * 10n ** 18n).toString();

async function mockRpc(page: Page, o: { native?: string; wnear?: string; usdcFails?: boolean; mt?: string } = {}) { // o is read per request, so a test can change it mid-flow
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (params.request_type === "view_account") return ok({ amount: o.native ?? "0" });
    if (params.request_type === "call_function") {
      if (params.method_name === "ft_balance_of" && params.account_id === "usdc.testnet" && o.usdcFails) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", error: { name: "HANDLER_ERROR", cause: { name: "CONTRACT_EXECUTION_ERROR" } } }) });
      let r: unknown = null;
      if (params.method_name === "is_paused" || params.method_name === "is_shutdown") r = false;
      else if (params.method_name === "open_offers") r = [];
      else if (params.method_name === "mt_balance_of") r = o.mt ?? "0";
      else if (params.method_name === "ft_balance_of") r = params.account_id === "wrap.testnet" ? (o.wnear ?? "0") : "0";
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
}
async function signedIn(page: Page) {
  await page.addInitScript(({ address, sig }) => { (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => sig }; }, { address: WALLET, sig: SIG });
}
const ready = (page: Page) => page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });

test.describe("FUND1 add money guide", () => {
  for (const [have, move] of [["0.5", "0.45 NEAR"], ["2", "1.95 NEAR"], ["10", "9.95 NEAR"]]) {
    test(`${have} NEAR in the account: a Move button for ${move} is shown`, async ({ page }) => {
      await signedIn(page); await mockRpc(page, { native: near(have) });
      await page.goto("/add-money"); await ready(page);
      await expect(page.getByTestId("move-NEAR-native")).toContainText(move);
    });
  }

  test("a failed USDC read does not hide the NEAR the user can see", async ({ page }) => {
    await signedIn(page); await mockRpc(page, { native: near("2"), usdcFails: true });
    await page.goto("/add-money"); await ready(page);
    await expect(page.getByTestId("move-NEAR-native")).toContainText("1.95 NEAR");
    await expect(page.getByTestId("funding-note").first()).toContainText("couldn't read your USDC");
  });

  test("wNEAR only: movable", async ({ page }) => {
    await signedIn(page); await mockRpc(page, { wnear: near("1.5") });
    await page.goto("/add-money"); await ready(page);
    await expect(page.getByTestId("move-NEAR-token")).toContainText("1.5 NEAR");
  });

  test("0.04 NEAR (under the 0.05 reserve): says why nothing can be moved, offers test NEAR", async ({ page }) => {
    await signedIn(page); await mockRpc(page, { native: near("0.04") });
    await page.goto("/add-money"); await ready(page);
    await expect(page.locator("[data-testid^='move-NEAR-'], [data-testid^='move-USDC-']")).toHaveCount(0); // NAV1: no Move button on any card
    await expect(page.getByTestId("funding-note").first()).toContainText("0.05 NEAR stays in your NEAR account");
    await expect(page.getByTestId("get-test-near")).toBeVisible();
  });

  test("empty wallet on testnet: Get test NEAR is offered", async ({ page }) => {
    await signedIn(page); await mockRpc(page);
    await page.goto("/add-money"); await ready(page);
    await expect(page.getByTestId("get-test-near")).toBeVisible();
    // FUND1b: no external link any more; a real button that asks our own server faucet.
    await expect(page.getByTestId("get-test-near")).toHaveJSProperty("tagName", "BUTTON");
  });

  test("FUND1b: one click on Get test NEAR funds the account through the server faucet and refreshes the balance", async ({ page }) => {
    await signedIn(page);
    const o: { native?: string } = {}; await mockRpc(page, o);
    const posts: any[] = [];
    await page.route(`${RELAYER}/faucet`, async (r) => { posts.push(JSON.parse(r.request().postData() ?? "{}")); o.native = near("1"); await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: "FAUCETTX", amountNear: "1" }) }); });
    await page.goto("/add-money"); await ready(page);
    await page.getByTestId("get-test-near").click();
    await expect(page.getByTestId("faucet-result")).toContainText("1 test NEAR is on its way");
    expect(posts).toEqual([{ account: WALLET }]);
    await expect(page.getByTestId("move-NEAR-native")).toContainText("0.95 NEAR");
  });

  test("FUND1b: a faucet refusal shows the server's plain sentence, no navigation", async ({ page }) => {
    await signedIn(page); await mockRpc(page);
    await page.route(`${RELAYER}/faucet`, (r) => r.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ ok: false, error: "This account already got test NEAR today. Try again tomorrow." }) }));
    await page.goto("/add-money"); await ready(page);
    await page.getByTestId("get-test-near").click();
    await expect(page.getByTestId("faucet-result")).toContainText("already got test NEAR today");
    await expect(page).toHaveURL(/\/account/); // NAV1: /add-money is the Wallet page
  });

  test("need 3 NEAR, wallet holds 2: exact missing amount and what's left after moving", async ({ page }) => {
    await signedIn(page); await mockRpc(page, { native: near("2") });
    await page.goto("/add-money?asset=NEAR&need=3"); await ready(page);
    await expect(page.getByTestId("missing-amount")).toContainText("3 NEAR missing");
    await expect(page.getByTestId("missing-amount")).toContainText("1.05 NEAR still to add");
    await expect(page.getByTestId("get-test-near")).toBeVisible();
  });

  test("need 3 NEAR, wallet holds 10: covered by moving; no faucet", async ({ page }) => {
    await signedIn(page); await mockRpc(page, { native: near("10") });
    await page.goto("/add-money?asset=NEAR&need=3"); await ready(page);
    await expect(page.getByTestId("missing-amount")).toContainText("You can cover it by moving");
    await expect(page.getByTestId("get-test-near")).toHaveCount(0);
  });
});
