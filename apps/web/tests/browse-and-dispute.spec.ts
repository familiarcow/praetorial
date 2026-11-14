// Browse page + dispute screens, fully mocked (indexer HTTP + NEAR RPC
// view calls via route interception) -- no real Privy login.
// jason-bet.spec.ts/term-sheet-and-referee.spec.ts remain the only specs that touch real Privy auth.
// LOGIN1 (UX-29): these used to be logged-out public reads; logged out is now only the login page, so every test here runs
// as a signed-in viewer whose NEAR wallet is not set up yet (signInNoWallet) -- the same "can see, cannot sign" view.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { ESCROW_CONTRACT_ID } from "../lib/config";
import { signInNoWallet } from "./lib/loginSeam";
import { mockUsernames } from "./lib/betPage";

test.beforeEach(async ({ page }) => { await signInNoWallet(page); });

const INDEXER_URL = "http://localhost:8787";
const ESCROW = ESCROW_CONTRACT_ID;

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

// Builds a minimal but complete Bet JSON (contracts/escrow/src/lib.rs's
// shape) for a given RPC view-call result payload.
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
      keep_terms: true,
      terms: JSON.stringify({ claimText: "BTC closes above $100k on Coinbase" }),
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
    taker: null,
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

async function mockRpc(page: Page, bets: Record<number, any>, bondQuote: any) {
  await page.route("https://test.rpc.fastnear.com", async (route) => {
    const req = route.request();
    const body = JSON.parse(req.postData() ?? "{}");
    const params = body.params ?? {};
    if (params.request_type === "call_function") {
      const argsJson = JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8"));
      let resultObj: unknown = null;
      if (params.method_name === "get_bet") {
        resultObj = bets[argsJson.bet_id] ?? null;
      } else if (params.method_name === "required_challenge_bond") {
        resultObj = bondQuote;
      } else if (params.method_name === "open_offers") {
        resultObj = Object.values(bets).filter((b: any) => b.status === "Open");
      }
      const bytes = Array.from(Buffer.from(JSON.stringify(resultObj), "utf8"));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result: { result: bytes } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result: {} }) });
  });
}

test.describe("Browse page (mocked indexer + RPC, signed in, no wallet)", () => {
  test.beforeEach(async ({ page }) => {
    await page.route(`${INDEXER_URL}/offers`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            bet_id: 1,
            contract_id: ESCROW,
            maker: "maker.testnet",
            maker_side: "YES",
            stake_maker: "100000000",
            stake_taker: "100000000",
            funding_deadline: Date.now() * 1_000_000 + 7 * 24 * 3600 * 1_000_000_000,
            taker_allow: "Any",
          },
          {
            bet_id: 2,
            contract_id: ESCROW,
            maker: "maker2.testnet",
            maker_side: "NO",
            stake_maker: "5",
            stake_taker: "5",
            funding_deadline: 0,
            taker_allow: JSON.stringify({ Account: "someone.testnet" }),
          },
        ]),
      }),
    );
    await mockRpc(page, { 1: betResult() }, null);
    await page.goto("/");
    await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
    // NAV1 (UX-31): the open-offers board is Home's "Explore Bets" section.
    await expect(page.getByTestId("browse-page")).toBeVisible();
  });

  test("lists only untargeted open offers, with human stakes and term-sheet question (BROWSE1: stakes now in human units, not base units)", async ({ page }) => {
    await expect(page.getByTestId("offer-row-1")).toBeVisible();
    await expect(page.getByTestId("offer-row-2")).toHaveCount(0); // direct-challenge offer excluded
    await expect(page.getByTestId("offer-row-1")).toContainText(/You put in 100\.00 USDC\s*·\s*win 100\.00 USDC/); // H1: kit offer card
    await expect(page.getByTestId("offer-row-1").locator(".k-card__q")).toContainText("BTC closes above $100k on Coinbase");
  });

  test("asset filter narrows the open-offers list (H1: logo chips)", async ({ page }) => {
    await page.getByTestId("browse-chip-NEAR").click();
    await expect(page.getByTestId("offer-row-1")).toHaveCount(0);
    await page.getByTestId("browse-chip-USDC").click();
    await expect(page.getByTestId("offer-row-1")).toBeVisible();
  });

  // NAV1: was "My bets tab is disabled with no wallet". My Bets is its own Home section now; Explore has no tabs.
  test("Explore has no My bets tab; with no wallet yet My Bets says the account is being set up", async ({ page }) => {
    await expect(page.getByTestId("browse-tab-mine")).toHaveCount(0);
    await expect(page.getByTestId("mybets-wallet-pending")).toBeVisible();
  });
});

