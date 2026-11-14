// FE1: app shell + routes, fully mocked (NEAR RPC view calls via page.route; wallet via the
// window.__e2eTestWallet seam). Never a real Privy login. Logged-out is the default state.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { mockUsernames } from "./lib/betPage";

const TEST_WALLET_ADDRESS = "11".repeat(32);
const TEST_SIGNATURE_HEX = "22".repeat(64);

function bet7() {
  return {
    envelope: {
      bet_id: 7, version: 1, maker: "maker.testnet", taker_allow: "Any", terms_hash: "deadbeef", models_snapshot_hash: "x",
      outcomes: ["YES", "NO"], maker_side: "YES", maker_asset: "nep141:usdc.testnet", taker_asset: "nep141:usdc.testnet",
      stake_maker: "100000000", stake_taker: "100000000", taker_options: [], fee_bps: 100, reserve_per_side: "0",
      storage_charge_per_side: "0", keep_terms: false, terms: null, run_price: "0", max_paid_runs: 3, tier: 1, arbiter: null,
      arbiter_fee: "0", funding_deadline: Date.now() * 1_000_000 + 7 * 24 * 3600 * 1_000_000_000, early_settle_outcome: null,
      finality_delay: 0, settlement_period: 24 * 3600 * 1_000_000_000, resolve_deadline: 0, consent_party_controlled: false, referee: null,
    },
    status: "Open", taker: null, created_at: 0, taken_at: null, proposed_at: null, outcome: null, reserve_remaining: "0",
    bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0,
  };
}

async function mockRpc(page: Page) {
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" })); // FE10e: never the real 1Click API
  await page.route("https://test.rpc.fastnear.com", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "call_function") {
      const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8"));
      let r: unknown = null;
      if (params.method_name === "get_bet") r = args.bet_id === 7 ? bet7() : null;
      else if (params.method_name === "is_paused" || params.method_name === "is_shutdown") r = false;
      else if (params.method_name === "open_offers") r = [];
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
}

// LOGIN1 (UX-29): logged out, every route is only the login page; the app shell needs a signed-in (test wallet) session.
async function signIn(page: Page) {
  await page.addInitScript(({ address, sig }) => {
    (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => sig };
  }, { address: TEST_WALLET_ADDRESS, sig: TEST_SIGNATURE_HEX });
}

async function ready(page: Page) {
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
}

test.describe("FE1 app shell (mocked; test-wallet login)", () => {
  // NAV1 (UX-31): "/" is Home (My Bets, Explore Bets, In progress); the pitch / how-it-works landing moved into About.
  test("home renders (signed in): the three sections; no v0 title, no typed bet-id box, no login form", async ({ page }) => {
    await signIn(page);
    await mockRpc(page);
    await page.goto("/");
    await ready(page);
    await expect(page.getByTestId("home")).toBeVisible();
    await expect(page.getByTestId("my-bets")).toBeVisible();
    await expect(page.getByTestId("browse-page")).toBeVisible();
    await expect(page.getByTestId("in-progress")).toBeVisible();
    await expect(page.getByTestId("login-form")).toHaveCount(0); // LOGIN1: the login is its own page, never on Home
    await expect(page.getByText("Praetorial v0")).toHaveCount(0);
    await expect(page.getByTestId("bet-id-input")).toHaveCount(0);
    await expect(page.getByTestId("nav-account")).toBeVisible();
  });

  // LOGIN1 (UX-29): was "/bet/7 logged out renders the read-only bet view, no login wall". familiarcow: the logged-out app is
  // a page with just the login, so the bet is behind it now; the deep link keeps its URL and opens once signed in.
  test("/bet/7 logged out shows only the login page; signed in it renders the bet (get_bet) on the same URL", async ({ page }) => {
    await mockRpc(page);
    await mockUsernames(page);
    await page.goto("/bet/7");
    await ready(page);
    await expect(page.getByTestId("login-gate")).toBeVisible();
    await expect(page.getByTestId("bet-status")).toHaveCount(0);
    await page.evaluate(({ address, sig }) => {
      (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => sig };
      window.dispatchEvent(new Event("e2e-wallet-changed"));
    }, { address: TEST_WALLET_ADDRESS, sig: TEST_SIGNATURE_HEX });
    await expect(page.getByTestId("bet-view")).toBeVisible();
    await expect(page.getByTestId("bet-status")).toHaveText("Open");
    // B1 (familiarcow 2026-11-11): the maker is shown by @username in the header; the raw account id only under Details -> Account details.
    await expect(page.getByTestId("bet-stakes")).toContainText("@maker");
    await expect(page.getByTestId("bet-stakes")).not.toContainText("maker.testnet");
    await page.getByTestId("details-accounts").locator("summary").click();
    await expect(page.getByTestId("details-accounts")).toContainText("maker.testnet");
    await expect(page.getByTestId("login-gate")).toHaveCount(0);
    await expect(page).toHaveURL(/\/bet\/7$/);
  });

  test("/new logged out -> login -> back on /new (create form)", async ({ page }) => {
    await mockRpc(page);
    await page.goto("/new");
    await ready(page);
    await expect(page.getByTestId("login-gate")).toBeVisible();
    await expect(page.getByTestId("login-form")).toBeVisible();
    await expect(page.getByTestId("create-offer-form")).toHaveCount(0);
    // Mocked login: the test wallet seam appears (no Privy OTP), then the shell is told.
    await page.evaluate(({ address, sig }) => {
      (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => sig };
      window.dispatchEvent(new Event("e2e-wallet-changed"));
    }, { address: TEST_WALLET_ADDRESS, sig: TEST_SIGNATURE_HEX });
    await expect(page.getByTestId("create-offer-form")).toBeVisible();
    await expect(page.getByTestId("login-gate")).toHaveCount(0);
    await expect(page).toHaveURL(/\/new$/);
  });

  test("/wallet logged out is login-gated and keeps its URL", async ({ page }) => {
    await mockRpc(page);
    await page.goto("/wallet");
    await ready(page);
    await expect(page.getByTestId("login-gate")).toBeVisible();
    await expect(page).toHaveURL(/\/account$/);
  });

  test("/my-bets (NAV1: now the Home page's My Bets section) with a signed-in test wallet shows My Bets", async ({ page }) => {
    await page.addInitScript(({ address, sig }) => {
      (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => sig };
    }, { address: TEST_WALLET_ADDRESS, sig: TEST_SIGNATURE_HEX });
    await mockRpc(page);
    await page.goto("/my-bets");
    await ready(page);
    await expect(page.getByTestId("my-bets")).toBeVisible();
    await expect(page.getByTestId("login-gate")).toHaveCount(0);
  });

  test("nav moves between routes without a reload; unknown path shows not-found; old ?bet=7 link lands on /bet/7", async ({ page }) => {
    await signIn(page);
    await mockRpc(page);
    await page.goto("/");
    await ready(page);
    await page.getByTestId("nav-docs").click(); // DOCS1: About is now Docs
    await expect(page).toHaveURL(/\/docs$/);
    await page.getByTestId("nav-home").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("home")).toBeVisible();
    await page.goto("/nope");
    await expect(page.getByTestId("not-found")).toBeVisible();
    await page.goto("/?bet=7");
    await ready(page);
    await expect(page).toHaveURL(/\/bet\/7$/);
    await expect(page.getByTestId("bet-status")).toHaveText("Open");
  });
});
