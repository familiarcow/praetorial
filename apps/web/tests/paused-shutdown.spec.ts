// Paused / shutdown banner + Emergency refund, fully mocked (NEAR RPC
// view calls + the relayer's POST /relay via route interception) --
// no real Privy login. The wallet needed to sign/relay the refund
// call is injected via window.__e2eTestWallet (App.tsx's test-only
// seam), added before the page's own scripts run.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";

const RELAYER_URL = "http://localhost:8788";
const TEST_WALLET_ADDRESS = "11".repeat(32); // 64 hex chars, implicit-account shaped
const TEST_SIGNATURE_HEX = "22".repeat(64); // 64-byte ed25519 signature shape

function betResult(overrides: Record<string, any> = {}) {
  const base = {
    envelope: {
      bet_id: 1,
      version: 1,
      maker: "maker.testnet",
      taker_allow: "Any",
      terms_hash: "deadbeefdeadbeefdeadbeefdeadbeef",
      models_snapshot_hash: "x",
      outcomes: ["YES", "NO"],
      maker_side: "YES",
      maker_asset: "nep141:usdc.testnet",
      taker_asset: "nep141:usdc.testnet",
      stake_maker: "100000000",
      stake_taker: "100000000",
      taker_options: [],
      fee_bps: 100,
      reserve_per_side: "0",
      storage_charge_per_side: "0",
      keep_terms: false,
      terms: null,
      run_price: "0",
      max_paid_runs: 3,
      tier: 1,
      arbiter: null,
      arbiter_fee: "0",
      funding_deadline: Date.now() * 1_000_000 + 7 * 24 * 3600 * 1_000_000_000,
      early_settle_outcome: null,
      finality_delay: 0,
      settlement_period: 24 * 3600 * 1_000_000_000,
      resolve_deadline: 0,
      consent_party_controlled: false,
      referee: null,
    },
    status: "Open",
    taker: "taker.testnet",
    created_at: 0,
    taken_at: null,
    proposed_at: null,
    outcome: null,
    reserve_remaining: "0",
    bonds: [],
    exhibits: [],
    challenged_by: null,
    window_extension_ns: 0,
  };
  return { ...base, ...overrides, envelope: { ...base.envelope, ...(overrides.envelope ?? {}) } };
}

function rpcResultBytes(resultObj: unknown) {
  return Array.from(Buffer.from(JSON.stringify(resultObj), "utf8"));
}

// Mocks every RPC call the app can make: view-function calls (get_bet,
// is_paused, is_shutdown, required_challenge_bond, open_offers) plus
// the access-key-nonce/block-height lookups useRelayAction needs to
// build a delegate action before it ever touches the relayer.
async function mockRpc(page: Page, opts: { bet?: any; paused?: boolean; shutdown?: boolean }) {
  await page.route("https://test.rpc.fastnear.com", async (route) => {
    const req = route.request();
    const body = JSON.parse(req.postData() ?? "{}");
    const params = body.params ?? {};

    if (body.method === "block") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: "1", result: { header: { height: 100 } } }),
      });
      return;
    }
    if (params.request_type === "view_access_key") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: "1", result: { nonce: 1 } }),
      });
      return;
    }
    if (params.request_type === "call_function") {
      const argsJson = JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8"));
      let resultObj: unknown = null;
      if (params.method_name === "get_bet") {
        resultObj = argsJson.bet_id === 1 ? opts.bet ?? null : null;
      } else if (params.method_name === "is_paused") {
        resultObj = !!opts.paused;
      } else if (params.method_name === "is_shutdown") {
        resultObj = !!opts.shutdown;
      } else if (params.method_name === "required_challenge_bond") {
        resultObj = null;
      } else if (params.method_name === "open_offers") {
        resultObj = [];
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: "1", result: { result: rpcResultBytes(resultObj) } }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result: {} }) });
  });
}

async function injectTestWallet(page: Page) {
  await page.addInitScript(
    ({ address, sig }) => {
      (window as any).__e2eTestWallet = {
        nearAddress: address,
        signRawHash: async (_addr: string, _hashHex: string) => sig,
      };
    },
    { address: TEST_WALLET_ADDRESS, sig: TEST_SIGNATURE_HEX },
  );
}

