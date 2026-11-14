// IDX2: Open / Take nudge the indexer so the board updates in seconds. Fully mocked (NEAR RPC, source check, relayer, indexer, wallet
// seam). The mocked indexer behaves like the real one: /offers lists bet 6 only once POST /refresh {"bet_id":6} has re-read it.
// Explore = the Home page's "Explore Bets" section; the maker sees their own new bet there at once (optimistic row), then the indexed one.
import { type Page, type Route } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const SC = "http://localhost:8790/sourcecheck";
const RELAYER = "http://localhost:8788";
const INDEXER = "http://localhost:8787";
const ESCROW = "praetorial-frz3-2611100414.praetorial-dev-1101.testnet";
const WASM = JSON.parse(readFileSync(new URL("../lib/release.json", import.meta.url), "utf8")).resolver_wasm_hash;
const FUNDING_NS = Date.UTC(2027, 0, 2, 3, 4) * 1_000_000;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };

type RefreshMode = "ok" | "500" | "abort" | "hold";
interface World {
  count: number; hash: string; terms: string | null; status: string; taker: string | null; relays: number;
  indexed: boolean; refreshBodies: unknown[]; refreshMode: RefreshMode; release: (() => void) | null; takeBet: boolean;
}
const world = (o: Partial<World> = {}): World => ({ count: 5, hash: "", terms: null, status: "Open", taker: null, relays: 0, indexed: false, refreshBodies: [], refreshMode: "ok", release: null, takeBet: false, ...o });

const openBet = (w: World) => ({
  envelope: { bet_id: 6, version: 1, maker: WALLET, taker_allow: "Any", terms_hash: w.hash, terms: w.terms, keep_terms: true, maker_asset: "nep141:wrap.testnet", taker_asset: "nep141:wrap.testnet", stake_maker: "10", stake_taker: "10", taker_options: [], funding_deadline: FUNDING_NS, resolve_deadline: Date.UTC(2027, 11, 20) * 1e6, settlement_period: 86_400_000_000_000, referee: null, outcomes: ["YES", "NO"], maker_side: "YES" },
  status: w.status, taker: w.taker, created_at: 0, taken_at: null, proposed_at: null, outcome: null, reserve_remaining: "0", bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0,
});
const USDC = "nep141:usdc.testnet";
const takeBet = (w: World) => ({
  envelope: { bet_id: 7, version: 1, maker: "maker.testnet", taker_allow: "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "cd".repeat(32), terms: null, outcomes: ["YES", "NO"], maker_side: "YES",
    maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: "10000000", taker_options: [], fee_bps: 100, funding_deadline: Date.UTC(2037, 0, 2) * 1e6, resolve_deadline: Date.UTC(2037, 0, 5) * 1e6, settlement_period: 86_400_000_000_000,
    referee: { account: "ref.testnet", mode: "Human" } },
  status: w.status, taker: w.taker, created_at: 0, taken_at: null, proposed_at: null, outcome: null, reserve_remaining: "0", bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0, fee_min_taker: "500000",
});
const offerRow = (id: number) => ({ bet_id: id, contract_id: ESCROW, contract_version: 1, maker: WALLET, maker_side: "YES", stake_maker: "10", stake_taker: "10", funding_deadline: FUNDING_NS, taker_allow: "Any" });

async function setup(page: Page, w: World, path: string) {
  await page.addInitScript(({ address }) => {
    (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => "22".repeat(64) };
    (window as any).__e2eConfirm = { delayMs: 50, attempts: 4 };
  }, { address: WALLET });
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const reply = (obj: object) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", ...obj }) });
    const ok = (result: unknown) => reply({ result });
    if (body.method === "block") return ok({ header: { height: 100, timestamp_nanosec: String(BigInt(Date.now()) * 1_000_000n) } });
    if (body.method === "tx" || body.method === "EXPERIMENTAL_tx_status") return ok({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { logs: [] } }] });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      let r: unknown = null;
      const args = JSON.parse(Buffer.from(params.args_base64 ?? "e30=", "base64").toString("utf8") || "{}");
      switch (params.method_name) {
        case "is_paused": case "is_shutdown": r = false; break;
        case "open_offers": r = []; break;
        case "asset_limit": r = { storage_per_kib: w.takeBet ? "457" : "1" }; break;
        case "resolver_keys": r = ["a", "b", WASM]; break;
        case "mt_balance_of": r = "1" + "0".repeat(30); break;
        case "required_challenge_bond": r = null; break;
        case "bet_count": r = w.count; break;
        case "get_bet": r = w.takeBet ? (args.bet_id === 7 ? takeBet(w) : null) : (args.bet_id === 6 && w.count >= 6 ? openBet(w) : null); break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  await page.route(SC, async (route) => {
    const { terms } = JSON.parse(route.request().postData() ?? "{}");
    w.terms = terms; w.hash = createHash("sha256").update(terms).digest("hex");
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: true, spec_hash: w.hash, checked_at: String(Date.now() * 1_000_000), unreachable: [], signing: { signature_hex: "33".repeat(64) } }) });
  });
  await page.route(`${RELAYER}/relay`, (r) => {
    w.relays++;
    if (w.takeBet) { w.status = "Taken"; w.taker = WALLET; } else if (w.relays === 1) { w.count = 6; w.status = "Open"; }
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: `TX${w.relays}` }) });
  });
  await page.route(`${INDEXER}/offers**`, (r) => r.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(w.indexed && w.status === "Open" ? [offerRow(6)] : []) }));
  await page.route(`${INDEXER}/refresh**`, async (r: Route) => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS });
    w.refreshBodies.push(JSON.parse(r.request().postData() ?? "null"));
    if (w.refreshMode === "abort") return r.abort("connectionrefused");
    if (w.refreshMode === "500") return r.fulfill({ status: 500, contentType: "application/json", headers: CORS, body: "{\"ok\":false}" });
    if (w.refreshMode === "hold") await new Promise<void>((res) => { w.release = res; });
    w.indexed = true; // the real indexer re-reads get_bet(N) from chain and writes it: /offers lists it from now on
    return r.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify({ ok: true, bet_id: 6, contract_id: ESCROW, written: true }) });
  });
  await page.route("**/ticker**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ venue: "x", price: 1 }) }));
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto(path);
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
}

