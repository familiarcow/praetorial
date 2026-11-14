// FE3 (S2/S3): card picker -> fill-in step -> resolver step. Fully mocked (NEAR RPC + ticker + 1Click via page.route, wallet via the
// window.__e2eTestWallet seam); never a real Privy login.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { fillDeadlineUtc, openMoreOptions } from "./betDetailsHelpers";
import { utcToLocalInput } from "../lib/betDetails";
import { mockSports } from "./sportsMocks";
import { openBetType } from "./betTypeNav";

const WALLET = "11".repeat(32);
const SIG = "22".repeat(64);
const RPC = "https://test.rpc.fastnear.com";

async function setup(page: Page) {
  await page.addInitScript(({ address, sig }) => { (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => sig }; }, { address: WALLET, sig: SIG });
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
  await mockSports(page); // TPL2: choosing a league loads that day's games (recorded schedules)
  await page.goto("/new");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
  await expect(page.getByTestId("create-offer-form")).toBeVisible();
}
const card = (page: Page, id: string) => page.getByTestId(`bet-type-card-${id}`);

async function fillType(page: Page, id: string) {
  switch (id) {
    case "btc_close_at_t":
      await page.getByTestId("guided-t_utc").fill("2027-12-01T15:00");
      await page.getByTestId("guided-op").selectOption(">=");
      await page.getByTestId("guided-x_usd").fill("75900"); break;
    case "btc_touch":
      await page.getByTestId("guided-direction").selectOption("at_or_above");
      await page.getByTestId("guided-x_usd").fill("76000");
      await page.getByTestId("guided-deadline_utc").fill("2027-12-07T12:00"); break;
    case "game_winner":
      await page.getByTestId("guided-league").selectOption("MLB");
      await page.getByTestId("game-details").locator("summary").click(); // TPL2: typing the ids by hand lives under Details
      await page.getByTestId("guided-event_id").fill("849799");
      await page.getByTestId("guided-scheduled_date").fill("2027-12-28");
      await page.getByTestId("guided-pick_team_id").fill("158");
      await page.getByTestId("guided-pick_name").fill("Milwaukee Brewers"); break;
    case "nws_daily_high":
      await page.getByTestId("guided-station").selectOption("KNYC");
      await page.getByTestId("guided-date").fill("2027-12-08");
      await page.getByTestId("guided-op").selectOption(">=");
      await page.getByTestId("guided-x_f").fill("72"); break;
    case "custom": // BET1a: claim + deadline + two links is a complete bet; everything else has a default
      await fillCustomBase(page);
      await page.getByTestId("cb-source-url-0").fill("https://www.apple.com/newsroom/");
      await page.getByTestId("cb-source-url-1").fill("https://www.reuters.com/"); break;
  }
}
async function fillCustomBase(page: Page) {
  await page.getByTestId("cb-claim").fill("Apple makes a foldable iPhone available to buy in the US during 2027.");
  await fillDeadlineUtc(page, "2027-12-31T23:59");
}

