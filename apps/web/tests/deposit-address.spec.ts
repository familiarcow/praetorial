// FE2c / D-FUND1: /add-money deposit addresses (path 2) and "Move to betting balance" (path 3), fully mocked:
// NEAR RPC + the deposit API (bridge.chaindefuser.com) + the relayer via page.route, wallet via window.__e2eTestWallet.
// window.__e2eDepositApi = true stands in for the mainnet config (the dev server runs against testnet, where path 2 is off).
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { decodeSignedTransaction } from "@near-js/transactions";

const WALLET = "11".repeat(32);
const SIG = "22".repeat(64);
const RPC = "https://test.rpc.fastnear.com";
const API = "https://bridge.chaindefuser.com/rpc";
const RELAYER = "http://localhost:8788/relay";

// Live-shaped (FUND3 evidence/poa/supported_tokens_all.json): each entry names the intents token it credits. The Ethereum
// USDC/USDT entries credit bridged eth-0x….omft.near tokens the escrow rejects (FUND3 F1); DEPFIX1 must never offer them.
const USDC_NEAR = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const TOKENS = [
  ["btc:mainnet:native", "5000", 8, "nep141:btc.omft.near"], ["zec:mainnet:native", "1000000", 8, "nep141:zec.omft.near"],
  ["eth:1:native", "100000000000", 18, "nep141:eth.omft.near"],
  ["eth:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "1000", 6, "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near"],
  ["eth:1:0xdac17f958d2ee523a2206206994597c13d831ec7", "1000", 6, "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near"],
  ["near:mainnet:native", "100000000000000000000", 24, "nep141:wrap.near"],
  [`near:mainnet:${USDC_NEAR}`, "1", 6, `nep141:${USDC_NEAR}`], ["near:mainnet:usdt.tether-token.near", "1", 6, "nep141:usdt.tether-token.near"],
].map(([id, min, decimals, credited]) => ({ defuse_asset_identifier: id, min_deposit_amount: min, decimals, intents_token_id: credited }));
const ADDR: Record<string, string> = {
  "btc:mainnet": "bc1qvymvh8l7a5esd3mx69m2p0fnm8qyz64ljt8ugs", "zec:mainnet": "t1fCTLPgx2SHS6gjg42LPE2FJnxPykb1d83",
  "eth:1": "0x" + "ab".repeat(20), "near:mainnet": "e7bfbcdd109c023535a272d7ebf09f1faddfdaf96dd91f64b26bf021506c2a11",
};
// F3/F4: Add money is the Account page's one button; it opens F4's one-time-address sheet.
// (the header button, or the empty hero's on mainnet)
const openAddMoney = async (page: Page) => { await page.getByTestId("account-add-money").or(page.getByTestId("empty-add-money")).click(); await expect(page.getByTestId("add-money-sheet")).toBeVisible(); };

async function mockRpc(page: Page, o: { usdcInNear?: string; wnear?: string; nativeYocto?: string; txFailure?: unknown; events?: string[]; directs?: { receiver: string; method: string; deposit: bigint; signer: string }[] } = {}) {
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100, hash: "FDM3JkqRhGKqxqDqJm7cnzT1LgzDn3dHjkh8gCgV2tHB" } });
    // D-RELAYDEP1: a deposit-bearing call is a user-signed direct tx broadcast straight to the RPC, never relayed.
    if (body.method === "send_tx" || body.method === "broadcast_tx_async") {
      const raw = Array.isArray(params) ? params[0] : params.signed_tx_base64;
      const st = decodeSignedTransaction(Buffer.from(raw, "base64"));
      const fc = st.transaction.actions[0].functionCall!;
      o.directs?.push({ receiver: st.transaction.receiverId, method: fc.methodName, deposit: fc.deposit, signer: st.transaction.signerId });
      o.events?.push(`direct:${fc.methodName}`);
      return ok(body.method === "send_tx" ? { status: { SuccessValue: "" }, receipts_outcome: [] } : "DIRECTTX1111111111111111111111111111111111111");
    }
    // LIVE1: the final outcome of a relayed tx (receipt failures included) decides success, not the relayer's 200.
    if (body.method === "tx") return ok(o.txFailure ? { status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { Failure: o.txFailure } } }] } : { status: { SuccessValue: "" }, receipts_outcome: [] });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: o.nativeYocto ?? "0" });
    if (params.request_type === "call_function") {
      let r: unknown = null;
      if (params.method_name === "is_paused" || params.method_name === "is_shutdown") r = false;
      else if (params.method_name === "open_offers") r = [];
      else if (params.method_name === "mt_balance_of") r = "0";
      else if (params.method_name === "ft_balance_of") r = params.account_id === "usdc.testnet" ? (o.usdcInNear ?? "0") : params.account_id === "wrap.testnet" ? (o.wnear ?? "0") : "0";
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
}

