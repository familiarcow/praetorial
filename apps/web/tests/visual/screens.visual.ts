// Q1 (UIR1 §4 Q1): every screen and state of the web app at 375 and 1280 px, each one checked by tests/visual/gate.ts:
// no horizontal scroll and no raw id / base units / nep141: on screen. Promoted from spikes/uir1/shots.spec.ts (via spikes/b1/pageshots)
// and extended to the Account / Add money / Cash out / Convert screens (F3/F4/F5). Unlike the spike, a missing step FAILS: a screen the
// gate cannot reach is a regression too. Run: npx playwright test -c playwright.visual.config.ts
import { test, expect, type Page } from "@playwright/test";
import { checkScreen } from "./gate";
import { mockWorld, ready, ME, ID, BETS } from "./world";
import { DEPOSIT_ADDRESS, fundRecord, STATUS, T0 } from "../funding/fixtures";
import { TRON_ADDR } from "../funding/withdraw-mock";
import { readFileSync } from "node:fs";
import { mockSports, RECORDED_AT } from "../sportsMocks";

const dlg = (page: Page) => page.locator("dialog[open]").last();
const tid = (page: Page, id: string) => page.getByTestId(id).first();
async function fillField(page: Page, id: string, v: string) {
  const el = tid(page, id);
  const inner = el.locator("input, textarea");
  if (await inner.count()) await inner.first().fill(v); else await el.fill(v);
}
const openSummary = (page: Page, id: string) => page.locator(`[data-testid="${id}"] > summary`).first().click();
/** Where familiarcow allows raw ids/addresses: the user's own id + one-time deposit / destination addresses. */
const FUNDING_ALLOW = [ME, DEPOSIT_ADDRESS, TRON_ADDR];
/** About's opened "How to verify" names the public NEAR Intents contract and prints the resolver's code fingerprint for developers to
 * compare; neither is a person's account id (the PEOPLE RULE is about people). */
const RESOLVER_HASH: string = JSON.parse(readFileSync(new URL("../../lib/release.mainnet.json", import.meta.url), "utf8")).resolver_wasm_hash;
const ABOUT_ALLOW = ["intents.near", RESOLVER_HASH];
/** DOCS1: the Docs name the public contracts (escrow, Intents, the registry name) and print the release hashes and the verify commands
 * (lib/docsFacts.ts) for developers to compare. Exact strings only; every other raw value on a Docs page still fails the gate. */
const RELEASE_MAINNET = JSON.parse(readFileSync(new URL("../../../../release/mainnet-night/release-mainnet.json", import.meta.url), "utf8"));
/** DOCS2: the Docs are mainnet-first and name every public mainnet account (lib/mainnetAccounts.json, test-checked against the release
 * args and the Workers' config), still as exact strings only. */
const MAINNET_ACCOUNTS: string[] = Object.entries(JSON.parse(readFileSync(new URL("../../lib/mainnetAccounts.json", import.meta.url), "utf8")))
  .filter(([k]) => !k.startsWith("_")).map(([, v]) => v as string);
const DOCS_ALLOW = [...ABOUT_ALLOW, "bets.praetorial.near", "registry.praetorial.near", ...MAINNET_ACCOUNTS, RELEASE_MAINNET.escrow_wasm_sha256, "https://cloud-api.near.ai/v1/attestation/report"];
const DOCS_SCREENS: Array<[string, string]> = [["what", "/docs"], ["verification", "/docs/verification"], ["intents", "/docs/near-intents"], ["trust", "/docs/trust"], ["hackathon", "/docs/hackathon"]];
/** Create's "Full terms" and a bet page's Details are the Details familiarcow means: exact amounts allowed there (UX-37 amounts). */
const FULL_TERMS = ['[data-testid="review-full-terms"]'];