test.describe("FE3 bet-type picker (S2) and fill-in step (S3)", () => {
  test("S2 shows four tiles (Asset prices, game, weather, any page) with plain titles and an example; the dev presets are gone", async ({ page }) => {
    await setup(page);
    await expect(page.getByTestId("bet-type-picker")).toBeVisible();
    // TPL1 (PM 14:05, familiarcow): the price types sit under ONE "Asset prices" tile
    await expect(page.locator('[data-testid^="bet-type-card-"]')).toHaveCount(4);
    await expect(card(page, "prices")).toContainText("Asset prices");
    await expect(card(page, "prices")).toContainText("Bitcoin, Ethereum, Zcash or any listed coin");
    for (const id of ["btc_close_at_t", "btc_touch", "outperform"]) await expect(card(page, id)).toHaveCount(0);
    await expect(card(page, "game_winner")).toContainText("Who wins a game");
    await expect(card(page, "nws_daily_high")).toContainText("Daily high temperature");
    await expect(card(page, "custom")).toContainText("Anything else");
    await expect(card(page, "custom")).toContainText("Name any page. The AI reads it and decides.");
    for (const id of ["jason-preset", "custom-claim", "btc-venue-template", "claim-text", "template-select", "custom-builder-on"]) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.getByTestId("fill-step")).toHaveCount(0);
    await expect(page.getByTestId("step-resolver")).toHaveCount(0);
  });

  test("Asset prices opens the three price types in plain words; Back returns to the four tiles", async ({ page }) => {
    await setup(page);
    await card(page, "prices").click();
    await expect(page.getByTestId("bet-type-prices")).toBeVisible();
    await expect(page.getByTestId("bet-type-picker")).toHaveCount(0);
    await expect(page.locator('[data-testid^="bet-type-card-"]')).toHaveCount(3);
    await expect(card(page, "btc_close_at_t")).toContainText("Price at a set time");
    await expect(card(page, "btc_touch")).toContainText("Hits a price");
    await expect(card(page, "outperform")).toContainText("Which outperforms?");
    await page.getByTestId("bet-type-prices-back").click();
    await expect(page.getByTestId("bet-type-picker")).toBeVisible();
    await expect(page.locator('[data-testid^="bet-type-card-"]')).toHaveCount(4);
  });

  test("Back from a price form returns to the price sub-choice and keeps the draft", async ({ page }) => {
    await setup(page);
    await openBetType(page, "btc_touch");
    await fillType(page, "btc_touch");
    await page.getByTestId("fill-back").click();
    await expect(page.getByTestId("bet-type-prices")).toBeVisible();
    await card(page, "btc_touch").click();
    await expect(page.getByTestId("guided-x_usd")).toHaveValue("76000");
    await page.getByTestId("fill-back").click();
    await page.getByTestId("bet-type-prices-back").click();
    await expect(page.getByTestId("bet-type-picker")).toBeVisible();
  });

  for (const id of ["btc_close_at_t", "btc_touch", "game_winner", "nws_daily_high", "custom"]) {
    test(`type ${id}: valid input unlocks Next and reaches the resolver step, then the review card`, async ({ page }) => {
      await setup(page);
      await openBetType(page, id);
      await expect(page.getByTestId("fill-step")).toBeVisible();
      await expect(page.getByTestId("fill-next")).toBeDisabled();
      await fillType(page, id);
      await expect(page.getByTestId("fill-error")).toHaveCount(0);
      await expect(page.getByTestId("fill-next")).toBeEnabled();
      await expect(page.getByTestId("fill-sentence")).toContainText("You are betting that");
      await expect(page.getByTestId("fill-sentence")).toContainText("The other person bets it won't happen.");
      await page.getByTestId("fill-next").click();
      await expect(page.getByTestId("step-resolver")).toBeVisible();
      await expect(page.getByTestId("decider-ai")).toBeChecked();
      await expect(page.getByTestId("fill-step")).toHaveCount(0);
      await page.getByTestId("maker-amount").fill("10");
      await page.getByTestId("review-offer").click();
      await expect(page.getByTestId("review-card")).toBeVisible();
      await expect(page.getByTestId("review-flags")).toHaveCount(0); // C1: no "ready" debug word; no blocking problem shown
    });
  }

  test("a lint failure blocks Next and shows the existing message next to the form", async ({ page }) => {
    await setup(page);
    await openBetType(page, "btc_close_at_t");
    await page.getByTestId("guided-t_utc").fill("2027-12-01T15:00");
    await page.getByTestId("guided-op").selectOption(">=");
    await page.getByTestId("guided-x_usd").fill("75900.5");
    await page.getByTestId("guided-x_usd").blur(); // FE3b Q2: problems show after a field is left
    await expect(page.getByTestId("fill-error")).toContainText("Enter the price as a whole number of dollars"); // FE3b Q1: plain sentence; the code sits under Details
    await expect(page.getByTestId("fill-error")).toContainText("TPL_X_USD_NOT_WHOLE");
    await expect(page.getByTestId("fill-next")).toBeDisabled();
    await page.getByTestId("guided-x_usd").fill("75900");
    await expect(page.getByTestId("fill-error")).toHaveCount(0);
    await expect(page.getByTestId("fill-next")).toBeEnabled();
  });

  test("custom: a vague date in the claim blocks Next with the lint message; fixing it unblocks", async ({ page }) => {
    await setup(page);
    await card(page, "custom").click();
    await fillType(page, "custom");
    await page.getByTestId("cb-claim").fill("Apple ships a foldable iPhone next week.");
    await page.getByTestId("cb-claim").blur(); // FE3b Q2
    await expect(page.getByTestId("fill-error")).toContainText("Use an exact date"); // FE3b Q1
    await expect(page.getByTestId("fill-error")).toContainText("CUSTOM_RELATIVE_DATE");
    await expect(page.getByTestId("fill-next")).toBeDisabled();
    await page.getByTestId("cb-claim").fill("Apple makes a foldable iPhone available to buy in the US during 2027.");
    await expect(page.getByTestId("fill-next")).toBeEnabled();
  });

  test("SRCREF1c human-mode variant: a person deciding (set once, on Who decides) still needs 2 sources; only the evidence cutoff is hidden", async ({ page }) => {
    await setup(page);
    await card(page, "custom").click();
    await expect(page.getByTestId("fill-human-toggle")).toHaveCount(0); // BET1a: asked once, on the Who-decides step
    await fillType(page, "custom");
    await page.getByTestId("fill-next").click();
    await page.getByTestId("decider-person").check();
    await page.getByTestId("resolver-back").click();
    await expect(page.getByTestId("human-sources-why")).toContainText("A person decides, but the contract still needs sources it can check");
    await openMoreOptions(page);
    await expect(page.getByTestId("cb-sources")).toBeVisible();
    await expect(page.getByTestId("cb-fallback")).toBeVisible();
    await expect(page.getByTestId("cb-evidenceCutoff")).toHaveCount(0);
    await page.getByTestId("cb-source-url-1").fill("");
    await expect(page.getByTestId("fill-next")).toBeDisabled(); // blocked until 2 sources
    await page.getByTestId("fill-next").click({ force: true }); // aria-disabled: Next is tried, the reason shows
    await expect(page.getByTestId("fill-error")).toContainText("at least two sources");
    await page.getByTestId("cb-source-url-1").fill("https://www.reuters.com/");
    await expect(page.getByTestId("fill-next")).toBeEnabled();
    await page.getByTestId("fill-next").click();
    await expect(page.getByTestId("decider-person")).toBeChecked();
    await page.getByTestId("decider-ai").check();
    await page.getByTestId("resolver-back").click();
    await openMoreOptions(page);
    await expect(page.getByTestId("cb-evidenceCutoff")).toBeVisible();
    await expect(page.getByTestId("human-sources-why")).toHaveCount(0);
    await expect(page.getByTestId("fill-next")).toBeEnabled(); // BET1a: AI mode defaults the evidence cutoff to deadline + 7 days
  });

  test("BET1a Details: only claim, deadline (local time) and two links show; More options is collapsed with a summary", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await setup(page);
    await card(page, "custom").click();
    for (const id of ["cb-claim", "cb-deadline", "cb-source-url-0", "cb-source-url-1", "details-more-toggle", "details-more-summary"]) await expect(page.getByTestId(id)).toBeVisible();
    for (const id of ["details-more", "cb-element-0", "cb-source-publisher-0", "cb-windowStart", "cb-evidenceCutoff", "cb-fallback", "cb-early", "cb-leading", "cb-add-note", "cb-windowEnd"]) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.getByTestId("details-more-toggle")).toHaveAttribute("aria-expanded", "false");
    await page.getByTestId("cb-deadline").fill(utcToLocalInput("2027-12-31T23:59"));
    await expect(page.getByTestId("cb-deadline-utc")).toContainText("2027-12-31 23:59 UTC");
    await page.getByTestId("cb-claim").fill("Apple makes a foldable iPhone available to buy in the US during 2027.");
    await openMoreOptions(page);
    await expect(page.getByTestId("cb-element-0")).toHaveAttribute("placeholder", "Is this true: Apple makes a foldable iPhone available to buy in the US during 2027?");
    await expect(page.getByTestId("cb-windowStart")).not.toHaveValue(""); // stamped to now when the deadline was set
    // nothing in the Details step runs past a 375px screen (the site nav is measured elsewhere)
    const right = await page.evaluate(() => Math.max(...Array.from(document.querySelectorAll('[data-testid="fill-step"] *')).map((e) => e.getBoundingClientRect().right)));
    expect(right).toBeLessThanOrEqual(375);
  });

  test("BET1a: a lint problem in a More-options field opens More options and highlights + focuses that field", async ({ page }) => {
    await setup(page);
    await card(page, "custom").click();
    await fillType(page, "custom");
    await openMoreOptions(page);
    await page.getByTestId("cb-fallback").fill("");
    await page.getByTestId("details-more-toggle").click(); // collapse again
    await expect(page.getByTestId("details-more")).toHaveCount(0);
    await page.getByTestId("fill-next").click({ force: true });
    await expect(page.getByTestId("fill-error")).toBeVisible();
    await expect(page.getByTestId("details-more")).toBeVisible();
    await expect(page.locator('[data-field="fallbackRule"]')).toHaveAttribute("data-flagged", "true");
    await expect(page.getByTestId("cb-fallback")).toBeFocused();
    await page.getByTestId("cb-fallback").fill("Fallback: if a named source is unavailable, any other listed source may confirm.");
    await expect(page.getByTestId("fill-next")).toBeEnabled();
  });

  test("MAINFIX: clicking More options straight from a claim the lint flags under More options opens it (the blur's auto-open is not undone by the click)", async ({ page }) => {
    await setup(page);
    await card(page, "custom").click();
    // > 300 chars: the default judge question (element 0, a More-options field) is too long, so leaving the claim auto-opens More options.
    await page.getByTestId("cb-claim").fill(`Apple makes a foldable iPhone available to buy in the US during 2027. ${"It must be sold by Apple itself, not a reseller. ".repeat(6)}`);
    await expect(page.getByTestId("cb-claim")).toBeFocused();
    await expect(page.getByTestId("details-more-toggle")).toHaveAttribute("aria-expanded", "false");
    await page.getByTestId("details-more-toggle").click(); // the user meant "open"; the same press blurs the claim
    await expect(page.getByTestId("details-more")).toBeVisible();
    await expect(page.getByTestId("details-more-toggle")).toHaveAttribute("aria-expanded", "true");
    await page.getByTestId("details-more-toggle").click(); // and a plain second click still collapses it
    await expect(page.getByTestId("details-more")).toHaveCount(0);
  });

  test("MAINFIX2: leaving a claim the lint flags under More options opens More options in the SAME frame (no stale 'More options' label to press)", async ({ page }) => {
    await setup(page);
    await card(page, "custom").click();
    // Every DOM commit is snapshotted (MutationObserver): the lint banner and the toggle's state. Under load the auto-open used to
    // land in a later commit (a useEffect), so for tens of ms the button still said "More options" while an open was pending, and
    // a press in that window closed it (fe3b Q4/Q5). The invariant: no commit shows the lint banner with More options still shut.
    await page.evaluate(() => {
      const seen: string[] = ((window as any).__mf2 = []);
      const snap = () => {
        const err = !!document.querySelector('[data-testid="fill-error"]');
        const t = document.querySelector('[data-testid="details-more-toggle"]');
        seen.push(`${err ? "error" : "clean"}/${t?.getAttribute("aria-expanded")}`);
      };
      new MutationObserver(snap).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    await page.getByTestId("cb-claim").fill(`Apple makes a foldable iPhone available to buy in the US during 2027. ${"It must be sold by Apple itself, not a reseller. ".repeat(6)}`);
    await page.getByTestId("cb-deadline").fill(utcToLocalInput("2027-12-31T23:59")); // leaves the claim: the lint shows
    await expect(page.getByTestId("fill-error")).toBeVisible();
    await expect(page.getByTestId("details-more-toggle")).toHaveAttribute("aria-expanded", "true");
    const seen: string[] = await page.evaluate(() => (window as any).__mf2);
    expect(seen.filter((s) => s === "error/false")).toEqual([]);
    await openMoreOptions(page); // already open: the helper leaves it open
    await expect(page.getByTestId("details-more")).toBeVisible();
  });

  test("Back keeps what was typed; Edit from the review returns to the same filled step", async ({ page }) => {
    await setup(page);
    await card(page, "nws_daily_high").click();
    await fillType(page, "nws_daily_high");
    await page.getByTestId("fill-next").click();
    await page.getByTestId("resolver-back").click();
    await expect(page.getByTestId("guided-x_f")).toHaveValue("72");
    await page.getByTestId("fill-back").click();
    await expect(page.getByTestId("bet-type-picker")).toBeVisible();
    await card(page, "nws_daily_high").click();
    await expect(page.getByTestId("guided-x_f")).toHaveValue("72");
  });

  test("Edit on the review card returns to the resolver step with the filled bet intact", async ({ page }) => {
    await setup(page);
    await openBetType(page, "btc_touch");
    await fillType(page, "btc_touch");
    await page.getByTestId("fill-next").click();
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("review-card")).toBeVisible();
    await expect(page.getByTestId("review-claim")).toContainText("Bitcoin touches $76,000");
    await page.getByTestId("back-to-create").click();
    await expect(page.getByTestId("step-resolver")).toBeVisible();
    await page.getByTestId("resolver-back").click();
    await expect(page.getByTestId("guided-x_usd")).toHaveValue("76000");
    // a fresh "Create offer" starts at the picker again. The create flow is a modal now, so the nav is behind it: close it (discarding) first.
    await page.keyboard.press("Escape");
    await page.getByTestId("discard-confirm").click();
    await page.getByTestId("nav-create").click();
    await expect(page.getByTestId("bet-type-picker")).toBeVisible();
  });

  test("UTC time shows its local time beside it", async ({ page }) => {
    await setup(page);
    await openBetType(page, "btc_close_at_t");
    await page.getByTestId("guided-t_utc").fill("2027-12-01T15:00");
    await expect(page.getByTestId("guided-t_utc-local")).toContainText("in your time zone");
  });
});