test.describe("Paused / shutdown banner (mocked RPC, injected test wallet)", () => {
  // LOGIN1 (UX-29): logged out is only the login page, so the banners are checked signed in.
  test.beforeEach(async ({ page }) => { await injectTestWallet(page); });
  test("new_offers_paused: banner shown, Create offer disabled with an explanation", async ({ page }) => {
    await mockRpc(page, { paused: true, shutdown: false });
    await page.goto("/");
    await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
    await expect(page.getByTestId("banner-paused")).toBeVisible();
    await expect(page.getByTestId("banner-paused")).toContainText("New bets are paused.");
    await expect(page.getByTestId("banner-shutdown")).toHaveCount(0);
    await expect(page.getByTestId("nav-create")).toBeDisabled();
    // A1 (UIR1 §3.10): the paused line is inside the one page notice; no second note under the nav.
    await expect(page.getByTestId("banner-paused")).toContainText("You can't make or take a bet right now");
    await expect(page.getByTestId("create-disabled-note")).toHaveCount(0);
  });

  test("emergency_shutdown: banner shown, Create offer disabled, refunds-available message", async ({ page }) => {
    await mockRpc(page, { paused: true, shutdown: true });
    await page.goto("/");
    await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
    await expect(page.getByTestId("banner-shutdown")).toBeVisible();
    await expect(page.getByTestId("banner-shutdown")).toContainText("Praetorial is shut down");
    // Shutdown implies paused contract-side; the shutdown banner takes
    // priority over the paused one rather than showing both.
    await expect(page.getByTestId("banner-paused")).toHaveCount(0);
    await expect(page.getByTestId("nav-create")).toBeDisabled();
    await expect(page.getByTestId("banner-shutdown")).toContainText("No new bets can be made or taken");
    await expect(page.getByTestId("create-disabled-note")).toHaveCount(0);
  });

  test("neither flag set: no banner, no create-disabled note", async ({ page }) => {
    await mockRpc(page, { paused: false, shutdown: false });
    await page.goto("/");
    await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
    await expect(page.getByTestId("banner-paused")).toHaveCount(0);
    await expect(page.getByTestId("banner-shutdown")).toHaveCount(0);
    await expect(page.getByTestId("create-disabled-note")).toHaveCount(0);
  });
});

test.describe("Emergency refund button on BetPage (mocked RPC + relayer, injected test wallet)", () => {
  test("shown for a non-finalized bet once shut down; click relays and reports success", async ({ page }) => {
    await injectTestWallet(page);
    await mockRpc(page, { bet: betResult({ status: "Challenged" }), shutdown: true });
    await page.route(`${RELAYER_URL}/relay`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: "fake-tx-hash" }) }),
    );
    await page.goto("/");
    await page.waitForFunction(() => (window as any).__e2e?.nearAddress === window.__e2eTestWallet?.nearAddress, { timeout: 20_000 });
    await page.evaluate(() => { history.pushState({}, "", "/bet/1"); window.dispatchEvent(new PopStateEvent("popstate")); }); // FE1: in-app nav to /bet/1 (typed bet-id box removed)
    await expect(page.getByTestId("bet-status")).toHaveText("Challenged");
    await expect(page.getByTestId("emergency-refund-section")).toBeVisible();
    await expect(page.getByTestId("emergency-refund-btn")).toBeEnabled();
    await page.getByTestId("emergency-refund-btn").click();
    // B1 (UX-37): plain words on screen, the action state and tx hash kept as attributes (no raw codes or hashes in the text)
    await expect(page.getByTestId("emergency-refund-status")).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("emergency-refund-tx")).toHaveAttribute("data-tx", "fake-tx-hash");
    await expect(page.getByTestId("emergency-refund-tx")).toHaveText("Sent. The deposits are on their way back.");
    await expect(page.getByTestId("emergency-refund-error")).toHaveCount(0);
  });

  test("relayer error surfaces as an error status, not a false success", async ({ page }) => {
    await injectTestWallet(page);
    await mockRpc(page, { bet: betResult({ status: "Open" }), shutdown: true });
    await page.route(`${RELAYER_URL}/relay`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false, error: "method not on policy allowlist" }) }),
    );
    await page.goto("/");
    await page.waitForFunction(() => (window as any).__e2e?.nearAddress === window.__e2eTestWallet?.nearAddress, { timeout: 20_000 });
    await page.evaluate(() => { history.pushState({}, "", "/bet/1"); window.dispatchEvent(new PopStateEvent("popstate")); }); // FE1: in-app nav to /bet/1 (typed bet-id box removed)
    await page.getByTestId("emergency-refund-btn").click();
    await expect(page.getByTestId("emergency-refund-status")).toHaveAttribute("data-state", "error"); // B1: plain words, state as an attribute
    await expect(page.getByTestId("emergency-refund-error")).toContainText("not on policy allowlist");
  });

  test("not shown for a Finalized bet, or when the contract is not shut down", async ({ page }) => {
    await injectTestWallet(page);
    await mockRpc(page, { bet: betResult({ status: "Finalized" }), shutdown: true });
    await page.goto("/");
    await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
    await page.evaluate(() => { history.pushState({}, "", "/bet/1"); window.dispatchEvent(new PopStateEvent("popstate")); }); // FE1: in-app nav to /bet/1 (typed bet-id box removed)
    await expect(page.getByTestId("bet-status")).toHaveText("Finalized");
    await expect(page.getByTestId("emergency-refund-section")).toHaveCount(0);
  });

  test("not shown for an open, non-finalized bet while the contract is merely paused (not shut down)", async ({ page }) => {
    await injectTestWallet(page);
    await mockRpc(page, { bet: betResult({ status: "Open" }), paused: true, shutdown: false });
    await page.goto("/");
    await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
    await page.evaluate(() => { history.pushState({}, "", "/bet/1"); window.dispatchEvent(new PopStateEvent("popstate")); }); // FE1: in-app nav to /bet/1 (typed bet-id box removed)
    await expect(page.getByTestId("bet-status")).toHaveText("Open");
    await expect(page.getByTestId("emergency-refund-section")).toHaveCount(0);
  });
});