test.describe("Dispute screens on BetPage (mocked RPC, signed in, no wallet)", () => {
  test("round 1 challenged bet shows round label, countdown, exhibits, and quoted bond", async ({ page }) => {
    const bet = betResult({
      status: "Challenged",
      taker: "taker.testnet",
      proposed_at: Date.now() * 1_000_000 - 1_000_000_000,
      bonds: [{ holder: "taker.testnet", amount: "1000000", round: 1, pre_challenge_outcome: "YES", asset: "nep141:usdc.testnet" }],
      exhibits: [
        { hash: "exhibit-hash-a", submitted_at: "0", submitted_by: "maker.testnet" },
        { hash: "exhibit-hash-b", submitted_at: "0", submitted_by: "taker.testnet" },
      ],
    });
    await mockRpc(page, { 1: bet }, { amount: "4000000", asset: "nep141:usdc.testnet" });
    await mockUsernames(page);
    await page.goto("/");
    await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
    await page.evaluate(() => { history.pushState({}, "", "/bet/1"); window.dispatchEvent(new PopStateEvent("popstate")); }); // FE1: in-app nav to /bet/1 (typed bet-id box removed)
    await expect(page.getByTestId("bet-status")).toHaveText("Challenged");
    // B1 (UIR1 §3.5): the round is in the header sentence (plain words), the countdown is the header's time, the exhibits are under
    // Details -> Evidence filed (who as @username, the hash with a copy button).
    await expect(page.getByTestId("bet-sentence")).toHaveText("Challenged by @taker. The AI looks again.");
    await expect(page.getByTestId("bet-header").locator('[data-kit="TimeLeft"]')).toBeVisible();
    await page.getByTestId("details-exhibits").locator("summary").click();
    const ex = page.getByTestId("details-exhibits");
    await expect(ex.locator("[data-exhibit]")).toHaveCount(2);
    await expect(ex.locator("[data-exhibit]").nth(0)).toContainText("exhibit-hash-a");
    await expect(ex.locator("[data-exhibit]").nth(0)).toContainText("@maker");
    await expect(ex.locator("[data-exhibit]").nth(1)).toContainText("exhibit-hash-b");
    await expect(ex.locator("[data-exhibit]").nth(1)).toContainText("@taker");
  });

  test("final (round 2) dispute shows the final-appeal label and no further bond quote", async ({ page }) => {
    const bet = betResult({
      status: "Rejudge",
      taker: "taker.testnet",
      proposed_at: Date.now() * 1_000_000,
      bonds: [
        { holder: "taker.testnet", amount: "1000000", round: 1, pre_challenge_outcome: "YES", asset: "nep141:usdc.testnet" },
        { holder: "maker.testnet", amount: "2000000", round: 2, pre_challenge_outcome: "NO", asset: "nep141:usdc.testnet" },
      ],
      exhibits: [],
    });
    await mockRpc(page, { 1: bet }, null); // required_challenge_bond -> None at max_rounds
    await mockUsernames(page);
    await page.goto("/");
    await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
    await page.evaluate(() => { history.pushState({}, "", "/bet/1"); window.dispatchEvent(new PopStateEvent("popstate")); }); // FE1: in-app nav to /bet/1 (typed bet-id box removed)
    // B1: the last round says so in plain words; no challenge is offered; Details -> Evidence filed says none was filed.
    await expect(page.getByTestId("bet-sentence")).toHaveText("Challenged again by @maker. The AI looks one last time; there is no appeal after this.");
    await expect(page.getByTestId("challenge-btn")).toHaveCount(0);
    await expect(page.getByTestId("details-exhibits-summary")).toBeVisible();
    await page.getByTestId("details-exhibits").locator("summary").click();
    await expect(page.getByTestId("details-exhibits")).toContainText("No evidence filed.");
  });

  test("B1: Activity is collapsed, and a live change shows a toast and lands in Activity on the next poll", async ({ page }) => {
    let pollCount = 0;
    await page.route("https://test.rpc.fastnear.com", async (route) => {
      const req = route.request();
      const body = JSON.parse(req.postData() ?? "{}");
      const params = body.params ?? {};
      if (params.request_type !== "call_function") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result: {} }) });
        return;
      }
      if (params.method_name === "get_bet") {
        pollCount += 1;
        const status = pollCount === 1 ? "Open" : "Taken";
        const bytes = Array.from(Buffer.from(JSON.stringify(betResult(status === "Taken" ? { status, taker: "taker.testnet", taken_at: Date.now() * 1_000_000 } : { status })), "utf8"));
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result: { result: bytes } }) });
        return;
      }
      const bytes = Array.from(Buffer.from(JSON.stringify(null), "utf8"));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result: { result: bytes } }) });
    });
    await page.goto("/");
    await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
    await page.evaluate(() => { history.pushState({}, "", "/bet/1"); window.dispatchEvent(new PopStateEvent("popstate")); }); // FE1: in-app nav to /bet/1 (typed bet-id box removed)
    await expect(page.getByTestId("bet-status")).toHaveText("Open");
    // B1 (familiarcow UX-37 #9): the Notifications panel became a collapsed Activity section (the bet's full history) plus a toast when
    // the bet changes while you look. No toast on first load.
    const activity = page.getByTestId("bet-activity");
    await expect(activity).toBeVisible();
    await expect(activity).not.toHaveJSProperty("open", true);
    await expect(page.getByTestId("toast")).toHaveCount(0);
    // BetPage polls get_bet every 15s; wait for the second poll to land.
    await expect(page.getByTestId("bet-status")).toHaveText("Taken", { timeout: 20_000 });
    await expect(page.getByTestId("toast")).toHaveText(/^Update: /);
    await activity.locator("summary").first().click(); // V1: each Activity row now has its own nested "Verify" summary
    await expect(activity.locator('li[data-entry="taken"]')).toBeVisible();
  });
});

