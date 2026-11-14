// Covers: bet-type picker (FE3: the dev presets are gone, D-UX21), review-card validation
// flags on custom claims, and the referee (BET1b: cross-asset taker options are gone, D-SCOPE5)
// picker's taker-named gating. Uses the same real Privy test login as
// jason-bet.spec.ts (no mocked auth) but mocks the two outbound network
// calls that would otherwise make this flaky/slow in CI: the dev
// ticker proxy (price-disagreement check) and 1Click's public tokens
// endpoint (cross-asset quote prefill) -- both are plain fetches the
// app already isolates behind lib/priceCheck.ts and lib/oneclick.ts,
// so mocking them here never touches app logic.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { fillDeadlineUtc, openMoreOptions } from "./betDetailsHelpers";

const EMAIL = process.env.PRIVY_TEST_EMAIL!;
const OTP = process.env.PRIVY_TEST_OTP!;
if (process.env.PW_LIVE && (!EMAIL || !OTP)) throw new Error("PRIVY_TEST_EMAIL / PRIVY_TEST_OTP not set in env");

test.describe.configure({ mode: "serial" });
test.describe("@live real Privy login", () => {
let page: Page;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  // WEBREG1: testnet builds default to the live registry, which would put the username step in front of these create-bet flows.
  await context.addInitScript(() => { (window as any).__e2eRegistryUrl = ""; });
  page = await context.newPage();

  // Deterministic 1Click token list: USDC priced, wBTC NOT priced (so
  // the "not offered" path is also exercised for real).
  await page.route("https://1click.chaindefuser.com/v0/tokens", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { assetId: "nep141:usdc.testnet", symbol: "USDC", decimals: 6, price: 1, priceUpdatedAt: "2026-11-04T00:00:00Z" },
        { assetId: "nep141:wrap.testnet", symbol: "wNEAR", decimals: 24, price: 3, priceUpdatedAt: "2026-11-04T00:00:00Z" },
      ]),
    }),
  );

  // Deterministic ticker proxy: Coinbase/Bitstamp agree, so the preset
  // (which uses exactly these two) shows no disagreement warning by
  // default in this test run.
  await page.route("**/api/ticker*", (route) => {
    const url = new URL(route.request().url());
    const venue = url.searchParams.get("venue");
    const price = venue === "coinbase" ? 100000 : venue === "bitstamp" ? 100050 : 99000;
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ venue, price }) });
  });

  await page.goto("/");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
  await page.getByTestId("email-input").fill(EMAIL);
  await page.getByTestId("send-code").click();
  await page.waitForTimeout(2000);
  await page.getByTestId("otp-input").fill(OTP);
  await page.getByTestId("submit-code").click();
  await page.waitForFunction(() => (window as any).__e2e?.authenticated === true, { timeout: 20_000 });
  await page.waitForFunction(() => !!(window as any).__e2e?.nearAddress, { timeout: 30_000 });
  await page.getByTestId("nav-create").click();
  await expect(page.getByTestId("create-offer-form")).toBeVisible();
});

// Defensive: force back to the create screen before every test in this
// file. Guards against any cross-test navigation drift (e.g. a prior
// test leaving the "review" screen) instead of assuming continuity.
test.beforeEach(async () => {
  await page.bringToFront();
  await page.getByTestId("nav-create").click();
  await expect(page.getByTestId("create-offer-form")).toBeVisible();
});

// FE3 (D-UX21): the dev presets are gone; every test that needs the resolver step goes through the picker + fill-in step.
async function toResolverStep() {
  await page.getByTestId("bet-type-card-nws_daily_high").click();
  await page.getByTestId("guided-station").selectOption("KNYC");
  await page.getByTestId("guided-date").fill("2027-12-08");
  await page.getByTestId("guided-op").selectOption(">=");
  await page.getByTestId("guided-x_f").fill("72");
  await page.getByTestId("fill-next").click();
  await expect(page.getByTestId("step-resolver")).toBeVisible();
}

test("FE3: the picker offers the five bet types and no dev presets", async () => {
  // TPL1 (PM 14:05): four tiles; the three price types (incl. Which outperforms?) sit under "Asset prices"
  await expect(page.locator('[data-testid^="bet-type-card-"]')).toHaveCount(4);
  await page.getByTestId("bet-type-card-prices").click();
  await expect(page.locator('[data-testid^="bet-type-card-"]')).toHaveCount(3);
  await page.getByTestId("bet-type-prices-back").click();
  for (const id of ["jason-preset", "custom-claim", "btc-venue-template", "claim-text"]) await expect(page.getByTestId(id)).toHaveCount(0);
});

test("a custom bet with a vague claim is flagged and Next stays blocked", async () => {
  await page.getByTestId("bet-type-card-custom").click();
  await page.getByTestId("cb-claim").fill("Something happens");
  await page.getByTestId("cb-source-publisher-0").fill("Co"); // too vague
  await expect(page.getByTestId("fill-error")).toBeVisible();
  await expect(page.getByTestId("fill-next")).toBeDisabled();
  // Still on the fill-in step -- never advanced.
  await expect(page.getByTestId("step-resolver")).toHaveCount(0);
});

