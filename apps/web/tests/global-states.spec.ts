// FE16 (S18): paused / shut down on the take path, the offline banner, and the plain-English copy pass. Fully mocked.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const USDC = "nep141:usdc.testnet";
const FUND_NS = Date.UTC(2037, 0, 2, 3, 4) * 1_000_000;
interface World { paused: boolean; shutdown: boolean; getBetFails: boolean; status: string }
const world = (o: Partial<World> = {}): World => ({ paused: false, shutdown: false, getBetFails: false, status: "Open", ...o });
const betJson = (w: World) => ({
  envelope: { bet_id: 7, version: 1, maker: "maker.testnet", taker_allow: "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "cd".repeat(32), terms: null, outcomes: ["YES", "NO"], maker_side: "YES",
    maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: "10000000", taker_options: [], fee_bps: 100, funding_deadline: FUND_NS, resolve_deadline: FUND_NS + 86_400e9, settlement_period: 86_400_000_000_000, referee: { account: "ref.testnet", mode: "Human" } },
  status: w.status, taker: null, created_at: 0, taken_at: null, proposed_at: null, outcome: null, reserve_remaining: "0", bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0, fee_min_taker: "500000",
});
async function setup(page: Page, w: World) {
  await page.addInitScript((address) => { (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => "22".repeat(64) }; }, WALLET);
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const reply = (obj: object) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", ...obj }) });
    const ok = (result: unknown) => reply({ result });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      if (params.method_name === "get_bet" && w.getBetFails) return route.fulfill({ status: 500, body: "boom" });
      let r: unknown = null;
      switch (params.method_name) {
        case "is_paused": r = w.paused || w.shutdown; break;
        case "is_shutdown": r = w.shutdown; break;
        case "open_offers": r = []; break;
        case "asset_limit": r = { storage_per_kib: "457" }; break;
        case "mt_balance_of": r = "1" + "0".repeat(20); break;
        case "required_challenge_bond": r = null; break;
        case "get_bet": r = betJson(w); break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
}
const open = async (page: Page, path = "/bet/7") => { await page.goto(path); await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 }); };

test.describe("FE16 global states", () => {
  test("paused: the take path says 'New bets are paused.' and offers no take button", async ({ page }) => {
    await setup(page, world({ paused: true }));
    await open(page);
    await expect(page.getByTestId("take-state")).toHaveAttribute("data-kind", "paused");
    await expect(page.getByTestId("take-state")).toContainText("New bets are paused.");
    await expect(page.getByTestId("banner-paused")).toContainText("New bets are paused.");
    await expect(page.getByTestId("take-confirm")).toHaveCount(0);
    await expect(page.getByTestId("take-open")).toHaveCount(0);
  });

  test("shut down: banner, take path says so, no take button; a live bet shows 'Get my money back'", async ({ page }) => {
    const w = world({ shutdown: true });
    await setup(page, w);
    await open(page);
    await expect(page.getByTestId("banner-shutdown")).toContainText("Praetorial is shut down");
    await expect(page.getByTestId("take-state")).toHaveAttribute("data-kind", "shutdown");
    await expect(page.getByTestId("take-state")).toContainText("Praetorial is shut down");
    await expect(page.getByTestId("take-confirm")).toHaveCount(0);
    await expect(page.getByTestId("take-open")).toHaveCount(0);
    w.status = "Taken";
    await open(page);
    await expect(page.getByTestId("emergency-refund-btn")).toHaveText("Get my money back");
  });

  test("offline: banner, actions disabled; back online: banner gone, actions enabled", async ({ page, context }) => {
    await setup(page, world());
    await open(page);
    await expect(page.getByTestId("take-open")).toBeEnabled();
    await expect(page.getByTestId("banner-offline")).toHaveCount(0);
    await context.setOffline(true);
    await expect(page.getByTestId("banner-offline")).toContainText("You're offline");
    await expect(page.getByTestId("take-open")).toBeDisabled();
    await expect(page.getByTestId("nav-create")).toBeDisabled();
    await context.setOffline(false);
    await expect(page.getByTestId("banner-offline")).toHaveCount(0);
    await expect(page.getByTestId("take-open")).toBeEnabled();
    await expect(page.getByTestId("nav-create")).toBeEnabled();
  });

  test("copy pass: page title, nav labels, and the load-failure sentence", async ({ page }) => {
    await setup(page, world({ getBetFails: true }));
    await open(page);
    await expect(page).toHaveTitle("Praetorial");
    await expect(page.getByTestId("nav-create")).toHaveText("Create bet"); // NAV1 (UX-31): Home / About / Wallet + Create bet
    await expect(page.getByTestId("nav-home")).toHaveText("Home");
    await expect(page.getByTestId("bet-status")).toHaveText("We couldn't load this bet. Check your connection and try again.");
  });
});