async function openTheBet(page: Page) {
  await page.getByTestId("bet-type-card-nws_daily_high").click();
  await page.getByTestId("guided-station").selectOption("KNYC");
  await page.getByTestId("guided-date").fill("2027-12-08");
  await page.getByTestId("guided-op").selectOption(">=");
  await page.getByTestId("guided-x_f").fill("72");
  await page.getByTestId("fill-next").click();
  await page.getByTestId("maker-amount").fill("10");
  await page.getByTestId("review-offer").click();
  await expect(page.getByTestId("source-check-status")).toContainText("Checking sources… ✓");
  await page.getByTestId("open-offer-btn").click();
  await expect(page.getByTestId("share-screen")).toBeVisible({ timeout: 20_000 });
}
/** In-app navigation (no reload), like tapping Home. */
const toHome = (page: Page) => page.evaluate(() => { window.history.pushState({}, "", "/"); window.dispatchEvent(new PopStateEvent("popstate")); });

test.describe("IDX2 Open/Take nudge the indexer", () => {
  test("open -> POST /refresh {bet_id} only; my bet on Explore at once (optimistic), then the indexed row; < 5 s from open", async ({ page }) => {
    const w = world({ refreshMode: "hold" });
    await setup(page, w, "/new");
    await openTheBet(page);
    const t0 = Date.now();
    await expect.poll(() => w.refreshBodies, { timeout: 5_000 }).toEqual([{ bet_id: 6 }]);
    await toHome(page);
    await expect(page.getByTestId("browse-page")).toBeVisible();
    // the indexer has not answered yet: the optimistic row from the Open result
    await expect(page.locator('[data-source="optimistic"] [data-testid="my-new-row-6"]')).toBeVisible();
    await expect(page.getByTestId("my-new-offers-note")).toHaveText("Your new bet is open. Others see it here too.");
    w.release!();
    // the nudge settled -> Explore re-reads quietly -> the indexer lists it -> the indexed row replaces the optimistic one
    await expect(page.locator('[data-source="indexed"] [data-testid="my-new-row-6"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-source="optimistic"]')).toHaveCount(0);
    await expect(page.getByTestId("my-new-row-6")).toHaveCount(1);
    expect(Date.now() - t0).toBeLessThan(5_000);
    await expect(page.getByTestId("offers-status")).not.toHaveText(/Loading|couldn't/i);
  });

  for (const mode of ["500", "abort"] as const) {
    test(`refresh fails (${mode}): the Open still succeeds, no error shown, Explore still shows my bet (optimistic)`, async ({ page }) => {
      const w = world({ refreshMode: mode });
      await setup(page, w, "/new");
      await openTheBet(page);
      await expect.poll(() => w.refreshBodies.length).toBe(1);
      await expect(page.getByTestId("share-title")).toHaveText("Your bet is open. Share the link so the other person can take it.");
      await expect(page.getByTestId("share-screen")).not.toContainText(/indexer|refresh|error/i);
      await toHome(page);
      await expect(page.locator('[data-source="optimistic"] [data-testid="my-new-row-6"]')).toBeVisible({ timeout: 5_000 });
      await expect(page.getByTestId("offers-status")).toHaveText("No open bets yet. Make one.");
    });
  }

  test("take -> POST /refresh {bet_id: 7}; a failing refresh never touches the success screen", async ({ page }) => {
    const w = world({ takeBet: true, refreshMode: "500" });
    await setup(page, w, "/bet/7");
    await page.getByTestId("take-open").click();
    const dlg = page.locator("dialog[open]").last();
    await dlg.getByTestId("take-confirm").click();
    await expect(dlg.getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    await expect(dlg.getByTestId("take-result")).toHaveAttribute("data-kind", "taken");
    await expect.poll(() => w.refreshBodies, { timeout: 5_000 }).toEqual([{ bet_id: 7 }]);
    await expect(dlg.getByTestId("flow-success")).toBeVisible();
    expect(w.relays).toBe(1);
  });
});