test("fixing the custom claim via the guided custom builder clears the flags and allows review", async () => {
  // WT1b(d) (4861e0e) lints every custom sheet with the resolver custom lint, which requires elements/rule/sources/
  // clauses/fallback+early rules. The simple venue/pair/timezone fields cannot supply those (D-LAUNCH1 custom =
  // any page; WT1d 417fd1a added the guided builder that does). The old flow filled only venue/pair/tz.
  await page.getByTestId("bet-type-card-custom").click();
  await expect(page.getByTestId("custom-builder")).toBeVisible();
  await page.getByTestId("cb-claim").fill("Apple makes a foldable iPhone available to buy in the US during 2027.");
  await fillDeadlineUtc(page, "2027-12-31T23:59"); // BET1a: deadline in local time; the rest under More options
  await page.getByTestId("cb-source-url-1").fill("https://www.reuters.com/");
  await openMoreOptions(page);
  await page.getByTestId("cb-element-0").fill("Did Apple make a foldable-screen iPhone available to purchase in the United States between 2027-01-01 and 2027-12-31 UTC?");
  await page.getByTestId("cb-source-publisher-0").fill("apple.com newsroom");
  await page.getByTestId("cb-source-publisher-1").fill("Reuters");
  await page.getByTestId("cb-windowStart").fill("2027-01-01T00:00");
  await page.getByTestId("cb-evidenceCutoff").fill("2028-01-07T00:00");
  await page.getByTestId("cb-fallback").fill("Fallback: if a named source is unavailable, the other may confirm.");
  await page.getByTestId("cb-early").fill("Early YES resolution is allowed once the event has happened.");
  await page.getByTestId("fill-next").click();
  await page.getByTestId("maker-amount").fill("10");
  await page.getByTestId("review-offer").click();
  await expect(page.getByTestId("review-card")).toBeVisible();
  await expect(page.getByTestId("review-flags")).toHaveCount(0); // C1: no "ready" debug word
  await page.getByTestId("back-to-create").click();
});

test("direct challenge: buildOpenMsg locks taker_allow to the named taker; open offers stay public", async () => {
  // Pure adapter-logic check (no chain call) via a tiny injected probe,
  // exercising the same makeTakerAllow/buildOpenMsg the UI's escrow
  // adapter exports -- queue item 1.
  const result = await page.evaluate(async () => {
    // @ts-expect-error -- runtime-only browser import path (vite dev
    // server resolves /lib/*.ts directly); tsc's bundler resolution for
    // this project doesn't resolve absolute-root specifiers like this.
    const mod = await import("/lib/escrowAdapter.ts");
    const baseEnvelope: any = { bet_id: 1, maker: "maker.testnet" };
    const att = { checked_at: 1, signature_hex: "ab".repeat(64) };
    const direct = JSON.parse(mod.buildOpenMsg(baseEnvelope, att, "taker.testnet"));
    const open = JSON.parse(mod.buildOpenMsg(baseEnvelope, att, ""));
    const openNull = JSON.parse(mod.buildOpenMsg(baseEnvelope, att, null));
    return { direct, open, openNull };
  });
  expect(result.direct.envelope.taker_allow).toEqual({ Account: "taker.testnet" });
  expect(result.open.envelope.taker_allow).toEqual("Any");
  expect(result.openNull.envelope.taker_allow).toEqual("Any");
});

test("referee picker: AI | Person; choosing Person reveals the search, the tip checkbox only after a referee is picked (D-FE4b); no named taker needed (D-REFUI4)", async () => {
  await toResolverStep();
  await expect(page.getByTestId("decider-ai")).toBeChecked();
  await expect(page.getByTestId("referee-mode")).toHaveCount(0);
  await page.getByTestId("decider-person").check();
  await expect(page.getByTestId("referee-search")).toBeVisible();
  await expect(page.getByTestId("tip-maker-checkbox")).toHaveCount(0);
  await page.getByTestId("referee-search").fill("alic");
  await page.getByTestId("referee-result-0").click();
  await expect(page.getByTestId("tip-maker-checkbox")).toBeVisible();
});

test("referee cannot be the named taker", async () => {
  await toResolverStep();
  await page.getByTestId("decider-person").check();
  await page.getByTestId("more-options-toggle").click(); // BET1c: More options is collapsed by default
  await page.getByTestId("taker-account-input").fill("alice.testnet");
  await page.getByTestId("referee-search").fill("alic");
  await page.getByTestId("referee-result-0").click();
  // FE4 (spec S4 validation): the pick itself is refused, so the person is never selected.
  await expect(page.getByTestId("referee-pick-error")).toContainText("Referee cannot be the taker");
  await expect(page.getByTestId("referee-selected")).toHaveCount(0);
});

test("valid person referee produces the review-card line and tip cost", async () => {
  await toResolverStep();
  await page.getByTestId("decider-person").check();
  await page.getByTestId("more-options-toggle").click(); // BET1c: More options is collapsed by default
  await page.getByTestId("taker-account-input").fill("taker.testnet");
  await page.getByTestId("referee-search").fill("alic");
  await page.getByTestId("referee-result-0").click();
  await page.getByTestId("tip-maker-checkbox").check();
  await page.getByTestId("review-offer").click();
  await expect(page.getByTestId("review-card")).toBeVisible();
  // C1 (5 lines + Full terms, PEOPLE RULE): the referee and the named taker are people, never account ids
  await expect(page.getByTestId("review-decider")).toHaveText(/^@\w+, a person \(no AI\)$/);
  await expect(page.getByTestId("review-term-window")).toContainText("If they don't, you're both refunded.");
  await expect(page.getByTestId("review-term-tip")).toContainText("Tip to the referee");
  await expect(page.getByTestId("review-term-takers")).toHaveText(/^Only (@\w+|Unnamed account) can take it\.$/);
  await expect(page.getByTestId("review-card")).not.toContainText("taker.testnet");
});
});
