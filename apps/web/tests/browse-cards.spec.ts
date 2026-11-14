// BROWSE1 + H1 (UIR1 §3.3): Explore shows readable kit BetCard "offer" cards, only for this build's escrow contract. Fully mocked
// (indexer + NEAR RPC + username registry), no real login. LOGIN1 (UX-29): browse is behind the login page now, so the viewer is
// signed in with no wallet yet (signInNoWallet). PEOPLE RULE: makers are @usernames ("Unnamed account" when unregistered), never ids.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { ESCROW_CONTRACT_ID } from "../lib/config";
import { screenPath } from "./lib/screens";
import { signInNoWallet } from "./lib/loginSeam";
import AxeBuilder from "@axe-core/playwright";

const INDEXER = "http://localhost:8787";
const OLD = "praetorial-frz2-2611091111.praetorial-dev-1101.testnet";
const HEX = "ab12cd" + "0".repeat(54) + "ef90";
const USDC = "nep141:usdc.testnet";
const day = 86_400_000;
const dl = (ms: number) => (Date.now() + ms) * 1_000_000;
const REG = "http://registry.e2e.test";
const NAMES: Record<string, string> = { "maker.testnet": "maker", "ref.testnet": "kim" };

const betJson = (id: number, o: Record<string, any> = {}) => ({
  envelope: { bet_id: id, version: 1, maker: o.maker ?? "maker.testnet", taker_allow: "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "cd".repeat(32),
    terms: JSON.stringify({ claimText: o.claim ?? "BTC closes above $100k on Coinbase" }), outcomes: ["YES", "NO"], maker_side: "YES",
    maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: "10000000", taker_options: [], fee_bps: 100,
    funding_deadline: o.deadline ?? dl(2 * day + 3_600_000), resolve_deadline: dl(9 * day), settlement_period: 86_400_000_000_000, referee: o.referee ?? null, ...(o.env ?? {}) },
  status: "Open", taker: null, created_at: 0, taken_at: null, proposed_at: null, outcome: null, reserve_remaining: "0", bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0, fee_min_taker: "500000",
});
const row = (id: number, o: Record<string, any> = {}) => ({ bet_id: id, contract_id: ESCROW_CONTRACT_ID, contract_version: 1, maker: "maker.testnet", maker_side: "YES", stake_maker: "10000000", stake_taker: "10000000", funding_deadline: dl(2 * day + 3_600_000), taker_allow: "Any", ...o });

async function setup(page: Page, rows: any[], bets: Record<number, any>) {
  await page.route(`${INDEXER}/offers**`, (r) => r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(rows) }));
  await page.route("https://test.rpc.fastnear.com", async (route) => {
    const params = JSON.parse(route.request().postData() ?? "{}").params ?? {};
    if (params.request_type !== "call_function") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result: {} }) });
    const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8"));
    if (params.method_name === "get_bet" && !(args.bet_id in bets)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -32000, message: "bet not found" } }) });
    const r = params.method_name === "get_bet" ? bets[args.bet_id] : null;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result: { result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) } }) });
  });
  await page.addInitScript((reg) => { (window as any).__e2eRegistryUrl = reg; }, REG);
  await page.route(`${REG}/**`, (route) => {
    const m = /\/lookup\/account\/([^/?]+)/.exec(new URL(route.request().url()).pathname);
    const name = m ? NAMES[decodeURIComponent(m[1]!)] : undefined;
    return name ? route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ username: name }) })
      : route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" }, body: "not found" });
  });
  await signInNoWallet(page);
  await page.goto("/browse");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
}

