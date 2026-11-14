// TPL2: the game picker in the create flow, on RECORDED schedules (tests/sportsMocks.ts; tests/fixtures/sports, recorded 2026-11-12)
// with the browser clock fixed at the recording time. Fully mocked (NEAR RPC + ticker + 1Click + the three schedule sources).
// One @live test (opt-in: `npm run test:e2e:live -- -g TPL2`) hits the real ESPN / NHL (through the dev proxy) / MLB endpoints.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { mockSports, asPregame, RECORDED_AT } from "./sportsMocks";

const WALLET = "11".repeat(32);
const SIG = "22".repeat(64);
const RPC = "https://test.rpc.fastnear.com";

async function setup(page: Page, at: string | null = RECORDED_AT, sports: Parameters<typeof mockSports>[1] | null = {}) {
  if (at) await page.clock.install({ time: new Date(at) });
  // registry off (what e2eGuard does for mocked specs; the @live run skips the guard), so /new is reachable without a username service
  await page.addInitScript(({ address, sig }) => { (window as any).__e2eRegistryUrl = ""; (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => sig }; }, { address: WALLET, sig: SIG });
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      const name = params.method_name;
      const r = name === "is_paused" || name === "is_shutdown" ? false : name === "open_offers" ? [] : name === "asset_limit" ? { storage_per_kib: "1" } : null;
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  await page.route("**/ticker**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ venue: "x", price: 100000 }) }));
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  if (sports) await mockSports(page, sports);
  await page.goto("/new");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
  await page.getByTestId("bet-type-card-game_winner").click();
  await expect(page.getByTestId("game-picker")).toBeVisible();
}
const card = (page: Page, eventId: string) => page.getByTestId(`game-card-${eventId}`);
const visibleText = (page: Page) => page.getByTestId("fill-step").evaluate((el) => (el as HTMLElement).innerText);

test.describe("TPL2 game picker", () => {
  test("NHL today: cards read 'Hurricanes @ Kraken · 12:00 pm ET'; tap the game, tap the Kraken: the form is filled and no id is on screen", async ({ page }) => {
    await setup(page);
    await page.getByTestId("guided-league").selectOption("NHL");
    await expect(page.getByTestId("game-day-2026-11-12")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("game-day-2026-11-12")).toContainText("Today");
    await expect(page.locator('[data-testid^="game-card-"]')).toHaveCount(11);
    await expect(card(page, "2026020309")).toContainText("Hurricanes @ Kraken · 12:00 pm ET");
    await expect(page.getByTestId("game-list")).toContainText("Canadiens @ Bruins · 7:00 pm ET");
    await expect(page.getByTestId("fill-step")).toContainText("Betting closes at face-off");
    expect(await visibleText(page)).not.toMatch(/\d{5,}/); // no game id / team id anywhere a person reads
    await expect(page.getByTestId("fill-next")).toBeDisabled();
    await expect(page.getByTestId("fill-error")).toHaveCount(0); // browsing is not an error

    await card(page, "2026020309").click();
    await expect(page.getByTestId("game-team-step")).toContainText("Who do you back?");
    await expect(page.getByTestId("game-team-away")).toHaveText("Carolina Hurricanes");
    await page.getByTestId("game-team-home").click();
    await expect(page.getByTestId("game-picked-team")).toHaveText("Seattle Kraken");
    await expect(page.getByTestId("game-picked-game")).toContainText("Hurricanes @ Kraken · 12:00 pm ET · Today");
    await expect(page.getByTestId("fill-sentence")).toContainText("You are betting that Seattle Kraken beat Carolina Hurricanes in the NHL game on 2026-11-12.");
    expect(await visibleText(page)).not.toMatch(/\d{5,}/);
    await expect(page.getByTestId("fill-next")).toBeEnabled();

    // the ids live under Details only
    await expect(page.getByTestId("guided-event_id")).toBeHidden();
    await page.getByTestId("game-details").locator("summary").click();
    await expect(page.getByTestId("guided-event_id").locator("input").or(page.locator('input[data-testid="guided-event_id"]')).first()).toHaveValue("2026020309");
    await expect(page.locator('[data-testid="guided-pick_team_id"] input, input[data-testid="guided-pick_team_id"]').first()).toHaveValue("55");
    await expect(page.locator('[data-testid="guided-scheduled_date"] input, input[data-testid="guided-scheduled_date"]').first()).toHaveValue("2026-11-12");

    await page.getByTestId("fill-next").click();
    await expect(page.getByTestId("step-resolver")).toBeVisible();
    await page.getByTestId("maker-amount").fill("10");
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("review-card")).toBeVisible();
    await expect(page.getByTestId("review-card")).toContainText("Seattle Kraken");
  });

  test("a game that has started (or starts in under 30 min) cannot be picked, and says why: betting closes at face-off", async ({ page }) => {
    await setup(page, "2026-11-12T17:05:00Z");
    await page.getByTestId("guided-league").selectOption("NHL");
    await expect(card(page, "2026020309")).toHaveAttribute("data-pickable", "false");
    await expect(page.getByTestId("game-closed-2026020309")).toContainText("already started. Betting closes at face-off.");
    await card(page, "2026020309").click();
    await expect(page.getByTestId("game-team-step")).toHaveCount(0);
    await expect(card(page, "2026020299")).toHaveAttribute("data-pickable", "true"); // 7 pm game still open
  });

  test("days: today and tomorrow are browsable (COPY1 SR-C3); tomorrow lists its games; an empty day says so in plain words", async ({ page }) => {
    await setup(page);
    await page.getByTestId("guided-league").selectOption("NHL");
    await expect(page.locator('[data-testid^="game-day-"]')).toHaveCount(2);
    await page.getByTestId("game-day-2026-11-13").click();
    await expect(page.locator('[data-testid^="game-card-"]')).toHaveCount(2);
    await expect(page.getByTestId("game-list")).toContainText("Rangers @ Canucks");
    await page.getByTestId("guided-league").selectOption("NFL");
    await page.getByTestId("game-day-2026-11-13").click(); // nothing recorded for that day: an empty schedule
    await expect(page.getByTestId("game-empty")).toHaveText("No NFL games tomorrow. Try another day.");
  });

  test("schedule unavailable: a plain error with Try again; the retry loads the games", async ({ page }) => {
    await setup(page, RECORDED_AT, { nhlFailures: 1 });
    await page.getByTestId("guided-league").selectOption("NHL");
    await expect(page.getByTestId("game-error")).toContainText("We couldn't load the NHL schedule right now. Check your connection and try again.");
    await page.getByTestId("game-retry").click();
    await expect(page.locator('[data-testid^="game-card-"]')).toHaveCount(11);
    await expect(page.getByTestId("game-error")).toHaveCount(0);
  });

  test("COPY1 SR-C3: only today and tomorrow are offered, with the 44-hour reason; search 'Kraken' finds today's game, not Saturday's", async ({ page }) => {
    await setup(page);
    await page.getByTestId("guided-league").selectOption("NHL");
    await expect(page.locator('[data-testid^="game-card-"]')).toHaveCount(11);
    await expect(page.locator('[data-testid^="game-day-"]')).toHaveCount(2);
    await expect(page.getByTestId("game-day-2026-11-13")).toContainText("Tomorrow");
    await expect(page.getByTestId("game-day-2026-11-14")).toHaveCount(0);
    await expect(page.getByTestId("game-near-term")).toHaveText("For now only games starting within 44 hours (today and tomorrow) can be picked, so the judge can rule on time.");
    const box = page.locator('[data-testid="game-search"] input, input[data-testid="game-search"]').first();
    await box.fill("Kraken");
    const res = page.getByTestId("game-search-results");
    await expect(res.locator('[data-testid^="game-card-"]')).toHaveCount(1);
    await expect(res).toContainText("Today");
    await expect(res).not.toContainText("Sat, Nov 14");
    await res.locator('[data-testid^="game-card-"]').first().click();
    await page.getByTestId("game-team-home").click();
    await expect(page.getByTestId("game-picked-team")).toHaveText("Seattle Kraken");
    await expect(page.getByTestId("game-picked-game")).toContainText("Today");
  });

  test("NBA uses ESPN's ids (the only source); Change game clears the pick", async ({ page }) => {
    await setup(page);
    await page.getByTestId("guided-league").selectOption("NBA");
    await expect(card(page, "401909976")).toContainText("Raptors @ 76ers · 7:00 pm ET");
    await card(page, "401909976").click();
    await page.getByTestId("game-team-away").click();
    await page.getByTestId("game-details").locator("summary").click();
    await expect(page.locator('[data-testid="guided-event_id"] input, input[data-testid="guided-event_id"]').first()).toHaveValue("401909976");
    await expect(page.locator('[data-testid="guided-pick_team_id"] input, input[data-testid="guided-pick_team_id"]').first()).toHaveValue("28");
    await page.getByTestId("game-change").click();
    await expect(page.getByTestId("game-list")).toBeVisible();
    await expect(page.getByTestId("fill-next")).toBeDisabled();
  });

  test("MLB doubleheader shows Game 1 / Game 2 and each fills its own gamePk (synthetic pre-game copy of the recorded 2026-04-04 games)", async ({ page }) => {
    await setup(page, "2026-04-03T15:00:00Z", { transform: (k, _d, b) => asPregame(k, b) });
    await page.getByTestId("guided-league").selectOption("MLB");
    await page.getByTestId("game-day-2026-04-04").click();
    await expect(card(page, "824132")).toContainText("Brewers @ Royals");
    await expect(card(page, "824132")).toContainText("Game 1");
    await expect(card(page, "824134")).toContainText("Game 2");
    await card(page, "824134").click();
    await page.getByTestId("game-team-away").click();
    await expect(page.getByTestId("game-picked-game")).toContainText("Game 2");
    await page.getByTestId("game-details").locator("summary").click();
    await expect(page.locator('[data-testid="guided-event_id"] input, input[data-testid="guided-event_id"]').first()).toHaveValue("824134");
    await expect(page.locator('[data-testid="guided-pick_team_id"] input, input[data-testid="guided-pick_team_id"]').first()).toHaveValue("158");
    await expect(page.getByTestId("fill-next")).toBeEnabled();
  });

  test("MLB off-season day (recorded 2026-11-12): 'No MLB games today'", async ({ page }) => {
    await setup(page);
    await page.getByTestId("guided-league").selectOption("MLB");
    await expect(page.getByTestId("game-empty")).toHaveText("No MLB games today. Try another day.");
  });
});

// Opt-in: PW_LIVE=1 (npm run test:e2e:live -- -g TPL2). Real ESPN + NHL (through the dev server's /_proxy/sports) + MLB statsapi.
// ESPN's CDN answers 403 (no CORS header) when the user agent or the sec-ch-ua client hint says "HeadlessChrome"; a person's browser
// gets 200 + CORS (checked 2026-11-12), so the live run presents a normal Chrome user agent and client hint.
test.describe("TPL2 live", () => {
  test.use({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    extraHTTPHeaders: { "sec-ch-ua": '"Chromium";v="140", "Google Chrome";v="140"' },
  });
  test("the real schedules load for every league today (cards or 'no games', never the error) @live", async ({ page }) => {
    await setup(page, null, null);
    for (const l of ["NHL", "NBA", "NFL", "MLB"]) {
      await page.getByTestId("guided-league").selectOption(l);
      await expect(page.locator('[data-testid^="game-card-"]').first().or(page.getByTestId("game-empty"))).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("game-error")).toHaveCount(0);
    }
  });
});