type ApiState = { calls: any[]; mode: "ok" | "error" | "wrong" | "unsupported" };
async function mockApi(page: Page, mode: ApiState["mode"] = "ok") {
  const st: ApiState = { calls: [], mode };
  await page.route(API, async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(req.postData() ?? "{}");
    st.calls.push(body);
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(b) });
    if (body.method === "supported_tokens") return json({ id: 1, jsonrpc: "2.0", result: { tokens: TOKENS } });
    const p = body.params[0];
    if (st.mode === "error") return json({ error: "boom" }, 500);
    if (st.mode === "unsupported") return json({ id: 1, jsonrpc: "2.0", error: "Chain not supported" });
    if (st.mode === "wrong") return json({ id: 1, jsonrpc: "2.0", result: { address: ADDR[p.chain], chain: p.chain, account_id: "attacker.near" } });
    return json({ id: 1, jsonrpc: "2.0", result: { address: ADDR[p.chain], chain: p.chain } });
  });
  return st;
}

async function mockRelayer(page: Page, events?: string[]) {
  const calls: any[] = [];
  await page.route(RELAYER, async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    calls.push(JSON.parse(req.postData() ?? "{}"));
    events?.push("relay");
    return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ ok: true, txHash: "tx" + calls.length }) });
  });
  return calls;
}

async function signedIn(page: Page, depositApi: boolean) {
  await page.addInitScript(({ address, sig, depositApi }) => {
    (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => sig };
    if (depositApi) (window as any).__e2eDepositApi = true;
  }, { address: WALLET, sig: SIG, depositApi });
  // F3: with the mainnet seam the Account page also reads 1Click's token list (names and prices of stray tokens, the ≈ $ total).
  if (depositApi) await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
}
const ready = (page: Page) => page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });

// F4 (familiarcow UX-37 FUND 13, D-FUND4a): the per-token PERMANENT bridge addresses (FE2c / DEPFIX1 cards) are gone from the UI.
// Add money is always a one-time address (tests/funding/fund-sheet.spec.ts covers that flow end to end). What stays from FE2c here:
// the bridge is never asked for an address, and the user's own NEAR account id is never offered as a deposit address.
test.describe("F4: no permanent deposit addresses (mainnet config)", () => {
  test("Add money opens 'What do you have?'; the bridge is never asked; the account id is never shown as a deposit address", async ({ page }) => {
    await signedIn(page, true);
    await mockRpc(page);
    const api = await mockApi(page);
    await page.goto("/add-money");
    await ready(page);
    await openAddMoney(page);
    await expect(page.getByTestId("fund-sheet")).toBeVisible(); // ACCT2: one path (no "From near.com" tab), so no tab bar at all
    await expect(page.getByTestId("add-money-sheet").getByRole("tablist")).toHaveCount(0);
    await expect(page.locator("[data-testid^='deposit-toggle-'], [data-testid^='deposit-address-']")).toHaveCount(0);
    await expect(page.getByTestId("add-money-sheet")).not.toContainText(WALLET);
    await expect(page.getByText("Send money to your Praetorial address")).toHaveCount(0);
    expect(api.calls.filter((c) => c.method === "deposit_address")).toEqual([]);
  });
});

test.describe("FE2c testnet config: path 3 only + 'available on mainnet'", () => {
  test("no deposit API calls, no addresses, the mainnet note is shown", async ({ page }) => {
    await signedIn(page, false);
    await mockRpc(page);
    const api = await mockApi(page);
    await page.goto("/add-money");
    await ready(page);
    await expect(page.getByTestId("add-money")).toBeVisible();
    await page.getByTestId("account-add-money").or(page.getByTestId("empty-add-money")).click();
    await expect(page.getByTestId("deposit-mainnet-note")).toHaveText("Deposit addresses are available on mainnet. On this test network you can only move money you already hold on NEAR.");
    await expect(page.locator("[data-testid^='deposit-address']")).toHaveCount(0);
    expect(api.calls.length).toBe(0);
  });
});