test.describe("BROWSE1 readable browse cards", () => {
  test("a row from an older contract is hidden; no raw values anywhere", async ({ page }) => {
    await setup(page, [row(1), row(5, { contract_id: OLD }), row(6, { contract_id: OLD, maker: HEX })], { 1: betJson(1), 5: betJson(5), 6: betJson(6) });
    await expect(page.getByTestId("offer-row-1")).toBeVisible();
    await expect(page.getByTestId("offer-row-5")).toHaveCount(0);
    await expect(page.getByTestId("offer-row-6")).toHaveCount(0);
    await expect(page.getByTestId("offer-row-1").locator("[data-kit=UserChip]")).toHaveText(/@maker/);
    const text = await page.getByTestId("open-offers-list").innerText();
    expect(text).not.toContain("?");
    expect(text).not.toContain("terms unavailable");
    expect(text).not.toMatch(/\d{8,}/);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test("a row whose get_bet fails is dropped, not shown raw", async ({ page }) => {
    await setup(page, [row(1), row(2)], { 1: betJson(1) });
    await expect(page.getByTestId("offer-row-1")).toBeVisible();
    await expect(page.getByTestId("offer-row-2")).toHaveCount(0);
  });

  test("duplicate bet id from two contracts renders one card (strict-mode safe)", async ({ page }) => {
    await setup(page, [row(7, { contract_id: OLD }), row(7), row(7)], { 7: betJson(7) });
    await expect(page.getByTestId("offer-row-7")).toHaveCount(1);
  });

  test("offer card: question, 'You put in X · win Y' with token logos, by @maker, who decides, closes in (relative); one Take button", async ({ page }) => {
    await setup(page, [row(1, { maker: HEX }), row(3, { maker: "maker.testnet" })], {
      1: betJson(1, { maker: HEX }),
      3: betJson(3, { referee: { account: "ref.testnet", mode: "Human" }, env: { maker_asset: "nep141:wrap.testnet", stake_maker: "1500000000000000000000000", stake_taker: "1234567000000000000000000", taker_asset: "nep141:wrap.testnet" } }),
    });
    const c1 = page.getByTestId("offer-row-1"), c3 = page.getByTestId("offer-row-3");
    await expect(c1).toHaveAttribute("data-variant", "offer");
    await expect(c1.locator(".k-card__q")).toHaveText("BTC closes above $100k on Coinbase");
    await expect(c1).toContainText(/You put in 10\.00 USDC\s*·\s*win 10\.00 USDC/);
    await expect(c1.locator("[data-kit=AssetLogo]")).toHaveCount(2);
    await expect(c1.locator("[data-kit=UserChip]")).toHaveText(/Unnamed account/); // no username: never the hex id
    await expect(c1.locator("[data-kit=DeciderChip]")).toHaveText(/AI judge/);
    await expect(c1.locator("[data-kit=TimeLeft]")).toContainText(/in 2 days/i);
    await expect(c1.getByTestId("action-take")).toHaveText("Take this bet");
    await expect(c1.locator("[data-kit=ActionBar] button")).toHaveCount(1);
    await expect(c3.locator("[data-kit=UserChip]").first()).toHaveText(/@maker/);
    await expect(c3.locator("[data-kit=DeciderChip]")).toHaveText(/@kim\s*decides/);
    await expect(c3).toContainText(/You put in 1\.23457 NEAR\s*·\s*win 1\.5 NEAR/);
    const text = await page.getByTestId("open-offers-list").innerText();
    expect(text).not.toMatch(/\.testnet|[0-9a-f]{16}|ab12cd/);
  });

  test("empty state text is exact", async ({ page }) => {
    await setup(page, [row(5, { contract_id: OLD })], { 5: betJson(5) });
    await expect(page.getByTestId("offers-status")).toHaveText("No open bets yet. Make one.");
  });

  test("clicking the card opens the bet page; so does Take", async ({ page }) => {
    await setup(page, [row(1), row(3)], { 1: betJson(1), 3: betJson(3) });
    await page.getByTestId("offer-row-1").click({ position: { x: 5, y: 5 } }); // anywhere on the card
    await expect(page).toHaveURL(/\/bet\/1$/);
    await page.goBack();
    await expect(page.getByTestId("offer-row-3").getByTestId("action-take")).toBeVisible();
    await page.getByTestId("offer-row-3").getByTestId("action-take").click();
    await expect(page).toHaveURL(/\/bet\/3$/);
  });

  // BROWSE1b: a card's accessible name must contain its visible text; a hash is never a question.
  test("BROWSE1b: offers with and without loadable terms: axe has no label-content-name-mismatch, no row mentions a terms hash", async ({ page }) => {
    const noTerms = betJson(6); noTerms.envelope.terms = null;
    const junkTerms = betJson(8); junkTerms.envelope.terms = "not json";
    await setup(page, [row(1), row(6), row(8)], { 1: betJson(1), 6: noTerms, 8: junkTerms });
    await expect(page.getByTestId("offer-row-1")).toBeVisible();
    await expect(page.getByTestId("offer-row-6")).toHaveCount(0);
    await expect(page.getByTestId("offer-row-8")).toHaveCount(0);
    const res = await new AxeBuilder({ page }).analyze();
    expect(res.violations.filter((v) => v.id === "label-content-name-mismatch")).toEqual([]);
    expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
    const text = await page.getByTestId("open-offers-list").innerText();
    expect(text.toLowerCase()).not.toContain("terms hash");
    const names = await page.locator('[data-testid^="offer-row-"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
    for (const n of names) expect(n.toLowerCase()).not.toContain("terms hash");
    // the accessible name (aria-label if any) must contain the visible question text
    const row1 = page.getByTestId("offer-row-1");
    const label = await row1.getAttribute("aria-label");
    if (label) expect(label).toContain("BTC closes above $100k on Coinbase");
  });

  // BROWSE1b (LAND1 @live step 5): every visible card's accessible name contains ALL of its visible text (no aria-label override).
  test("BROWSE1b: each card's accessible name contains its whole visible text", async ({ page }) => {
    await setup(page, [row(1), row(3, { maker: HEX })], { 1: betJson(1), 3: betJson(3, { maker: HEX, referee: { account: "ref.testnet", mode: "Human" } }) });
    // A1 (PM 03:45 flake under load): wait for the REAL resolved names first (a @username landing between two reads changed the text),
    // then read the visible text and the accessible name in ONE evaluate, so they describe the same render.
    await expect(page.getByTestId("offer-row-1").locator("[data-kit=UserChip]")).toHaveText(/@maker/);
    await expect(page.getByTestId("offer-row-3").locator("[data-kit=UserChip]").first()).toHaveText(/Unnamed account/);
    await expect(page.getByTestId("offer-row-3").locator("[data-kit=DeciderChip]")).toHaveText(/@kim\s*decides/);
    for (const id of [1, 3]) {
      const card = page.getByTestId(`offer-row-${id}`);
      await expect(card).toBeVisible();
      const { visible, name } = await card.evaluate((el) => ({
        visible: (el as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
        name: (el.getAttribute("aria-label") ?? (el as HTMLElement).innerText).replace(/\s+/g, " ").trim(),
      }));
      expect(visible, `offer-row-${id} still loading a name`).not.toContain("…");
      expect(name, `accessible name of offer-row-${id}`).toContain(visible);
    }
  });

  test("token filter: logo chips (All + bet tokens); a chip keeps offers staking that token, All brings them back", async ({ page }) => {
    await setup(page, [row(1), row(3)], { 1: betJson(1), 3: betJson(3, { env: { maker_asset: "nep141:wrap.testnet", taker_asset: "nep141:wrap.testnet", stake_maker: "1500000000000000000000000", stake_taker: "1500000000000000000000000" } }) });
    await expect(page.getByTestId("browse-chip-all")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("browse-chip-NEAR").locator("[data-kit=AssetLogo]")).toHaveCount(1);
    await page.getByTestId("browse-chip-NEAR").click();
    await expect(page.getByTestId("browse-chip-NEAR")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("offer-row-1")).toHaveCount(0);
    await expect(page.getByTestId("offer-row-3")).toBeVisible();
    await page.getByTestId("browse-chip-USDC").click();
    await expect(page.getByTestId("offer-row-3")).toHaveCount(0);
    await expect(page.getByTestId("offer-row-1")).toBeVisible();
    await page.getByTestId("browse-chip-all").click();
    await expect(page.locator("[data-testid^='offer-row-']")).toHaveCount(2);
  });

  test("layout: one column at 375, two columns from 900px", async ({ page }) => {
    for (const [w, cols] of [[375, 1], [1280, 2]] as const) {
      await page.setViewportSize({ width: w, height: 900 });
      if (w === 375) await setup(page, [row(1), row(3)], { 1: betJson(1), 3: betJson(3) });
      await expect(page.getByTestId("offer-row-3")).toBeVisible();
      const tops = await page.locator("[data-testid^='offer-row-']").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      expect(new Set(tops).size, `${w}px`).toBe(cols === 1 ? 2 : 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  });

  for (const [w, h] of [[375, 800], [1280, 800]]) {
    test(`screenshot at ${w}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await setup(page, [row(1, { maker: HEX }), row(3)], { 1: betJson(1, { maker: HEX }), 3: betJson(3, { referee: { account: "ref.testnet", mode: "Human" }, claim: "It rains in London on Saturday" }) });
      await expect(page.getByTestId("offer-row-3")).toBeVisible();
      await page.screenshot({ path: screenPath(`browse1/browse-${w}.png`) });
    });
  }
});
