// LIVE2 / WITHDRAW1: "Withdraw to wallet" on the balance screen (/add-money), fully mocked: NEAR RPC (stateful intents + wNEAR
// balances) and the relayer via page.route, wallet via window.__e2eTestWallet. Success is judged from chain state, not the 200.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";

const WALLET = "11".repeat(32);
const SIG = "22".repeat(64);
const RPC = "https://test.rpc.fastnear.com";
const RELAYER = "http://localhost:8788/relay";
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };

type St = { intentsNear: bigint; walletNear: bigint; registered: boolean; relayed: string[]; direct?: string[]; refuse?: string; neverArrives?: boolean; unknownOutcome?: boolean; statusAsks?: number };
async function mock(page: Page, st: St) {
  await page.addInitScript(({ address, sig }) => { (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => sig }; }, { address: WALLET, sig: SIG });
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100, hash: "FDM3JkqRhGKqxqDqJm7cnzT1LgzDn3dHjkh8gCgV2tHB" } });
    if (body.method === "tx") return ok({ status: { SuccessValue: "" }, receipts_outcome: [] });
    if (body.method === "send_tx") { // SEC1/MON-1: the user-signed registration goes straight to the RPC, never the relayer
      const raw = Buffer.from(params.signed_tx_base64 ?? "", "base64");
      const m = raw.includes(Buffer.from("storage_deposit")) ? "storage_deposit" : "other";
      (st.direct ??= []).push(m);
      if (m === "storage_deposit") st.registered = true;
      return ok({ status: { SuccessValue: "" }, transaction: { hash: "dtx" + st.direct.length }, transaction_outcome: { id: "dtx" + st.direct.length } });
    }
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "0" });
    if (params.request_type === "call_function") {
      const a = JSON.parse(Buffer.from(params.args_base64 ?? "", "base64").toString() || "{}");
      let r: unknown = null;
      switch (params.method_name) {
        case "is_paused": case "is_shutdown": r = false; break;
        case "open_offers": r = []; break;
        case "mt_balance_of": r = a.token_id === "nep141:wrap.testnet" ? st.intentsNear.toString() : "0"; break;
        case "ft_balance_of": r = params.account_id === "wrap.testnet" ? st.walletNear.toString() : "0"; break;
        case "storage_balance_of": r = st.registered ? { total: "1250000000000000000000", available: "0" } : null; break;
        case "storage_balance_bounds": r = { min: "1250000000000000000000", max: "1250000000000000000000" }; break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  await page.route(RELAYER, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const raw = Buffer.from(JSON.parse(req.postData() ?? "{}").signedDelegate ?? "", "base64");
    const method = raw.includes(Buffer.from("ft_withdraw")) ? "ft_withdraw" : raw.includes(Buffer.from("storage_deposit")) ? "storage_deposit" : "other";
    st.relayed.push(method);
    if (st.refuse) return route.fulfill({ status: 400, contentType: "application/json", headers: cors, body: JSON.stringify({ ok: false, error: st.refuse }) });
    if (method === "storage_deposit") st.registered = true;
    if (method === "ft_withdraw" && st.registered && !st.neverArrives) { st.intentsNear -= 10n ** 24n; st.walletNear += 10n ** 24n; }
    // SEC1/MON-2: the relayer handed it to NEAR (it executed) but got no answer back in time
    if (st.unknownOutcome) return route.fulfill({ status: 202, contentType: "application/json", headers: cors, body: JSON.stringify({ ok: false, status: "unknown", txHash: "UNKNOWNTX", error: "sent to NEAR, but the result is not known yet" }) });
    return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ ok: true, txHash: "tx" + st.relayed.length }) });
  });
}
async function mockStatus(page: Page, st: St) {
  await page.route(`${RELAYER}/status`, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    st.statusAsks = (st.statusAsks ?? 0) + 1;
    return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ ok: true, state: "pending", txHash: "UNKNOWNTX" }) });
  });
}
const ready = (page: Page) => page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
const fresh = (o: Partial<St> = {}): St => ({ intentsNear: 3n * 10n ** 24n, walletNear: 0n, registered: true, relayed: [], ...o });

// MODAL1c5: Withdraw is a two-step modal (amount, then a read-out and confirm) opened from the balance row.
const startWithdraw = async (page: Page, amount: string) => {
  await page.getByTestId("asset-row-NEAR").click(); // F3: Cash out to my NEAR account is in the token sheet
  await page.getByTestId("withdraw-btn-NEAR").click();
  await page.getByTestId("withdraw-amount-NEAR").fill(amount);
  await page.getByTestId("withdraw-review").click();
};
const confirmWithdraw = (page: Page) => page.getByTestId("withdraw-confirm").click();

