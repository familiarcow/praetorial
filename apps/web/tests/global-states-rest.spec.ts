// FE16b (S18): money hidden from stale reads (offline / failed view), 429 "Busy, retrying in Ns" + auto retry, out-of-date page,
// offline Browse and My bets. Fully mocked (page.route), wallet via window.__e2eTestWallet.
import { readFileSync } from "node:fs";
import { ESCROW_CONTRACT_ID } from "../lib/config";
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { openMoreActions } from "./lib/betPage";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const INDEXER = "http://localhost:8787";
const USDC = "nep141:usdc.testnet";
const FUND_NS = Date.UTC(2037, 0, 2, 3, 4) * 1_000_000;
const RELEASE_HASH: string = JSON.parse(readFileSync(new URL("../lib/release.json", import.meta.url), "utf8")).resolver_wasm_hash; // single source: the pinned release
interface World { status: string; chainId?: string; wasm?: string; viewsFail: boolean; statusFails?: number; limited: number; maker?: string; taker?: string | null; rpcCalls: number; terms?: string | null }
const world = (o: Partial<World> = {}): World => ({ status: "Open", viewsFail: false, limited: 0, rpcCalls: 0, ...o });
const betJson = (w: World) => ({
  envelope: { bet_id: 7, version: 1, maker: w.maker ?? "maker.testnet", taker_allow: "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "cd".repeat(32), terms: w.terms ?? null, outcomes: ["YES", "NO"], maker_side: "YES",
    maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: "10000000", taker_options: [], fee_bps: 100, funding_deadline: FUND_NS, resolve_deadline: FUND_NS + 86_400e9, settlement_period: 86_400_000_000_000, referee: { account: "ref.testnet", mode: "Human" } },
  status: w.status, taker: w.taker ?? null, created_at: 0, taken_at: null, proposed_at: null, outcome: null, reserve_remaining: "0", bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0, fee_min_taker: "500000",
});
async function setup(page: Page, w: World) {
  await page.addInitScript((address) => { (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => "22".repeat(64) }; }, WALLET);
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const reply = (obj: object) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", ...obj }) });
    const ok = (result: unknown) => reply({ result });
    if (body.method === "status" && (w.statusFails ?? 0) > 0) { w.statusFails!--; return route.abort("failed"); }
    if (body.method === "status") return ok({ chain_id: w.chainId ?? "testnet" });
    if (w.limited > 0) { w.limited--; return route.fulfill({ status: 429, headers: { "retry-after": "2" }, body: "slow down" }); }
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      if (w.viewsFail && params.method_name !== "is_paused" && params.method_name !== "is_shutdown") return route.fulfill({ status: 500, body: "boom" });
      let r: unknown = null;
      switch (params.method_name) {
        case "is_paused": r = false; break;
        case "is_shutdown": r = false; break;
        case "open_offers": r = []; break;
        case "asset_limit": r = { storage_per_kib: "457" }; break;
        case "mt_balance_of": r = "1" + "0".repeat(20); break;
        case "required_challenge_bond": r = { amount: "5000000", asset: USDC }; break;
        case "resolver_keys": r = ["k1", "k2", w.wasm ?? RELEASE_HASH]; break;
        case "get_bet": r = betJson(w); break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  const json = (route: any, v: unknown) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(v) });
  await page.route(`${INDEXER}/offers**`, (route) => json(route, [{ bet_id: 7, contract_id: ESCROW_CONTRACT_ID, maker: "maker.testnet", taker_allow: "Any", stake_maker: "10000000", stake_taker: "10000000", funding_deadline: FUND_NS }]));
  await page.route(`${INDEXER}/history**`, (route) => json(route, [{ bet_id: 7, maker: WALLET, taker: "other.testnet", status: "Taken", outcome: null }]));
}
const open = async (page: Page, path = "/bet/7") => { await page.goto(path); await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 }); };