for (const w of [375, 1280]) {
  test.describe(`${w}px`, () => {
    test.use({ viewport: { width: w, height: w === 375 ? 812 : 900 } });
    const check = (page: Page, name: string, o?: Parameters<typeof checkScreen>[3]) => checkScreen(page, name, w, o);

    // ---------- Login ----------
    test("login", async ({ page }) => {
      await mockWorld(page, { signedIn: false });
      await page.goto("/");
      await expect(tid(page, "email-input")).toBeVisible();
      await check(page, "login-1-email");
      await fillField(page, "email-input", "familiarcow@");
      await tid(page, "send-code").click();
      await check(page, "login-2-email-error");
      await fillField(page, "email-input", "familiarcow@example.com");
      await tid(page, "send-code").click();
      await expect(tid(page, "otp-input")).toBeVisible();
      await check(page, "login-3-code");
      await fillField(page, "otp-input", "123456");
      await page.locator("form button[type=submit]").first().click();
      await expect(tid(page, "login-error")).toBeVisible();
      await check(page, "login-4-code-error");
    });
    test("login: deep link + send fails", async ({ page }) => {
      await mockWorld(page, { signedIn: false, privyInit: 500 });
      await page.goto("/bet/202");
      await expect(tid(page, "email-input")).toBeVisible();
      await check(page, "login-5-deeplink");
      await fillField(page, "email-input", "familiarcow@example.com");
      await tid(page, "send-code").click();
      await expect(tid(page, "login-error")).toBeVisible({ timeout: 25_000 }); // A1: the send is bounded by a 15 s timeout
      await check(page, "login-6-send-failed");
    });
    test("paused / shut down", async ({ page }) => {
      await mockWorld(page, { signedIn: false, paused: true });
      await page.goto("/");
      await expect(tid(page, "banner-paused")).toBeVisible();
      await check(page, "login-7-paused");
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await mockWorld(page, { shutdown: true });
      await page.goto("/");
      await expect(tid(page, "banner-shutdown")).toBeVisible();
      await check(page, "home-shutdown");
    });

    // ---------- GUEST1: browse as guest (read-only, no account) ----------
    test("guest: login button, Home, a bet in each phase, the 'Log in to bet' prompt", async ({ page }) => {
      await mockWorld(page, { signedIn: false });
      await page.goto("/");
      await expect(tid(page, "browse-as-guest")).toBeVisible();
      await tid(page, "browse-as-guest").click();
      await expect(tid(page, "guest-banner")).toBeVisible();
      await check(page, "guest-1-home");
      for (const id of [202, 205, 208]) {
        await page.goto(`/bet/${id}`); await ready(page);
        await expect(tid(page, "bet-chip")).toBeVisible();
        await expect(tid(page, "guest-banner")).toBeVisible();
        await check(page, `guest-2-bet-${id}`);
      }
      await page.goto("/bet/202"); await ready(page);
      await tid(page, "take-open").click();
      await expect(tid(page, "login-line")).toHaveText("Log in to bet. You will come back to this page.");
      await check(page, "guest-3-login-to-bet");
    });

    // ---------- Home ----------
    test("home", async ({ page }) => {
      await mockWorld(page);
      await page.goto("/"); await ready(page);
      await expect(tid(page, "my-bets")).toBeVisible();
      await expect(tid(page, "mybet-row-203").or(tid(page, "progress-row-203"))).toBeVisible();
      await check(page, "home-1-full");
    });
    test("home: empty, then the indexer down", async ({ page }) => {
      await mockWorld(page, { empty: true });
      await page.goto("/"); await ready(page);
      await expect(tid(page, "mybets-empty")).toBeVisible();
      await check(page, "home-2-empty");
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await mockWorld(page, { indexerDown: true });
      await page.reload(); await ready(page);
      await expect(tid(page, "mybets-error")).toBeVisible();
      await check(page, "home-3-indexer-down");
    });
    test("home: first login, pick a username", async ({ page }) => {
      await mockWorld(page, { username: null });
      await page.goto("/"); await ready(page);
      await expect(tid(page, "username-input")).toBeVisible();
      await check(page, "home-4-pick-username", { dialog: true });
    });
    test("banner: page out of date", async ({ page }) => {
      await mockWorld(page, { chain: "testnet" });
      await page.goto("/"); await ready(page);
      await expect(tid(page, "banner-out-of-date")).toBeVisible();
      await check(page, "banner-out-of-date");
    });
    test("banner: offline", async ({ page }) => {
      await mockWorld(page);
      await page.goto("/"); await ready(page);
      await page.context().setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event("offline")));
      await expect(tid(page, "banner-offline")).toBeVisible();
      await check(page, "banner-offline");
      await page.context().setOffline(false);
    });

    // ---------- Bet page, every lifecycle state ----------
    const STATES: Array<[number, string]> = [
      [201, "01-open-mine"], [202, "02-open-theirs"], [203, "03-taken"], [204, "04-awaiting-ruling"], [205, "05-ruled-challenge-window"],
      [206, "06-challenged"], [219, "07-rejudge"], [218, "08-ruled-window-closed-finalize"], [207, "09-finalized-paying"], [208, "10-settled-won"],
      [209, "11-settled-lost"], [210, "12-void-refund"], [211, "13-conceded"], [212, "14-referee-decided"], [213, "15-expired"],
      [214, "16-cancelled"], [215, "17-stuck-no-result"], [216, "18-stuck-payout"], [217, "19-im-the-referee"], [220, "20-waiting-for-referee"],
    ];
    for (const [id, name] of STATES) {
      test(`bet ${name}`, async ({ page }) => {
        await mockWorld(page);
        await page.goto(`/bet/${id}`); await ready(page);
        await expect(tid(page, "bet-chip")).toBeVisible();
        await check(page, `bet-${name}`);
      });
    }
    test("bet: More actions, Activity and Details open", async ({ page }) => {
      await mockWorld(page);
      for (const [id, name] of [[203, "taken"], [206, "challenged"], [208, "settled-won"], [216, "stuck-payout"]] as const) {
        await page.goto(`/bet/${id}`); await ready(page);
        await expect(tid(page, "bet-chip")).toBeVisible();
        if (await page.getByTestId("more-actions").count()) await openSummary(page, "more-actions");
        await openSummary(page, "bet-activity");
        await page.evaluate(() => document.querySelectorAll('[data-testid="bet-details"] details, [data-testid="bet-details"]').forEach((d) => { if (d instanceof HTMLDetailsElement) d.open = true; }));
        await check(page, `bet-open-${name}`, { details: ['[data-testid="bet-details"]'] });
      }
    });
    test("bet: not found + shut down refund", async ({ page }) => {
      await mockWorld(page);
      await page.goto("/bet/999"); await ready(page);
      await expect(tid(page, "bet-not-found")).toBeVisible();
      await check(page, "bet-21-not-found");
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await mockWorld(page, { shutdown: true });
      await page.goto("/bet/203"); await ready(page);
      await expect(tid(page, "emergency-refund-section")).toBeVisible();
      await check(page, "bet-22-shutdown-refund");
    });

    // ---------- Sheets on the bet page ----------
    test("take", async ({ page }) => {
      await mockWorld(page);
      await page.goto("/bet/202"); await ready(page);
      await tid(page, "take-open").click();
      await expect(dlg(page).getByTestId("take-confirm")).toBeVisible();
      await check(page, "sheet-take-1-confirm", { dialog: true });
      await dlg(page).getByTestId("take-confirm").click();
      await expect(dlg(page).getByTestId("flow-failure").or(dlg(page).getByTestId("take-error"))).toBeVisible({ timeout: 20_000 });
      await check(page, "sheet-take-2-failed", { dialog: true });
    });
    const SHEETS: Array<[string, number, string, string, boolean]> = [
      // name, bet, open button, what the sheet shows, behind More actions
      ["challenge", 205, "challenge-btn", "challenge-terms", false],
      ["concede", 203, "concede-btn", "concede-terms", true],
      ["referee-rule", 217, "referee-btn-YES", "referee-terms", false],
      ["cancel", 201, "cancel-bet", "cancel-confirm-box", true],
      ["request-result", 215, "request-result-btn", "request-result-terms", false],
    ];
    for (const [name, id, open, shows, more] of SHEETS) {
      test(`sheet ${name}`, async ({ page }) => {
        await mockWorld(page);
        await page.goto(`/bet/${id}`); await ready(page);
        await expect(tid(page, "bet-chip")).toBeVisible();
        if (more && !(await tid(page, open).isVisible())) await openSummary(page, "more-actions");
        await tid(page, open).click();
        await expect(dlg(page).getByTestId(shows)).toBeVisible();
        await check(page, `sheet-${name}`, { dialog: true });
      });
    }
    test("change referee", async ({ page }) => {
      await mockWorld(page);
      await page.goto("/bet/220"); await ready(page);
      await expect(tid(page, "bet-chip")).toBeVisible();
      if (!(await tid(page, "referee-change-section").isVisible())) await openSummary(page, "more-actions");
      await expect(tid(page, "referee-change-section")).toBeVisible();
      await check(page, "bet-referee-change");
    });

    // ---------- Create a bet ----------
    test("create", async ({ page }) => {
      await mockWorld(page);
      await page.goto("/new"); await ready(page);
      await expect(tid(page, "bet-type-card-nws_daily_high")).toBeVisible();
      await check(page, "create-1-bet-type", { dialog: true });
      await tid(page, "bet-type-card-nws_daily_high").click();
      await expect(tid(page, "guided-station")).toBeVisible();
      await check(page, "create-2-details-empty", { dialog: true });
      await tid(page, "guided-station").selectOption("KNYC");
      await tid(page, "guided-date").fill("2027-12-08");
      await tid(page, "guided-op").selectOption(">=");
      await tid(page, "guided-x_f").fill("72");
      await check(page, "create-3-details-filled", { dialog: true });
      await tid(page, "fill-next").click();
      await expect(tid(page, "step-resolver")).toBeVisible();
      await check(page, "create-4-stake-who", { dialog: true });
      await fillField(page, "maker-amount", "25");
      await tid(page, "review-offer").click();
      await expect(tid(page, "review-card")).toBeVisible();
      await expect(tid(page, "source-check-status")).toBeVisible();
      await check(page, "create-5-review", { dialog: true });
      await openSummary(page, "review-full-terms").catch(() => undefined);
      await check(page, "create-6-review-full-terms", { dialog: true, details: FULL_TERMS });
      await tid(page, "modal-close").click();
      await expect(tid(page, "discard-confirm")).toBeVisible();
      await check(page, "create-7-discard-confirm", { dialog: true, details: FULL_TERMS });
    });

    // ---------- TPL2: Who wins a game (the game picker, on the recorded 2026-11-12 schedules) ----------
    test("create: game picker", async ({ page }) => {
      await page.clock.install({ time: new Date(RECORDED_AT) });
      await mockWorld(page);
      await mockSports(page);
      await page.goto("/new"); await ready(page);
      await tid(page, "bet-type-card-game_winner").click();
      await tid(page, "guided-league").selectOption("NHL");
      await expect(page.locator('[data-testid^="game-card-"]')).toHaveCount(11);
      await check(page, "create-game-1-list", { dialog: true });
      await tid(page, "game-card-2026020309").click();
      await expect(tid(page, "game-team-step")).toBeVisible();
      await check(page, "create-game-2-team", { dialog: true });
      await tid(page, "game-team-home").click();
      await expect(tid(page, "game-picked")).toBeVisible();
      await check(page, "create-game-3-picked", { dialog: true });
      await openSummary(page, "game-details");
      await check(page, "create-game-4-details", { dialog: true });
      await tid(page, "game-change").click();
      await fillField(page, "game-search", "Kraken");
      // COPY1 SR-C3: search covers today and tomorrow only, so Saturday's Kraken game is not listed
      await expect(page.locator('[data-testid="game-search-results"] [data-testid^="game-card-"]')).toHaveCount(1);
      await check(page, "create-game-5-search", { dialog: true });
    });
    test("create: game picker, started game + schedule unavailable", async ({ page }) => {
      await page.clock.install({ time: new Date("2026-11-12T17:05:00Z") });
      await mockWorld(page);
      await mockSports(page, { nhlFailures: 1 });
      await page.goto("/new"); await ready(page);
      await tid(page, "bet-type-card-game_winner").click();
      await tid(page, "guided-league").selectOption("NHL");
      await expect(tid(page, "game-error")).toBeVisible();
      await check(page, "create-game-6-unavailable", { dialog: true });
      await tid(page, "game-retry").click();
      await expect(tid(page, "game-closed-2026020309")).toBeVisible();
      await check(page, "create-game-7-started", { dialog: true });
      // COPY1 SR-C3: only today and tomorrow are offered; nothing is recorded for NFL tomorrow, so that is the empty day
      await tid(page, "guided-league").selectOption("NFL");
      await tid(page, "game-day-2026-11-13").click();
      await expect(tid(page, "game-empty")).toBeVisible();
      await check(page, "create-game-8-no-games", { dialog: true });
    });

    // ---------- Docs (DOCS1: replaced About), not found ----------
    // Every Docs page, logged out (public) and logged in, then with every section opened. The Docs name the public contracts and print
    // the release hashes and verify commands for developers to compare (DOCS_ALLOW); no person's account id is on them.
    for (const [id, path] of DOCS_SCREENS) {
      test(`docs ${id}`, async ({ page }) => {
        await mockWorld(page, { signedIn: false });
        await page.goto(path); await ready(page);
        await expect(tid(page, `docs-${id}`)).toBeVisible();
        await expect(tid(page, "login-gate")).toHaveCount(0);
        await check(page, `docs-${id}-1-public`, { allow: DOCS_ALLOW });
        await page.evaluate(() => document.querySelectorAll('[data-testid="docs-page"] details').forEach((d) => ((d as HTMLDetailsElement).open = true)));
        await check(page, `docs-${id}-2-all-open`, { allow: DOCS_ALLOW });
        await page.unrouteAll({ behavior: "ignoreErrors" });
        await mockWorld(page);
        await page.goto(path); await ready(page);
        await expect(tid(page, "nav-docs")).toHaveAttribute("aria-current", "page");
        await check(page, `docs-${id}-3-signed-in`, { allow: DOCS_ALLOW });
      });
    }
    test("not found page", async ({ page }) => {
      await mockWorld(page);
      await page.goto("/nope"); await ready(page);
      await expect(tid(page, "not-found")).toBeVisible();
      await check(page, "notfound");
    });

    // ---------- Account ----------
    test("account", async ({ page }) => {
      await mockWorld(page);
      await page.goto("/account"); await ready(page);
      await expect(tid(page, "account-total-usd")).toBeVisible();
      await check(page, "account-1-full");
      await openSummary(page, "account-details");
      await expect(tid(page, "wallet-account-id")).toHaveText(ME);
      await check(page, "account-2-details-open", { allow: [ME] });
    });
    test("account: token sheet + convert a stray token", async ({ page }) => {
      await mockWorld(page);
      await page.goto("/account"); await ready(page);
      await tid(page, "account-total-usd").waitFor();
      await tid(page, "asset-row-USDC").click();
      await expect(dlg(page)).toBeVisible();
      await check(page, "account-3-token-sheet", { dialog: true });
      await page.keyboard.press("Escape");
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      const row = page.locator(`[data-testid=stray-row][data-asset="${ID.ETH_USDC}"]`);
      await row.getByTestId("stray-convert").click();
      await expect(tid(page, "convert-sheet").getByTestId("cv-you-get")).toBeVisible();
      await check(page, "account-4-convert", { dialog: true });
    });
    test("account: empty, then balances down", async ({ page }) => {
      // AFIX1: a truly empty account has no bets either. This world used to keep the user's open/taken bets (stakes locked) and
      // only showed the hero because the page didn't wait for the bet list -- the false "Add money" familiarcow-class bug.
      await mockWorld(page, { intents: {}, nearAccountEmpty: true, empty: true });
      await page.goto("/account"); await ready(page);
      await expect(tid(page, "account-empty")).toBeVisible();
      // ACCT2: under the hero, all 6 bet tokens at 0 (mainnet), the same rows as a funded account.
      await expect(tid(page, "balances").locator("[data-testid^=asset-card-]")).toHaveCount(6);
      for (const s of ["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"]) await expect(tid(page, `balance-row-${s}`)).toHaveText(new RegExp(`^0(\\.0+)? ${s}$`));
      await check(page, "account-5-empty");
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await mockWorld(page, { balanceDown: true });
      await page.reload(); await ready(page);
      await expect(tid(page, "balance-error")).toBeVisible();
      await check(page, "account-6-balance-error");
    });

    // ---------- Add money ----------
    test("add money: token, amount, one-time address, tracker", async ({ page }) => {
      await page.clock.install({ time: T0 }); // the fixture quote's one-time address expires at T0 + 60 min
      await mockWorld(page);
      await page.goto("/account"); await ready(page);
      // TFIX2: since AFIX1 the button waits for every source incl. all 18 world bets; at the app's RPC pace (~3 req/s) that is ~9 s,
      // past the 8 s action timeout. Wait for the loaded page (same assertion, honest time), then press it.
      await expect(tid(page, "account-add-money")).toBeVisible({ timeout: 30_000 });
      await tid(page, "account-add-money").click();
      const sheet = tid(page, "add-money-sheet");
      await expect(sheet.getByTestId("fund-popular")).toBeVisible();
      await check(page, "addmoney-1-token", { dialog: true, allow: FUNDING_ALLOW });
      await sheet.getByTestId("fund-search").fill("trc20");
      await sheet.getByTestId("fund-token-USDT-tron").click();
      await sheet.getByTestId("fund-betwith-USDC").click();
      await sheet.getByTestId("fund-amount").fill("20");
      await expect(sheet.getByTestId("fund-you-get")).toBeVisible();
      await check(page, "addmoney-2-amount", { dialog: true, allow: FUNDING_ALLOW });
      await sheet.getByTestId("fund-get-address").click();
      await expect(sheet.getByTestId("fund-address")).toHaveText(DEPOSIT_ADDRESS);
      await check(page, "addmoney-3-address", { dialog: true, allow: FUNDING_ALLOW });
      await expect(sheet.getByTestId("fund-track-message")).toBeVisible({ timeout: 20_000 });
      await check(page, "addmoney-4-tracker", { dialog: true, allow: FUNDING_ALLOW });
    });
    test("add money: one path, no near.com tab (ACCT2)", async ({ page }) => {
      await mockWorld(page);
      await page.goto("/account"); await ready(page);
      // TFIX2: since AFIX1 the button waits for every source incl. all 18 world bets; at the app's RPC pace (~3 req/s) that is ~9 s,
      // past the 8 s action timeout. Wait for the loaded page (same assertion, honest time), then press it.
      await expect(tid(page, "account-add-money")).toBeVisible({ timeout: 30_000 });
      await tid(page, "account-add-money").click();
      await expect(tid(page, "add-money-sheet").getByTestId("fund-picker")).toBeVisible();
      await expect(tid(page, "add-money-sheet").getByRole("tablist")).toHaveCount(0);
      await expect(tid(page, "add-money-sheet")).not.toContainText(/near\.com|confidential/i);
      await check(page, "addmoney-5-no-nearcom", { dialog: true, allow: FUNDING_ALLOW });
    });
    for (const [state, statuses] of [["converting", [STATUS.converting]], ["credited", [STATUS.credited]], ["refunded", [STATUS.refunded]]] as const) {
      test(`add money: a deposit ${state} (strip + sheet)`, async ({ page }) => {
        const rec = fundRecord({ account: ME, createdAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000, deadline: new Date(Date.now() + 50 * 60_000).toISOString() });
        await mockWorld(page, { local: [rec], worker: { after: [...statuses] } });
        await page.route("**/fund/status**", (r) => r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(statuses[0]) }));
        await page.goto("/account"); await ready(page);
        await expect(tid(page, "fund-strip").or(tid(page, "inflight-card"))).toBeVisible({ timeout: 15_000 });
        await check(page, `addmoney-6-${state}`, { allow: FUNDING_ALLOW });
      });
    }

    // ---------- Cash out ----------
    test("cash out: pick, amount, send as, address, review", async ({ page }) => {
      await mockWorld(page);
      await page.goto("/account"); await ready(page);
      // TFIX2: since AFIX1 the button waits for every source incl. all 18 world bets; at the app's RPC pace (~3 req/s) that is ~9 s,
      // past the 8 s action timeout. Wait for the loaded page (same assertion, honest time), then press it.
      await expect(tid(page, "account-cash-out")).toBeVisible({ timeout: 30_000 });
      await tid(page, "account-cash-out").click();
      const sheet = tid(page, "cash-out-sheet");
      await expect(sheet.getByTestId("co-pick")).toBeVisible();
      await check(page, "cashout-1-pick", { dialog: true, allow: FUNDING_ALLOW });
      await sheet.locator(`[data-testid=co-holding][data-asset="${ID.USDC}"]`).click();
      await sheet.getByTestId("co-amount").fill("20");
      await check(page, "cashout-2-amount", { dialog: true, allow: FUNDING_ALLOW });
      await sheet.getByTestId("co-amount-next").click();
      await expect(sheet.getByTestId("co-sendas")).toBeVisible();
      await check(page, "cashout-3-send-as", { dialog: true, allow: FUNDING_ALLOW });
      await sheet.getByTestId("co-sendas-search").fill("trc20");
      await sheet.getByTestId("co-sendas-USDT-tron").click();
      await expect(sheet.getByTestId("co-address-input")).toBeVisible();
      await check(page, "cashout-4-address", { dialog: true, allow: FUNDING_ALLOW });
      await sheet.getByTestId("co-address-input").fill(TRON_ADDR);
      await sheet.getByTestId("co-address-next").click();
      await expect(sheet.getByTestId("co-review-receive")).toBeVisible();
      await check(page, "cashout-5-review", { dialog: true, allow: FUNDING_ALLOW });
    });
  });
}

void BETS;