test.describe("LIVE2 WITHDRAW1 withdraw to wallet", () => {
  test("withdraw 1 NEAR: one relayed ft_withdraw, success only after the wallet balance rose, balance refreshed", async ({ page }) => {
    const st = fresh();
    await mock(page, st);
    await page.goto("/add-money"); await ready(page);
    await expect(page.getByTestId("balance-row-NEAR")).toContainText("3 NEAR");
    await startWithdraw(page, "1");
    await confirmWithdraw(page);
    await expect(page.getByTestId("withdraw-result")).toContainText("1 NEAR is in your wallet");
    await page.getByTestId("flow-done").click();
    await expect(page.getByTestId("withdraw-status-NEAR")).toContainText("1 NEAR is in your wallet");
    await expect(page.getByTestId("balance-row-NEAR")).toContainText("2 NEAR");
    expect(st.relayed).toEqual(["ft_withdraw"]);
  });
  test("Max fills the whole balance; an unregistered wallet is registered first (user-signed storage_deposit, then relayed ft_withdraw)", async ({ page }) => {
    const st = fresh({ intentsNear: 10n ** 24n, registered: false });
    await mock(page, st);
    await page.goto("/add-money"); await ready(page);
    await page.getByTestId("asset-row-NEAR").click(); // F3: token sheet
    await page.getByTestId("withdraw-btn-NEAR").click();
    await page.getByTestId("withdraw-max-NEAR").click();
    await expect(page.getByTestId("withdraw-amount-NEAR")).toHaveValue("1");
    await page.getByTestId("withdraw-review").click();
    await confirmWithdraw(page);
    await expect(page.getByTestId("withdraw-result")).toContainText("is in your wallet");
    expect(st.direct).toEqual(["storage_deposit"]);
    expect(st.relayed).toEqual(["ft_withdraw"]);
  });
  test("relayer refusal: plain message plus the relayer's own reason, never success", async ({ page }) => {
    const st = fresh({ refuse: 'ft_withdraw receiver_id must be the signer' });
    await mock(page, st);
    await page.goto("/add-money"); await ready(page);
    await startWithdraw(page, "1");
    await confirmWithdraw(page);
    await expect(page.getByTestId("withdraw-result")).toContainText("We couldn't withdraw your money");
    await expect(page.getByTestId("withdraw-error-detail")).toContainText("receiver_id must be the signer");
    await expect(page.getByTestId("flow-success")).toHaveCount(0);
  });
  test("clean tx but the tokens never arrive (intents refunded): reported as a failure", async ({ page }) => {
    const st = fresh({ neverArrives: true });
    await mock(page, st);
    await page.goto("/add-money"); await ready(page);
    await startWithdraw(page, "1");
    await confirmWithdraw(page);
    await expect(page.getByTestId("withdraw-error-detail")).toContainText("did not arrive", { timeout: 15_000 });
  });
  test("more than the balance is refused before anything is relayed", async ({ page }) => {
    const st = fresh();
    await mock(page, st);
    await page.goto("/add-money"); await ready(page);
    await page.getByTestId("asset-row-NEAR").click(); // F3: token sheet
    await page.getByTestId("withdraw-btn-NEAR").click();
    await page.getByTestId("withdraw-amount-NEAR").fill("4");
    await page.getByTestId("withdraw-review").click();
    await expect(page.getByTestId("flow-error")).toContainText("more than your betting balance");
    expect(st.relayed).toEqual([]);
  });
  test("SEC1/MON-2: relayer answers 'outcome unknown' -> 'Checking whether it went through', never 'couldn't withdraw'; nothing is signed again", async ({ page }) => {
    const st = fresh({ unknownOutcome: true });
    await mock(page, st); await mockStatus(page, st);
    await page.goto("/add-money"); await ready(page);
    await startWithdraw(page, "1");
    await confirmWithdraw(page);
    await expect(page.getByTestId("flow-pending")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("withdraw-result")).toContainText("Checking whether it went through");
    await expect(page.getByText("We couldn't withdraw your money")).toHaveCount(0);
    expect(st.relayed).toEqual(["ft_withdraw"]);
    expect(st.statusAsks ?? 0).toBeGreaterThan(0); // it asked the relayer instead of guessing
    const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("praetorial.inflight.")).length);
    expect(stored).toBe(1); // kept for the next attempt / a reload
  });
});