test.describe("FE16b stale money", () => {
  // B1 (familiarcow UX-37): amounts are shown in token units ("10.00 USDC"), never base units ("10000000").
  test("offline on a bet page: figures hidden, every money action disabled; back online: restored", async ({ page, context }) => {
    const w = world({ status: "Taken", taker: WALLET, maker: "maker.testnet" });
    await setup(page, w);
    await open(page);
    await expect(page.getByTestId("bet-stakes")).toContainText("10.00 USDC");
    await context.setOffline(true);
    await expect(page.getByTestId("banner-offline")).toBeVisible();
    await expect(page.getByTestId("bet-stakes")).not.toContainText("10.00 USDC");
    await expect(page.getByTestId("bet-stakes")).toContainText("—");
    await context.setOffline(false);
    await expect(page.getByTestId("bet-stakes")).toContainText("10.00 USDC");
  });

  test("offline on an open bet I made: Cancel is disabled; on a bet I can take: no figures, no Take", async ({ page, context }) => {
    const w = world({ maker: WALLET });
    await setup(page, w);
    await open(page);
    await openMoreActions(page); // B1 (UX-37 #4): Cancel is under the collapsed More actions
    await expect(page.getByTestId("cancel-bet")).toBeEnabled();
    await context.setOffline(true);
    await expect(page.getByTestId("cancel-bet")).toBeDisabled();
    await context.setOffline(false);
    w.maker = "maker.testnet";
    await open(page);
    await expect(page.getByTestId("take-review")).toBeVisible();
    await context.setOffline(true);
    await expect(page.getByTestId("money-stale-note")).toContainText("out of date");
    await expect(page.getByTestId("take-open")).toBeDisabled();
    // B1: the review now also shows the relative close time ("Closes in 10 years"), so check for the money itself: no figure, no token
    await expect(page.getByTestId("take-review")).not.toContainText("10.00");
    await expect(page.getByTestId("take-review")).not.toContainText("USDC");
    await expect(page.getByTestId("take-review")).toContainText("You put in — to win —.");
  });

  test("a failed contract view hides money and disables the actions, with no offline banner", async ({ page }) => {
    const w = world({ status: "Taken", taker: WALLET, maker: "maker.testnet" });
    await setup(page, w);
    await open(page);
    await expect(page.getByTestId("bet-stakes")).toContainText("10.00 USDC");
    w.viewsFail = true;
    await expect(page.getByTestId("bet-stakes")).toContainText("—", { timeout: 40_000 });
    await expect(page.getByTestId("nav-create")).toBeDisabled();
    await expect(page.getByTestId("banner-offline")).toHaveCount(0);
  });

  // REVIEW1 (#8, SM1 AUTH-1): failed reads are retried with backoff and the app recovers without a reload.
  test("#8: a failed contract view shows 'Connection problem. Retrying…' and recovers by itself once the RPC answers (no reload)", async ({ page }) => {
    const w = world({ status: "Taken", taker: WALLET, maker: "maker.testnet" });
    await setup(page, w);
    await open(page);
    await expect(page.getByTestId("bet-stakes")).toContainText("10.00 USDC");
    await expect(page.getByTestId("banner-connection")).toHaveCount(0);
    w.viewsFail = true;
    await expect(page.getByTestId("bet-stakes")).toContainText("—", { timeout: 40_000 });
    await expect(page.getByTestId("banner-connection")).toContainText("Connection problem. Retrying…");
    w.viewsFail = false;
    await expect(page.getByTestId("bet-stakes")).toContainText("10.00 USDC", { timeout: 40_000 });
    await expect(page.getByTestId("banner-connection")).toHaveCount(0);
    await expect(page.getByTestId("nav-create")).toBeEnabled();
  });

  test("#8 AUTH-1: the one-shot startup read failing (network blip at load) does not leave Create disabled until a reload", async ({ page }) => {
    const w = world({ status: "Taken", taker: WALLET, maker: "maker.testnet", statusFails: 3 });
    await setup(page, w);
    await open(page, "/");
    await expect.poll(() => w.statusFails, { timeout: 20_000 }).toBe(0); // the startup read failed (all its quick retries too)
    // ...and the app recovers by itself: Create enabled, no banner, without a reload.
    await expect(page.getByTestId("nav-create")).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId("banner-connection")).toHaveCount(0, { timeout: 30_000 });
  });
});

test.describe("FE16b rate limit", () => {
  test("a 429 shows 'Busy, retrying in Ns', counts down, retries by itself and recovers", async ({ page }) => {
    const w = world({ status: "Taken", taker: WALLET });
    await setup(page, w);
    await open(page);
    w.limited = 2;
    await page.reload();
    await expect(page.getByTestId("banner-busy")).toContainText(/Busy, retrying in \d+s/, { timeout: 15_000 });
    await expect(page.getByTestId("banner-busy")).toHaveCount(0, { timeout: 30_000 });
    await page.waitForFunction(() => (window as any).__e2e?.ready === true);
    await expect(page.getByTestId("bet-stakes")).toContainText("10.00 USDC", { timeout: 30_000 });
  });
});

