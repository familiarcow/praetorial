// NAV1 (UX-31 / UX-32), mocked: the Home / About / Wallet shell. Top nav (also at 375px), the three Home sections, About content,
// Account rows (F3, was Wallet cards), /add-money and /wallet -> /account, and the paused banner on the logged-out page.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";

const ME = "11".repeat(32);
const SIG = "22".repeat(64);
const RPC = "https://test.rpc.fastnear.com";
const INDEXER = "http://localhost:8787";
const USDC = "nep141:usdc.testnet";
const DAY = 86_400_000;

function bet(id: number, o: { maker: string; taker?: string | null; status: string; claim: string; sm?: string; outcome?: string; proposedAtMs?: number; referee?: string }) {
  return {
    envelope: {
      bet_id: id, version: 1, maker: o.maker, taker_allow: "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "x", outcomes: ["YES", "NO"], maker_side: "YES",
      maker_asset: USDC, taker_asset: USDC, stake_maker: o.sm ?? "10000000", stake_taker: o.sm ?? "10000000", taker_options: [], fee_bps: 100, reserve_per_side: "0",
      storage_charge_per_side: "0", keep_terms: true, terms: JSON.stringify({ claimText: o.claim }), run_price: "0", max_paid_runs: 3, tier: 1, arbiter: null, arbiter_fee: "0",
      funding_deadline: (Date.now() + 6 * DAY + 3_600_000) * 1e6, early_settle_outcome: null, finality_delay: 0, settlement_period: DAY * 1e6,
      resolve_deadline: (Date.now() + 30 * DAY) * 1e6, consent_party_controlled: false, referee: o.referee ? { account: o.referee, mode: "Human" } : null,
    },
    status: o.status, taker: o.taker ?? null, created_at: 0, taken_at: null, proposed_at: o.proposedAtMs ? o.proposedAtMs * 1e6 : null, outcome: o.outcome ?? null,
    reserve_remaining: "0", bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0,
  };
}
const BETS: Record<number, ReturnType<typeof bet>> = {
  1: bet(1, { maker: ME, status: "Open", claim: "My open offer." }),
  2: bet(2, { maker: ME, taker: "bob.testnet", status: "Taken", claim: "My live bet." }),
  3: bet(3, { maker: "carol.testnet", taker: ME, status: "Settled", outcome: "NO", claim: "My settled bet." }),
  4: bet(4, { maker: "alice.testnet", status: "Open", claim: "Alice's open offer.", sm: "12500000" }),
  5: bet(5, { maker: "dave.testnet", taker: "erin.testnet", status: "Proposed", outcome: "YES", proposedAtMs: Date.now() - 3_600_000, claim: "Dave and Erin's bet." }),
  6: bet(6, { maker: "fay.testnet", taker: "gus.testnet", status: "Taken", referee: "ref.testnet", claim: "A referee bet." }),
};
const hist = (ids: number[]) => ids.map((id) => ({ bet_id: id, maker: BETS[id]!.envelope.maker, taker: BETS[id]!.taker, status: BETS[id]!.status, outcome: BETS[id]!.outcome }));