test.describe("FE2c Move to betting balance (path 3)", () => {
  test("hidden when the NEAR account holds no launch asset", async ({ page }) => {
    await signedIn(page, false);
    await mockRpc(page);
    await page.goto("/add-money");
    await ready(page);
    await expect(page.getByTestId("add-money")).toBeVisible();
    await expect(page.locator("[data-testid^='move-USDC-'], [data-testid^='move-USDT-'], [data-testid^='move-NEAR-']")).toHaveCount(0);
  });

  test("USDC held in the NEAR account: one tap relays one ft_transfer_call and says it moved", async ({ page }) => {
    await signedIn(page, false);
    await mockRpc(page, { usdcInNear: "7000000" });
    const relayed = await mockRelayer(page);
    await page.goto("/add-money");
    await ready(page);
    await expect(page.getByTestId("move-USDC-token")).toContainText("7.00 USDC");
    await page.getByTestId("move-USDC-token").click();
    await page.getByTestId("move-confirm").click(); // MODAL1c5: the move is confirmed in its own modal
    await expect(page.getByTestId("move-result")).toHaveText("Moved to your betting balance."); // MODAL1c5: the result is in the modal
    expect(relayed.length).toBe(1);
    expect(typeof relayed[0].signedDelegate).toBe("string");
  });

  // D-RELAYDEP1 supersedes the old "two relayed transactions" rule: NEP-366 makes the relayer pay any deposit inside a relayed
  // delegate, so the near_deposit wrap is a transaction the USER signs and pays (direct to the RPC); only the 1-yocto
  // ft_transfer_call is relayed. Order is still wrap first, transfer second.
  test("native NEAR (D-RELAYDEP1): the wrap is a user-signed direct tx, then exactly one relayed ft_transfer_call, then done", async ({ page }) => {
    await signedIn(page, false);
    const events: string[] = [];
    const directs: { receiver: string; method: string; deposit: bigint; signer: string }[] = [];
    // wNEAR read after the deposit: 2 NEAR minus wrap's 0.00125 NEAR first-deposit storage fee (LIVE1 2a: the transfer
    // moves this actual balance; the amount itself is pinned in tests/moveRun.unit.test.ts).
    await mockRpc(page, { nativeYocto: "2050000000000000000000000", wnear: "1998750000000000000000000", events, directs });
    const relayed = await mockRelayer(page, events);
    await page.goto("/add-money");
    await ready(page);
    await expect(page.getByTestId("move-NEAR-native")).toContainText("2 NEAR");
    await page.getByTestId("move-NEAR-native").click();
    await page.getByTestId("move-confirm").click(); // MODAL1c5: the move is confirmed in its own modal
    await expect(page.getByTestId("move-result")).toHaveText("Moved to your betting balance."); // MODAL1c5: the result is in the modal
    expect(directs.length).toBe(1);
    expect(directs[0].method).toBe("near_deposit");
    expect(directs[0].receiver).toBe("wrap.testnet");
    expect(directs[0].deposit > 0n).toBe(true);
    expect(relayed.length).toBe(1);
    expect(typeof relayed[0].signedDelegate).toBe("string");
    expect(events).toEqual(["direct:near_deposit", "relay"]); // the user-signed wrap lands before the relayed transfer
  });

  test("relayer refusal is shown plainly, never as success", async ({ page }) => {
    await signedIn(page, false);
    await mockRpc(page, { usdcInNear: "7000000" });
    await page.route(RELAYER, async (route) => {
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ ok: false, error: "policy" }) });
    });
    await page.goto("/add-money");
    await ready(page);
    await page.getByTestId("move-USDC-token").click();
    await page.getByTestId("move-confirm").click(); // MODAL1c5: the move is confirmed in its own modal
    await expect(page.getByTestId("move-result")).toContainText("We couldn't move your money");
    // LIVE1 2c: the relayer's own reason is shown under the friendly message.
    await expect(page.getByTestId("move-error-detail")).toContainText("policy");
    await expect(page.getByTestId("flow-success")).toHaveCount(0);
  });

  test("LIVE1 2b: relayer says ok but the transaction failed on chain -> failure with the chain's reason, never 'Moved'", async ({ page }) => {
    await signedIn(page, false);
    await mockRpc(page, { usdcInNear: "7000000", txFailure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: The account doesn't have enough balance" } } } } });
    await mockRelayer(page);
    await page.goto("/add-money");
    await ready(page);
    await page.getByTestId("move-USDC-token").click();
    await page.getByTestId("move-confirm").click(); // MODAL1c5: the move is confirmed in its own modal
    await expect(page.getByTestId("move-result")).toContainText("We couldn't move your money");
    await expect(page.getByTestId("move-error-detail")).toContainText("enough balance");
    await expect(page.getByTestId("flow-success")).toHaveCount(0);
  });
});
