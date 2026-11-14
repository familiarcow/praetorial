// TPL1 (D-PM3): price bets on any listed coin (searchable selector, live price, only the exchanges that list the pair, AI-judged
// custom sheet for non-Bitcoin) and weather by city name. Fully mocked: NEAR RPC, the exchanges' public product lists and
// tickers (Kraken through /_proxy/kraken), wallet via the __e2eTestWallet seam.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { DEFAULT_STAKE_SYMBOL } from "../lib/stakeSection";
import { openBetType } from "./betTypeNav";

const WALLET = "11".repeat(32);
const SIG = "22".repeat(64);
const RPC = "https://test.rpc.fastnear.com";
const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const CB_PRODUCTS = [
  { id: "BTC-USD", base_currency: "BTC", quote_currency: "USD", status: "online", trading_disabled: false },
  { id: "ETH-USD", base_currency: "ETH", quote_currency: "USD", status: "online", trading_disabled: false },
  { id: "ZEC-USD", base_currency: "ZEC", quote_currency: "USD", status: "online", trading_disabled: false },
  { id: "TWO-USD", base_currency: "TWO", quote_currency: "USD", status: "online", trading_disabled: false },
  { id: "USDT-USD", base_currency: "USDT", quote_currency: "USD", status: "online", trading_disabled: false },
];
const KR_PAIRS = { error: [], result: {
  XXBTZUSD: { altname: "XBTUSD", wsname: "XBT/USD", aclass_base: "currency", status: "online" },
  XETHZUSD: { altname: "ETHUSD", wsname: "ETH/USD", aclass_base: "currency", status: "online" },
  XZECZUSD: { altname: "ZECUSD", wsname: "ZEC/USD", aclass_base: "currency", status: "online" },
  TWOUSD: { altname: "TWOUSD", wsname: "TWO/USD", aclass_base: "currency", status: "online" },
  USDTZUSD: { altname: "USDTZUSD", wsname: "USDT/USD", aclass_base: "currency", status: "online" },
} };
const BS_PAIRS = [
  { name: "BTC/USD", url_symbol: "btcusd", trading: "Enabled", description: "Bitcoin / U.S. dollar" },
  { name: "ETH/USD", url_symbol: "ethusd", trading: "Enabled", description: "Ether / U.S. dollar" },
  { name: "ZEC/USD", url_symbol: "zecusd", trading: "Enabled", description: "Zcash / U.S. dollar" },
];

async function setup(page: Page, opts: { marketsDown?: boolean; slowMarketsMs?: number } = {}) {
  await page.addInitScript(({ address, sig }) => { (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => sig }; }, { address: WALLET, sig: SIG });
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill(json({ jsonrpc: "2.0", id: "1", result }));
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      const name = params.method_name;
      const r = name === "is_paused" || name === "is_shutdown" ? false : name === "open_offers" ? [] : name === "asset_limit" ? { storage_per_kib: "1" } : null;
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill(json([])));
  const down = (r: any) => r.fulfill({ status: 503, body: "down" });
  const later = (ms: number) => new Promise((res) => setTimeout(res, ms));
  const list = (body: unknown) => async (r: any) => { if (opts.slowMarketsMs) await later(opts.slowMarketsMs); return opts.marketsDown ? down(r) : r.fulfill(json(body)); };
  await page.route("https://api.exchange.coinbase.com/products", list(CB_PRODUCTS));
  await page.route("https://www.bitstamp.net/api/v2/trading-pairs-info/", list(BS_PAIRS));
  await page.route("**/_proxy/kraken/0/public/AssetPairs", list(KR_PAIRS));
  await page.route("https://api.coinbase.com/v2/prices/*/spot", (r) => r.fulfill(json({ data: { amount: r.request().url().includes("ZEC") ? "962.08" : "3100.5" } })));
  await page.route("https://www.bitstamp.net/api/v2/ticker/*/", (r) => r.fulfill(json({ last: r.request().url().includes("zec") ? "960.62" : "3101.5" })));
  await page.route("**/_proxy/kraken/0/public/Ticker*", (r) => r.fulfill(json({ error: [], result: { X: { c: [r.request().url().includes("ZEC") ? "961.20" : "3101.0", "1"] } } })));
  await page.goto("/new");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
  await expect(page.getByTestId("create-offer-form")).toBeVisible();
}
const card = (page: Page, id: string) => page.getByTestId(`bet-type-card-${id}`);

