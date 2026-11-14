// SET1 (PM, 2026-11-14: "I cant see the bets that have already finished, I just see the in progress ones. I want all users to be able to
// see them"), mocked: Home's public "Settled" section. A guest sees finished bets (the ruling, who made it, who was paid) as cards that
// open /bet/<id>; never-taken bets are not listed; loading error has Retry; empty says so; Show more pages through.
// Fully mocked (indexer + NEAR RPC via page.route); never the Privy test user or any shared credential.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { mkdirSync } from "node:fs";
import { ESCROW_CONTRACT_ID } from "../lib/config";
import { mockUsernames } from "./lib/betPage";

const INDEXER = "http://localhost:8787";
const RPC = "https://test.rpc.fastnear.com";
const SHOTS = new URL("../test-results/set1-shots/", import.meta.url).pathname;
const DAY_NS = 24 * 3600 * 1_000_000_000;
const NOW_NS = () => Date.now() * 1_000_000;

function bet(id: number, over: Record<string, any> = {}) {
  const base = {
    envelope: {
      bet_id: id, version: 1, maker: "maker.testnet", taker_allow: "Any", terms_hash: "deadbeef".repeat(4), models_snapshot_hash: "x",
      outcomes: ["YES", "NO"], maker_side: "YES", maker_asset: "nep141:usdc.testnet", taker_asset: "nep141:usdc.testnet",
      stake_maker: "100000000", stake_taker: "100000000", taker_options: [], fee_bps: 100, reserve_per_side: "0", storage_charge_per_side: "0",
      keep_terms: true, terms: JSON.stringify({ claimText: `Bitcoin closes above 100,000 USD on Coinbase (bet ${id})` }), run_price: "0", max_paid_runs: 3, tier: 1,
      arbiter: null, arbiter_fee: "0", funding_deadline: NOW_NS() - 5 * DAY_NS, early_settle_outcome: null, finality_delay: 0,
      settlement_period: DAY_NS, resolve_deadline: NOW_NS() + 30 * DAY_NS, consent_party_controlled: false, referee: null,
    },
    status: "Open", taker: null, created_at: 0, taken_at: null, proposed_at: null, outcome: null, reserve_remaining: "0", bonds: [], exhibits: [],
    challenged_by: null, window_extension_ns: 0, fee_min_maker: "0", fee_min_taker: "0", tip_maker: "0", tip_taker: "0",
  };
  return { ...base, ...over, envelope: { ...base.envelope, ...(over.envelope ?? {}) } };
}
const taken = { taker: "taker.testnet", taken_at: NOW_NS() - 4 * DAY_NS };
const WORLD = (): Record<number, any> => ({
  1: bet(1, { envelope: { funding_deadline: NOW_NS() + 7 * DAY_NS } }),
  2: bet(2, { ...taken, status: "Taken", envelope: { funding_deadline: NOW_NS() + 3 * DAY_NS } }),
  3: bet(3, { ...taken, status: "Settled", outcome: "NO", proposed_at: NOW_NS() - 3 * DAY_NS }),
  4: bet(4, { ...taken, status: "Settled", outcome: "YES", proposed_at: NOW_NS() - 2 * DAY_NS, envelope: { maker: "alice.testnet", referee: { account: "kim.testnet", mode: "Human" } } }),
  5: bet(5, { status: "Expired" }),
});

async function mockReads(page: Page, bets: Record<number, any>, history: { fail?: () => boolean } = {}) {
  await mockUsernames(page);
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route(`${INDEXER}/**`, (r) => {
    const p = new URL(r.request().url()).pathname;
    if (p.includes("history") && history.fail?.()) return r.fulfill({ status: 500, headers: { "access-control-allow-origin": "*" }, body: "down" });
    const rows = Object.values(bets).filter((b) => (p.includes("offers") ? b.status === "Open" : b.status !== "Open"))
      .map((b) => ({ bet_id: b.envelope.bet_id, contract_id: ESCROW_CONTRACT_ID, maker: b.envelope.maker, maker_side: "YES", stake_maker: b.envelope.stake_maker,
        stake_taker: b.envelope.stake_taker, funding_deadline: b.envelope.funding_deadline, taker_allow: "Any", status: b.status, taker: b.taker, outcome: b.outcome }));
    return r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(rows) });
  });
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100, timestamp: NOW_NS(), timestamp_nanosec: String(NOW_NS()) } });
    if (params.request_type === "call_function") {
      const args = params.args_base64 ? JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8") || "{}") : {};
      let r: unknown = null;
      if (params.method_name === "is_paused" || params.method_name === "is_shutdown") r = false;
      else if (params.method_name === "get_bet") r = bets[args.bet_id] ?? null;
      else if (params.method_name === "open_offers") r = Object.values(bets).filter((b) => b.status === "Open");
      else if (params.method_name === "bet_count") r = Object.keys(bets).length;
      else if (params.method_name === "pending_payouts") r = [];
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
}
async function ready(page: Page) { await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 }); }
async function asGuest(page: Page) {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("e2e:guest-seeded")) return;
    window.sessionStorage.setItem("e2e:guest-seeded", "1");
    window.sessionStorage.setItem("praetorial:guest", "1");
  });
}