async function mock(page: Page, o: { mine?: number[]; paused?: boolean; usdc?: string; usdcInWallet?: string } = {}) {
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const p = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (p.request_type === "view_account") return ok({ amount: "0" });
    if (p.request_type === "call_function") {
      const args = JSON.parse(Buffer.from(p.args_base64 ?? "e30=", "base64").toString("utf8") || "{}");
      let r: unknown = null;
      if (p.method_name === "is_paused") r = !!o.paused;
      else if (p.method_name === "is_shutdown") r = false;
      else if (p.method_name === "get_bet") r = BETS[args.bet_id] ?? null;
      else if (p.method_name === "pending_payouts") r = [];
      else if (p.method_name === "mt_balance_of") r = args.token_id === USDC ? (o.usdc ?? "0") : "0";
      else if (p.method_name === "ft_balance_of") r = p.account_id === "usdc.testnet" ? (o.usdcInWallet ?? "0") : "0";
      else if (p.method_name === "judge_chain") r = [{ model_a: "deepseek-ai/DeepSeek-V4.1-Flash-1017", model_b: "z-ai/glm-5.3-flash" }];
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  await page.route(`${INDEXER}/**`, async (route) => {
    const u = new URL(route.request().url());
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/offers") return json([1, 4].map((id) => ({ bet_id: id, maker: BETS[id]!.envelope.maker, maker_side: "YES", stake_maker: "10000000", stake_taker: "10000000", funding_deadline: BETS[id]!.envelope.funding_deadline, taker_allow: "Any", contract_id: "praetorial-frz3-2611100414.praetorial-dev-1101.testnet" })));
    if (u.searchParams.get("account")) return json(hist(o.mine ?? [1, 2, 3]));
    if (u.searchParams.get("referee")) return json([]);
    return json(hist([6, 5, 4, 3, 2, 1]));
  });
}
const signIn = (page: Page) => page.addInitScript(({ a, s }) => { (window as any).__e2eTestWallet = { nearAddress: a, signRawHash: async () => s }; }, { a: ME, s: SIG });
const ready = (page: Page) => page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });

test.describe("NAV1 Home / About / Account (F3: was Wallet)", () => {
  test("top nav: Home, About, Account and a primary Create bet; tabs switch pages without a reload", async ({ page }) => {
    await signIn(page); await mock(page);
    await page.goto("/"); await ready(page);
    await expect(page.getByTestId("nav-home")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("nav-create")).toHaveText("Create bet");
    await page.evaluate(() => { (window as any).__noReload = true; });
    await page.getByTestId("nav-docs").click(); // DOCS1: About is now Docs
    await expect(page).toHaveURL(/\/docs$/);
    await expect(page.getByTestId("docs-page")).toBeVisible();
    await page.getByTestId("nav-account").click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByTestId("add-money")).toBeVisible();
    await page.getByTestId("nav-home").click();
    await expect(page.getByTestId("home")).toBeVisible();
    expect(await page.evaluate(() => (window as any).__noReload)).toBe(true);
    for (const id of ["nav-browse", "nav-my-bets", "nav-balance", "landing"]) await expect(page.getByTestId(id)).toHaveCount(0);
  });

  test("375px: the nav fits (no horizontal scroll) and every tab and Create bet is reachable", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page); await mock(page);
    await page.goto("/"); await ready(page);
    for (const id of ["nav-home", "nav-docs", "nav-account", "nav-create"]) await expect(page.getByTestId(id)).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.getByTestId("nav-account").click();
    await expect(page).toHaveURL(/\/account$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.getByTestId("nav-create").click();
    await expect(page).toHaveURL(/\/new$/);
  });

  test("Home (H1): My Bets (Open offers, In progress, Settled collapsed), Explore (others' open offers only), In progress (others' bets only)", async ({ page }) => {
    await signIn(page); await mock(page);
    await page.goto("/"); await ready(page);
    const titles = await page.locator("[data-testid=home] h2").allTextContents();
    expect(titles).toEqual(["My Bets", "Explore Bets", "In progress", "Settled"]); // SET1: Settled (public) after In progress
    const groups = page.locator("[data-testid=my-bets] [data-testid^=mybets-group-]");
    await expect(groups).toHaveCount(2);
    expect(await groups.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")))).toEqual(["mybets-group-open", "mybets-group-progress"]);
    await expect(page.getByTestId("mybets-group-open").getByTestId("mybet-row-1")).toBeVisible();
    // Settled (UX-37 #3): one collapsed summary row
    await expect(page.getByTestId("mybets-settled").locator("summary")).toContainText("Settled (1)");
    await expect(page.getByTestId("mybets-settled-summary")).toHaveText("won 1");
    await expect(page.getByTestId("mybet-row-3")).toBeHidden();
    // Explore: Alice's offer as a kit offer card in token units; my own offer is not repeated there.
    await expect(page.getByTestId("offer-row-4")).toBeVisible();
    await expect(page.getByTestId("offer-row-4")).toContainText(/You put in 12\.50 USDC\s*·\s*win 12\.50 USDC/);
    await expect(page.getByTestId("offer-row-1")).toHaveCount(0);
    // In progress (UX-37 #2): other people's accepted, unsettled bets only; mine (2) are under My Bets; open and settled ones are not listed.
    await expect(page.getByTestId("progress-row-5").locator("[data-kit=StatusPill]")).toHaveText("Ruling made");
    await expect(page.getByTestId("progress-row-5")).toHaveAttribute("data-variant", "public");
    // SET1: the public Settled section lists every finished bet, mine too (3: carol conceded to me).
    await expect(page.getByTestId("settled-row-3")).toContainText("Ended NO by concession.");
    await expect(page.getByTestId("settled-row-3")).toHaveAttribute("data-variant", "public");
    await expect(page.getByTestId("progress-row-6").locator("[data-kit=StatusPill]")).toHaveText("Live");
    await expect(page.getByTestId("progress-row-6")).not.toContainText(".testnet");
    for (const id of [1, 2, 3, 4]) await expect(page.getByTestId(`progress-row-${id}`)).toHaveCount(0);
    await expect(page.getByTestId("in-progress").locator("[data-kit=ActionBar]")).toHaveCount(0);
    await page.getByTestId("progress-row-5").locator(".k-card__link").click();
    await expect(page).toHaveURL(/\/bet\/5$/);
  });

  test("Home: no bets yet -> My Bets empty state with a Create bet button", async ({ page }) => {
    await signIn(page); await mock(page, { mine: [] });
    await page.goto("/"); await ready(page);
    await expect(page.getByTestId("mybets-empty")).toContainText("You haven't made a bet yet.");
    await page.getByTestId("mybets-create").click();
    await expect(page).toHaveURL(/\/new$/);
  });

  // DOCS1: About's sections moved into the Docs: what/how/fees/know on /docs, models/verify on /docs/verification.
  test("Docs (was About): the sections, the judge models (live chain) and the fees in token units", async ({ page }) => {
    await signIn(page); await mock(page);
    await page.goto("/about"); await ready(page);
    await expect(page).toHaveURL(/\/docs$/);
    await expect(page.getByTestId("docs-what")).toBeVisible();
    for (const id of ["how", "fees", "know"]) await expect(page.getByTestId(`about-${id}`)).toBeVisible();
    await expect(page.getByTestId("about-fee-USDC")).toContainText("0.50 USDC");
    expect(await page.getByTestId("docs-page").textContent()).not.toMatch(/\$\d/);
    await page.goto("/docs/verification"); await ready(page);
    for (const id of ["models", "verify"]) await expect(page.getByTestId(`about-${id}`)).toBeVisible();
    await expect(page.getByTestId("judge-models")).toHaveAttribute("data-source", "live");
    await expect(page.getByTestId("judge-pair-1")).toContainText("DeepSeek-V4.1-Flash + glm-5.3-flash");
    await expect(page.getByTestId("about-verify")).toContainText("8791413f…");
    expect(await page.getByTestId("docs-page").textContent()).not.toMatch(/\$\d/);
  });

  test("Account (F3, was Wallet): one row per token in token units (never $), NEAR-account line + Move inline, cash out from the token sheet, Add money sheet", async ({ page }) => {
    await signIn(page); await mock(page, { usdc: "12500000", usdcInWallet: "3000000" });
    await page.goto("/account"); await ready(page);
    // The raw account id lives only in the collapsed Account details row (PEOPLE RULE), in full, with Copy.
    await expect(page.getByTestId("account-details")).not.toHaveAttribute("open", "");
    await expect(page.getByTestId("wallet-account-id")).toBeHidden();
    await page.getByTestId("account-details").locator("summary").click();
    await expect(page.getByTestId("wallet-account-id")).toHaveText(ME);
    await expect(page.getByTestId("account-id-copy")).toHaveText("Copy account ID");
    await expect(page.getByTestId("balance-row-USDC")).toHaveText("12.50 USDC");
    await expect(page.getByTestId("wallet-amount-USDC")).toHaveText("In your NEAR account: 3.00 USDC");
    await expect(page.getByTestId("asset-card-USDC").locator("[data-kit=AssetLogo]")).toHaveAttribute("src", /^(data:image\/svg|\/assets\/|\/src\/assets\/logos\/usdc\.svg)/); // bundled locally (dev serves the source file)
    await expect(page.getByTestId("move-USDC-token")).toHaveText("Move 3.00 USDC to betting");
    // Zero rows are one compact muted line, after the non-zero ones; no NEAR-account line is invented for them.
    await expect(page.getByTestId("asset-card-NEAR")).toHaveAttribute("data-compact", "1");
    await expect(page.getByTestId("wallet-amount-NEAR")).toHaveCount(0);
    expect(await page.locator("[data-testid=balances] > li").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")))).toEqual(["asset-card-USDC", "asset-card-NEAR"]);
    expect(await page.getByTestId("add-money").textContent()).not.toMatch(/\$\d/);
    await expect(page.getByTestId("account-total-usd")).toHaveCount(0); // testnet tokens have no price
    // Cash out to my NEAR account sits in the token sheet; NEAR (0 here) offers none.
    await page.getByTestId("asset-row-USDC").click();
    await expect(page.getByTestId("token-sheet-betting")).toHaveText("12.50 USDC");
    await expect(page.getByTestId("withdraw-btn-USDC")).toHaveText("Cash out to my NEAR account");
    await page.getByTestId("modal-close").click();
    await page.getByTestId("asset-row-NEAR").click();
    await expect(page.getByTestId("withdraw-btn-NEAR")).toHaveCount(0);
    await page.getByTestId("modal-close").click();
    // Add money (until F4's sheet lands): testnet says deposit addresses are mainnet-only and offers test NEAR.
    await page.getByTestId("account-add-money").click();
    await expect(page.getByTestId("deposit-mainnet-note")).toBeVisible();
    await expect(page.getByTestId("add-money-sheet").getByTestId("get-test-near")).toBeVisible();
  });

  test("old /add-money and /wallet links (the funding hand-off) land on /account with their query", async ({ page }) => {
    await signIn(page); await mock(page);
    await page.goto("/add-money?asset=USDC&need=10&return=%2Fbet%2F4"); await ready(page);
    await expect(page).toHaveURL(/\/account\?asset=USDC&need=10&return=%2Fbet%2F4$/);
    await expect(page.getByTestId("balance-headline")).toHaveText("Your balance: 0.00 USDC. You need 10.00 USDC more.");
    await expect(page.getByTestId("add-money-back")).toHaveText("Back to the bet");
    await page.goto("/wallet?asset=USDC&need=10"); await expect(page).toHaveURL(/\/account\?asset=USDC&need=10$/);
    await page.goto("/browse"); await expect(page).toHaveURL(/\/$/);
    await page.goto("/judges"); await expect(page).toHaveURL(/\/docs\/verification#models$/); // DOCS1: About is now Docs
  });

  test("logged out: the login page alone, with the paused banner (the refund message needs no login)", async ({ page }) => {
    await mock(page, { paused: true });
    await page.goto("/"); await ready(page);
    await expect(page.getByTestId("login-gate")).toBeVisible();
    await expect(page.getByTestId("banner-paused")).toBeVisible();
    await expect(page.getByTestId("home")).toHaveCount(0);
  });
});