// FE11: the same dispute mocks, extended for rounds 1 and 2 (ruling card + round-aware challenge state).
test.describe("FE11 dispute mocks, rounds 1 and 2", () => {
  const nav = async (page: Page) => {
    await page.goto("/");
    await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
    await page.evaluate(() => { history.pushState({}, "", "/bet/1"); window.dispatchEvent(new PopStateEvent("popstate")); });
  };
  test("round 1 challenged: ruling card still shows the standing ruling", async ({ page }) => {
    const bet = betResult({ status: "Challenged", taker: "taker.testnet", outcome: "YES", proposed_at: Date.now() * 1_000_000 - 1_000_000_000, bonds: [{ holder: "taker.testnet", amount: "1000000", round: 1, pre_challenge_outcome: "YES", asset: "nep141:usdc.testnet" }] });
    await mockRpc(page, { 1: bet }, { amount: "4000000", asset: "nep141:usdc.testnet" });
    await nav(page);
    await expect(page.getByTestId("ruling-headline")).toContainText("Ruling: YES");
    await expect(page.getByTestId("challenge-btn")).toHaveCount(0); // a challenge is already open
  });
  test("round 2 (final) bet: ruling card and no-more-appeals for a viewer with no wallet is not shown as a challenge", async ({ page }) => {
    const bet = betResult({ status: "Rejudge", taker: "taker.testnet", outcome: "NO", proposed_at: Date.now() * 1_000_000, bonds: [
      { holder: "taker.testnet", amount: "1000000", round: 1, pre_challenge_outcome: "YES", asset: "nep141:usdc.testnet" },
      { holder: "maker.testnet", amount: "2000000", round: 2, pre_challenge_outcome: "NO", asset: "nep141:usdc.testnet" }] });
    await mockRpc(page, { 1: bet }, null);
    await nav(page);
    await expect(page.getByTestId("ruling-headline")).toContainText("Ruling: NO");
    await expect(page.getByTestId("challenge-btn")).toHaveCount(0);
  });
});