test.describe("SET1 Home: public Settled section (mocked)", () => {
  test("a guest sees Settled after In progress: finished bets with the ruling and who made it; a card opens /bet/<id>", async ({ page }) => {
    await mockReads(page, WORLD());
    await asGuest(page);
    await page.goto("/");
    await ready(page);
    await expect(page.getByTestId("guest-banner")).toBeVisible();
    await expect(page.getByTestId("settled-row-3")).toBeVisible();
    expect(await page.locator("[data-testid=home] h2").allTextContents()).toEqual(["Explore Bets", "In progress", "Settled"]);
    const ids = await page.getByTestId("settled").locator("[data-kit=BetCard]").evaluateAll((els) => els.map((e) => e.getAttribute("data-bet")));
    expect(ids, "newest first; the open, live and never-taken (expired) bets are not settled").toEqual(["4", "3"]);
    const ai = page.getByTestId("settled-row-3");
    await expect(ai).toHaveAttribute("data-variant", "public");
    await expect(ai.locator("[data-kit=StatusPill]")).toHaveText("Settled");
    await expect(ai).toContainText("Bitcoin closes above 100,000 USD on Coinbase (bet 3)");
    await expect(ai).toContainText("The AI judge ruled NO. @taker won 198.00 USDC.");
    await expect(ai).toContainText("100.00 USDC");
    await expect(ai).not.toContainText(".testnet");
    await expect(page.getByTestId("settled-row-4")).toContainText("@kim ruled YES. @alice won 198.00 USDC.");
    await expect(page.getByTestId("settled").locator("[data-kit=ActionBar]")).toHaveCount(0);
    await expect(page.getByTestId("progress-row-2")).toBeVisible();
    await expect(page.getByTestId("progress-row-3")).toHaveCount(0);
    mkdirSync(SHOTS, { recursive: true });
    await page.getByTestId("settled").screenshot({ path: `${SHOTS}guest-settled.png` });
    await ai.locator(".k-card__link").click();
    await expect(page).toHaveURL(/\/bet\/3$/);
    await expect(page.getByTestId("bet-page")).toBeVisible();
  });

  test("logged in: my own finished bet is listed too (unlike In progress), with my result", async ({ page }) => {
    const ME = "11".repeat(32);
    const world = WORLD();
    world[3].taker = ME;
    await mockReads(page, world);
    await page.addInitScript(({ a, s }) => { (window as any).__e2eTestWallet = { nearAddress: a, signRawHash: async () => s }; }, { a: ME, s: "22".repeat(64) });
    await page.goto("/");
    await ready(page);
    const mine = page.getByTestId("settled-row-3");
    await expect(mine).toBeVisible();
    await expect(mine.locator("[data-kit=StatusPill]")).toHaveText("Won");
    await expect(mine).toContainText("The AI judge ruled NO. You won 198.00 USDC.");
    await expect(page.getByTestId("settled-row-4")).toBeVisible();
  });

  test("empty: 'No settled bets yet.'; the indexer down: the error with Retry, which loads them", async ({ page }) => {
    let down = true;
    await mockReads(page, { 1: WORLD()[1] }, { fail: () => down });
    await asGuest(page);
    await page.goto("/");
    await ready(page);
    await expect(page.getByTestId("settled-error")).toContainText("We couldn't load the settled bets.");
    down = false;
    await page.getByTestId("settled-retry").click();
    await expect(page.getByTestId("settled-empty")).toHaveText("No settled bets yet.");
  });

  test("Show more: 20 at a time, newest first", async ({ page }) => {
    const bets: Record<number, any> = {};
    for (let i = 1; i <= 25; i++) bets[i] = bet(i, { ...taken, status: "Settled", outcome: i % 2 ? "YES" : "NO", proposed_at: NOW_NS() - 2 * DAY_NS });
    await mockReads(page, bets);
    await asGuest(page);
    await page.goto("/");
    await ready(page);
    const cards = page.getByTestId("settled").locator("[data-kit=BetCard]");
    await expect(cards).toHaveCount(20);
    await expect(cards.first()).toHaveAttribute("data-bet", "25");
    await page.getByTestId("settled-more").click();
    await expect(cards).toHaveCount(25);
    await expect(cards.last()).toHaveAttribute("data-bet", "1");
    await expect(page.getByTestId("settled-more")).toHaveCount(0);
  });
});