async function toReview(page: Page) {
  await page.getByTestId("fill-next").click();
  await expect(page.getByTestId("step-resolver")).toBeVisible();
  await page.getByTestId("maker-amount").fill("10");
  await page.getByTestId("review-offer").click();
  await expect(page.getByTestId("review-card")).toBeVisible();
  await expect(page.getByTestId("review-flags")).toHaveCount(0);
}

test.describe("TPL1 asset selector on price bets", () => {
  test("Bitcoin is the default: the typed, code-decided bet, unchanged", async ({ page }) => {
    await setup(page);
    await openBetType(page, "btc_close_at_t");
    await expect(page.getByTestId("guided-asset")).toHaveValue("BTC");
    await expect(page.getByTestId("asset-decider")).toHaveText("Decided by code from Coinbase, Bitstamp and Kraken 1-minute prices");
    await page.getByTestId("guided-t_utc").fill("2027-12-01T15:00");
    await page.getByTestId("guided-op").selectOption(">=");
    await page.getByTestId("guided-x_usd").fill("75900");
    await expect(page.getByTestId("fill-sentence")).toContainText("the Bitcoin price at 2027-12-01 15:00 UTC is at or above $75,900");
    await toReview(page);
    await expect(page.getByTestId("review-decider")).toHaveText("Decided by code from Coinbase, Bitstamp and Kraken 1-minute prices");
  });

  test("search 'zec' picks Zcash: live price, the 3 exchanges that list it, and the AI judge reads them", async ({ page }) => {
    await setup(page);
    await openBetType(page, "btc_close_at_t");
    // the live list: stablecoins excluded; an asset on 2 of the 3 exchanges (TWO) is offered
    const opts = page.getByTestId("guided-asset").locator("option");
    await expect(opts.filter({ hasText: "TWO" })).toHaveCount(1);
    await expect(opts.filter({ hasText: "USDT" })).toHaveCount(0);
    await page.getByTestId("asset-search").fill("zec");
    await expect(page.getByTestId("guided-asset")).toHaveValue("ZEC");
    await expect(page.getByTestId("guided-asset").locator("option")).toHaveCount(1);
    await expect(page.getByTestId("asset-price")).toContainText("$961.20");
    await expect(page.getByTestId("asset-venues")).toHaveText("Checked on Coinbase ZEC-USD, Bitstamp zecusd and Kraken ZEC/USD");
    await expect(page.getByTestId("asset-decider")).toHaveText("Decided by the AI judge reading Coinbase ZEC-USD, Bitstamp zecusd and Kraken ZEC/USD");
    await expect(page.getByText("Check the Zcash price at (UTC)")).toBeVisible();
    await page.getByTestId("guided-t_utc").fill("2027-12-01T15:00");
    await page.getByTestId("guided-op").selectOption(">=");
    await page.getByTestId("guided-x_usd").fill("950.5"); // cents are fine for a coin other than Bitcoin
    await expect(page.getByTestId("fill-error")).toHaveCount(0);
    await expect(page.getByTestId("fill-sentence")).toHaveText("You are betting that the Zcash (ZEC) price at 2027-12-01 15:00 UTC is at or above $950.5. The other person bets it won't happen.");
    await toReview(page);
    await expect(page.getByTestId("review-decider")).toHaveText("Decided by the AI judge reading Coinbase ZEC-USD, Bitstamp zecusd and Kraken ZEC/USD");
    await expect(page.getByTestId("review-claim")).toContainText("Zcash (ZEC)");
    await expect(page.getByTestId("review-term-sources")).toHaveText("api.exchange.coinbase.com, www.bitstamp.net, api.kraken.com");
  });

  test("touch bet on a 2-exchange coin shows only the exchanges that list it", async ({ page }) => {
    await setup(page);
    await openBetType(page, "btc_touch");
    await page.getByTestId("asset-search").fill("two");
    await expect(page.getByTestId("guided-asset")).toHaveValue("TWO");
    await expect(page.getByTestId("asset-venues")).toHaveText("Checked on Coinbase TWO-USD and Kraken TWO/USD");
    await page.getByTestId("guided-direction").selectOption("at_or_above");
    await page.getByTestId("guided-x_usd").fill("2");
    await page.getByTestId("guided-deadline_utc").fill("2027-12-07T12:00");
    await expect(page.getByTestId("fill-sentence")).toContainText("TWO (TWO) touches $2 (at or above)");
    await toReview(page);
    await expect(page.getByTestId("review-decider")).toHaveText("Decided by the AI judge reading Coinbase TWO-USD and Kraken TWO/USD");
  });

  test("a search typed before the live list arrives picks the coin once the list loads", async ({ page }) => {
    await setup(page, { slowMarketsMs: 1500 });
    await openBetType(page, "btc_touch");
    await page.getByTestId("asset-search").fill("two"); // only the built-in list so far: no match yet
    await expect(page.getByTestId("guided-asset")).toHaveValue("TWO");
    await expect(page.getByTestId("asset-venues")).toHaveText("Checked on Coinbase TWO-USD and Kraken TWO/USD");
  });

  test("exchanges unreachable: the built-in list still works (ETH, ZEC, NEAR, SOL)", async ({ page }) => {
    await setup(page, { marketsDown: true });
    await openBetType(page, "btc_close_at_t");
    for (const s of ["BTC", "ETH", "ZEC", "NEAR", "SOL"]) await expect(page.getByTestId("guided-asset").locator(`option[value="${s}"]`)).toHaveCount(1);
    await page.getByTestId("guided-asset").selectOption("NEAR");
    await expect(page.getByTestId("asset-venues")).toHaveText("Checked on Coinbase NEAR-USD, Bitstamp nearusd and Kraken NEAR/USD");
  });

  test("the stake token is a separate choice from the coin the bet is about", async ({ page }) => {
    await setup(page);
    await openBetType(page, "btc_close_at_t");
    await page.getByTestId("asset-search").fill("eth");
    await page.getByTestId("guided-t_utc").fill("2027-12-01T15:00");
    await page.getByTestId("guided-op").selectOption(">=");
    await page.getByTestId("guided-x_usd").fill("3000");
    await page.getByTestId("fill-next").click();
    await expect(page.getByTestId("step-resolver")).toBeVisible();
    await expect(page.getByTestId("resolver-sentence")).toContainText("Ethereum (ETH)");
    await expect(page.getByTestId("stake-asset")).toBeVisible();
    await expect(page.getByTestId("stake-asset")).toContainText(DEFAULT_STAKE_SYMBOL); // the stake keeps its own default token
    await expect(page.getByTestId("stake-asset")).not.toContainText("ETH");
  });
});