test.describe("FE16b out of date", () => {
  test("wrong network: 'This page is out of date. Refresh.' and money actions off", async ({ page }) => {
    await setup(page, world({ chainId: "mainnet" }));
    await open(page);
    await expect(page.getByTestId("banner-out-of-date")).toContainText("This page is out of date. Refresh.");
    await expect(page.getByTestId("nav-create")).toBeDisabled();
    await expect(page.getByTestId("take-open")).toBeDisabled();
  });
  test("release pin mismatch vs resolver_keys: out of date banner", async ({ page }) => {
    await setup(page, world({ wasm: "f".repeat(64) }));
    await open(page);
    await expect(page.getByTestId("banner-out-of-date")).toContainText("This page is out of date. Refresh.");
    await expect(page.getByTestId("nav-create")).toBeDisabled();
  });
  test("matching network and pins: no banner", async ({ page }) => {
    await setup(page, world());
    await open(page);
    await expect(page.getByTestId("nav-create")).toBeEnabled();
    await expect(page.getByTestId("banner-out-of-date")).toHaveCount(0);
  });
});

test.describe("FE16b offline Browse and My bets", () => {
  test("Browse offline: banner, no stale rows or figures, \"We couldn't load the list\" after a reload", async ({ page, context }) => {
    // BROWSE1b hides Browse rows whose terms text can't load, so this offer needs readable terms to be listed at all.
    await setup(page, world({ terms: JSON.stringify({ claimText: "BTC closes above $100k on Coinbase" }) }));
    await open(page, "/browse");
    await expect(page.getByTestId("offer-row-7")).toBeVisible();
    const amounts = page.getByTestId("offer-row-7").locator("[data-kit=Amount]"); // H1: kit cards; stale money = amounts hidden, a dash shown
    await expect(amounts.first()).toBeVisible();
    await expect(amounts.first()).toHaveText(/10\.00 USDC/);
    await context.setOffline(true);
    await expect(page.getByTestId("banner-offline")).toBeVisible();
    await expect(page.getByTestId("offer-stale")).toBeVisible();
    for (const a of await amounts.all()) await expect(a).toBeHidden();
    await context.setOffline(false);
    await expect(amounts.first()).toBeVisible();
    await expect(page.getByTestId("offer-stale")).toHaveCount(0);
  });
  test("Browse loaded while the list is down: \"We couldn't load the list\"", async ({ page }) => {
    await setup(page, world());
    await page.route(`${INDEXER}/offers**`, (route) => route.abort("internetdisconnected"));
    await open(page, "/browse");
    await expect(page.getByTestId("offers-status")).toContainText("We couldn't load the list");
  });
  test("My bets offline: banner, stake figures hidden; back online restored", async ({ page, context }) => {
    await setup(page, world({ status: "Taken", taker: "other.testnet", maker: WALLET }));
    await open(page, "/my-bets");
    await expect(page.getByTestId("mybet-row-7")).toBeVisible({ timeout: 20_000 });
    const stake = page.getByTestId("mybet-row-7").locator("[data-kit=Amount]").first();
    await expect(stake).toBeVisible();
    await context.setOffline(true);
    await expect(page.getByTestId("banner-offline")).toBeVisible();
    await expect(stake).toBeHidden();
    await expect(page.getByTestId("mybet-stale")).toBeVisible();
    await context.setOffline(false);
    await expect(stake).toBeVisible();
  });
  // NAV1: the Browse "My bets" tab is gone (My Bets is a Home section); the Home "In progress" section reads /history too and says so.
  test("My bets: the list failing to load shows the plain error with Retry; Home's In progress says it couldn't load", async ({ page }) => {
    await setup(page, world());
    await page.route(`${INDEXER}/history**`, (route) => route.abort("internetdisconnected"));
    await open(page, "/my-bets");
    await expect(page.getByTestId("mybets-error")).toContainText("We can't load your bets");
    await expect(page.getByTestId("mybets-retry")).toBeVisible();
    await expect(page.getByTestId("in-progress-error")).toContainText("We couldn't load the bets in progress");
    await expect(page.getByTestId("in-progress-retry")).toBeVisible();
  });
});