test.describe("TPL1 weather by city", () => {
  test("cities, searchable; what is measured; the climate-day caveat; the station code only under Details", async ({ page }) => {
    await setup(page);
    await card(page, "nws_daily_high").click();
    await expect(page.getByText("City", { exact: true })).toBeVisible();
    const sel = page.getByTestId("guided-station");
    await expect(sel.locator("option", { hasText: "New York City (Central Park)" })).toHaveCount(1);
    await expect(sel.locator("option", { hasText: /\bK[A-Z]{3}\b/ })).toHaveCount(0);
    await page.getByTestId("city-search").fill("chicago");
    await expect(sel.locator("option:not([value=''])")).toHaveText(["Chicago (O'Hare airport)", "Chicago (Midway airport)"]);
    await expect(sel).toHaveValue("KORD");
    await expect(page.getByTestId("nws-measured")).toHaveText("This bet is on the official high temperature the National Weather Service records for that city that day.");
    await expect(page.getByTestId("nws-climate-day")).toContainText("local standard time");
    await expect(page.getByTestId("nws-climate-day")).toContainText("1am to 1am");
    const det = page.getByTestId("nws-station-details");
    await expect(det.locator("summary")).toHaveText("Details");
    await expect(det).not.toHaveAttribute("open", "");
    await det.locator("summary").click();
    await expect(det).toHaveAttribute("open", "");
    await expect(det).toContainText("KORD");
    await page.getByTestId("guided-date").fill("2027-12-08");
    await page.getByTestId("guided-op").selectOption(">=");
    await page.getByTestId("guided-x_f").fill("40");
    await expect(det).toHaveAttribute("open", ""); // still open after editing other fields
    await expect(page.getByTestId("fill-sentence")).toHaveText("You are betting that the daily high in Chicago (O'Hare airport) on 2027-12-08 is at or above 40°F. The other person bets it won't happen.");
    await toReview(page);
    await expect(page.getByTestId("review-claim")).toContainText("Chicago (O'Hare airport)");
  });
});

test.describe("TPL1 Which outperforms? (two coins, start and end, margin)", () => {
  test("ZEC vs BTC: two coin pickers, shared exchanges, margin 0.5 by default, AI judge on the review", async ({ page }) => {
    await setup(page);
    await openBetType(page, "outperform");
    await expect(page.getByTestId("guided-asset-a")).toHaveValue("ETH");
    await expect(page.getByTestId("guided-asset-b")).toHaveValue("BTC");
    await expect(page.getByTestId("asset-picker")).toHaveCount(0); // not the single-coin picker
    await page.getByTestId("asset-a-search").fill("zcash");
    await expect(page.getByTestId("guided-asset-a")).toHaveValue("ZEC");
    await expect(page.getByTestId("asset-a-price")).toContainText("Now about $961.20");
    await expect(page.getByTestId("outperform-venues")).toHaveText("Checked on Coinbase, Bitstamp and Kraken (the exchanges that list both coins)");
    await expect(page.getByTestId("outperform-decider")).toHaveText("Decided by the AI judge reading Coinbase ZEC-USD, Bitstamp zecusd, Kraken ZEC/USD, Coinbase BTC-USD, Bitstamp btcusd and Kraken XBT/USD");
    await expect(page.getByTestId("guided-margin_pts")).toHaveValue("0.5");
    await page.getByTestId("guided-start_utc").fill("2027-12-01T15:00");
    await page.getByTestId("guided-end_utc").fill("2027-12-08T15:00");
    await expect(page.getByTestId("fill-sentence")).toHaveText("You are betting that Zcash (ZEC) beats Bitcoin (BTC) by at least 0.5 percentage points of price change from 2027-12-01 15:00 UTC to 2027-12-08 15:00 UTC. If neither coin beats the other by 0.5 points, the bet is void and both stakes are refunded. The other person bets that Bitcoin (BTC) beats Zcash (ZEC) by at least 0.5 points.");
    await toReview(page);
    await expect(page.getByTestId("review-claim")).toContainText("Zcash (ZEC) beats Bitcoin (BTC) by at least 0.5 percentage points");
    await expect(page.getByTestId("review-decider")).toHaveText("Decided by the AI judge reading Coinbase ZEC-USD, Bitstamp zecusd, Kraken ZEC/USD, Coinbase BTC-USD, Bitstamp btcusd and Kraken XBT/USD");
    await expect(page.getByTestId("review-term-sources")).toHaveText("api.exchange.coinbase.com, www.bitstamp.net, api.kraken.com");
  });

  test("ETH vs BTC with a 2-point margin; a coin on 2 exchanges uses only the shared ones; the same coin twice is refused", async ({ page }) => {
    await setup(page);
    await openBetType(page, "outperform");
    await page.getByTestId("guided-start_utc").fill("2027-12-01T15:00");
    await page.getByTestId("guided-end_utc").fill("2027-12-08T15:00");
    await page.getByTestId("guided-margin_pts").fill("2");
    await expect(page.getByTestId("fill-sentence")).toContainText("Ethereum (ETH) beats Bitcoin (BTC) by at least 2 percentage points");
    await page.getByTestId("asset-a-search").fill("two");
    await expect(page.getByTestId("guided-asset-a")).toHaveValue("TWO");
    await expect(page.getByTestId("outperform-venues")).toHaveText("Checked on Coinbase and Kraken (the exchanges that list both coins)");
    await page.getByTestId("asset-a-search").fill("");
    await page.getByTestId("guided-asset-a").selectOption("BTC");
    await expect(page.getByTestId("fill-sentence")).toHaveCount(0); // never "Bitcoin beats Bitcoin"
    await page.getByTestId("fill-next").click({ force: true }); // aria-disabled: a Next attempt reveals the problem
    await expect(page.getByTestId("fill-error")).toContainText("Pick two different coins.");
    await expect(page.getByTestId("step-resolver")).toHaveCount(0);
    await page.getByTestId("guided-asset-a").selectOption("ETH");
    await toReview(page);
    await expect(page.getByTestId("review-decider")).toContainText("Decided by the AI judge reading");
  });
});
