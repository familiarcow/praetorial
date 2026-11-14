// FE15 (S17): Duplicate this bet, from a finished bet's payout screen (S15) and from My bets (S16). Fully mocked: NEAR RPC views, the indexer,
// the source-check service, ticker + 1Click; wallet via the window.__e2eTestWallet seam. No real Privy login, no write.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { openMoreActions } from "./lib/betPage";
import { createHash } from "node:crypto";
import { buildTypedSheet, canonicalTerms } from "../lib/templates";
import { fieldsFromForm } from "../lib/guidedFields";
import { assetId } from "../lib/assets";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const INDEXER = "http://localhost:8787";
const NEAR = assetId("NEAR")!;
const Y24 = 10n ** 24n;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(Math.floor(ms / 60000) * 60000).toISOString().replace(/\.\d+Z$/, "Z");
const OLD_DEADLINE = iso(Date.now() - 10 * DAY);
const OLD_OPEN = "2026-01-02T03:04:00Z";
const OLD_ID = 4242;

const oldTerms = canonicalTerms(buildTypedSheet("btc_touch", { ...fieldsFromForm("btc_touch", { direction: "at_or_above", x_usd: "76000", deadline_utc: OLD_DEADLINE.slice(0, 16) }, Date.now()), open_utc: OLD_OPEN }));

const mk = (id: number, o: { status?: string; taker?: string | null; allow?: any; terms?: string; referee?: string } = {}) => ({
  envelope: { bet_id: id, version: 1, maker: WALLET, taker_allow: o.allow ?? "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "cd".repeat(32), terms: o.terms ?? oldTerms, outcomes: ["YES", "NO"], maker_side: "YES",
    maker_asset: NEAR, taker_asset: NEAR, stake_maker: String(10n * Y24), stake_taker: String(15n * Y24), taker_options: [], fee_bps: 100, keep_terms: true, funding_deadline: (Date.now() - 20 * DAY) * 1e6, resolve_deadline: Date.UTC(2037, 0, 5) * 1e6, settlement_period: 6 * 3_600_000_000_000,
    referee: o.referee ? { account: o.referee, mode: "Human" } : null, tip_maker: false },
  status: o.status ?? "Settled", taker: o.taker === undefined ? "other.testnet" : o.taker, created_at: (Date.now() - 30 * DAY) * 1e6, taken_at: null, proposed_at: 5, outcome: "YES", reserve_remaining: "0",
  bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0, fee_min_maker: "1", fee_min_taker: "1", tip_maker: "0", tip_taker: "0", storage_maker: "20000", storage_taker: "20000", last_resolution_raw: null,
});

async function setup(page: Page, bets: Record<number, any>) {
  const checks: any[] = [];
  await page.addInitScript((address) => { (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => "22".repeat(64) }; }, WALLET);
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8"));
      let r: unknown = null;
      switch (params.method_name) {
        case "is_paused": case "is_shutdown": r = false; break;
        case "open_offers": r = []; break;
        case "asset_limit": r = { storage_per_kib: "457" }; break;
        case "mt_balance_of": r = "0"; break;
        case "get_bet": r = bets[args.bet_id] ?? null; break;
        case "pending_payouts": r = []; break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  const json = (route: any, v: unknown) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(v) });
  await page.route(`${INDEXER}/history**`, (route) => json(route, new URL(route.request().url()).searchParams.get("account") ? Object.entries(bets).map(([id, b]: any) => ({ bet_id: Number(id), maker: b.envelope.maker, taker: b.taker, status: b.status, outcome: b.outcome })) : []));
  await page.route(`${INDEXER}/offers**`, (route) => json(route, []));
  await page.route("http://localhost:8790/sourcecheck", async (route) => {
    const posted = JSON.parse(route.request().postData() ?? "{}");
    checks.push(posted);
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: true, spec_hash: createHash("sha256").update(posted.terms ?? "").digest("hex"), checked_at: String(Date.now() * 1_000_000), unreachable: [], signing: { signature_hex: "33".repeat(64) } }) });
  });
  await page.route("**/ticker**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ venue: "x", price: 100000 }) }));
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  return checks;
}
const ready = (page: Page) => page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });

// What the copied form must show, whichever screen started the duplicate.
async function expectCopiedForm(page: Page) {
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByTestId("copied-banner")).toContainText("Copied from your bet of");
  await expect(page.getByTestId("copied-banner")).toContainText("Check the dates before you continue.");
  await expect(page.getByTestId("fill-step")).toBeVisible(); // S3, with the old terms in it
  await expect(page.getByTestId("guided-x_usd")).toHaveValue("76000");
  await expect(page.getByTestId("guided-direction")).toHaveValue("at_or_above");
  await expect(page.getByTestId("past-dates-note")).toHaveText("These dates have passed. Pick new ones.");
  await expect(page.getByTestId("guided-deadline_utc")).toHaveAttribute("data-past", "true");
  await expect(page.getByTestId("guided-deadline_utc")).toHaveValue(OLD_DEADLINE.slice(0, 16));
  await expect(page.getByTestId("guided-x_usd")).not.toHaveAttribute("data-past", "true");
}

test.describe("FE15 Duplicate this bet (S17)", () => {
  test("from a finished bet: terms copied, past date highlighted, named taker cleared, a fresh preflight and stamp are required", async ({ page }) => {
    const checks = await setup(page, { [OLD_ID]: mk(OLD_ID, { allow: { Account: "friend.testnet" } }) });
    await page.goto(`/bet/${OLD_ID}`);
    await ready(page);
    await expect(page.getByTestId("payout-screen")).toBeVisible();
    await openMoreActions(page); // B1 (UX-37 #4): Duplicate (and Cancel) live under the collapsed More actions
    await page.getByTestId("payout-duplicate").click();
    await expectCopiedForm(page);
    // fix the date, go on: the other copied terms are in the next step
    await page.getByTestId("guided-deadline_utc").fill(iso(Date.now() + 60 * DAY).slice(0, 16));
    await page.getByTestId("fill-next").click();
    await expect(page.getByTestId("maker-amount")).toHaveValue("10");
    await expect(page.getByTestId("taker-amount")).toHaveValue("15"); // BET1b: their amount (odds 1.5) is copied
    // BET1c: the challenge window is fixed at 24h (the old bet's 6h is not carried); the named taker is cleared
    await expect(page.getByTestId("more-options-summary")).toHaveText("Closes in 7 days · anyone can take · 24h to challenge");
    await expect(page.getByTestId("decider-ai")).toBeChecked();
    // nothing carried: no preflight before Review; the Open button is locked until a FRESH check (C1: it runs by itself, once) passes
    expect(checks.length).toBe(0);
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("source-check-status")).toContainText("Checking sources… ✓");
    expect(checks.length).toBe(1);
    const sent = JSON.parse(checks[0].terms);
    expect(sent.fields.deadline_utc).not.toBe(OLD_DEADLINE.slice(0, 16) + ":00Z");
    expect(sent.fields.open_utc).not.toBe(OLD_OPEN); // a new stamp
    expect(Date.parse(sent.fields.open_utc)).toBeGreaterThan(Date.now() - 5 * 60_000);
    expect(JSON.stringify(checks[0])).not.toContain(String(OLD_ID));
    await expect(page.getByTestId("open-offer-btn")).toBeEnabled();
  });

  // H1 (familiarcow UX-37 #4): Home cards have no Duplicate; it is in the bet page's More actions (settled bets: under the payout card).
  test("Home has no Duplicate; a finished bet's page does, and it opens the copied form", async ({ page }) => {
    await setup(page, {
      3: mk(3),
      1: mk(1, { status: "Open", taker: null, allow: { Account: "friend.testnet" } }),
    });
    await page.goto("/my-bets");
    await ready(page);
    await expect(page.getByTestId("mybet-row-1")).toBeVisible();
    await expect(page.getByTestId("home").getByText(/duplicate/i)).toHaveCount(0);
    await page.goto("/bet/3");
    await ready(page);
    await openMoreActions(page);
    await expect(page.getByTestId("payout-duplicate")).toHaveText("Duplicate this bet");
    await page.getByTestId("payout-duplicate").click();
    await expectCopiedForm(page);
  });

  test("a finished bet whose terms cannot be copied says so on its page and stays there", async ({ page }) => {
    await setup(page, { 3: mk(3, { terms: JSON.stringify({ claimText: "Old style terms" }) }) });
    await page.goto("/bet/3");
    await ready(page);
    await openMoreActions(page);
    await page.getByTestId("payout-duplicate").click();
    await expect(page.getByTestId("duplicate-error")).toContainText("We can't copy that bet.");
    await expect(page).toHaveURL(/\/bet\/3$/);
  });

  test("FE15b: an open bet's maker actions have Duplicate this bet; it opens the copied form and leaves the open bet alone", async ({ page }) => {
    await setup(page, { 5: mk(5, { status: "Open", taker: null, allow: { Account: "friend.testnet" } }) });
    await page.goto("/bet/5");
    await ready(page);
    await openMoreActions(page); // B1 (UX-37 #4): Duplicate (and Cancel) live under the collapsed More actions
    await expect(page.getByTestId("cancel-bet")).toBeVisible();
    await expect(page.getByTestId("open-duplicate")).toHaveText("Duplicate this bet");
    await page.getByTestId("open-duplicate").click();
    await expectCopiedForm(page);
    await page.getByTestId("guided-deadline_utc").fill(iso(Date.now() + 60 * DAY).slice(0, 16));
    await page.getByTestId("fill-next").click();
    await expect(page.getByTestId("maker-amount")).toHaveValue("10");
    await expect(page.getByTestId("taker-amount")).toHaveValue("15"); // BET1b: their amount (odds 1.5) is copied
    await expect(page.getByTestId("more-options-summary")).toContainText("anyone can take"); // BET1c: named taker cleared
  });

  test("FE15b: an open bet's Duplicate says so when the terms cannot be copied, and stays on the bet", async ({ page }) => {
    await setup(page, { 5: mk(5, { status: "Open", taker: null, terms: JSON.stringify({ claimText: "Old style terms" }) }) });
    await page.goto("/bet/5");
    await ready(page);
    await openMoreActions(page); // B1 (UX-37 #4): Duplicate (and Cancel) live under the collapsed More actions
    await page.getByTestId("open-duplicate").click();
    await expect(page.getByTestId("duplicate-error")).toHaveText("We can't copy that bet.");
    await expect(page).toHaveURL(/\/bet\/5$/);
  });

  test("FE15b: someone else's open bet has no Duplicate", async ({ page }) => {
    await setup(page, { 6: { ...mk(6, { status: "Open", taker: null }), envelope: { ...mk(6).envelope, maker: "m.testnet" } } });
    await page.goto("/bet/6");
    await ready(page);
    await expect(page.getByTestId("cancel-bet")).toHaveCount(0);
    await expect(page.getByTestId("open-duplicate")).toHaveCount(0);
  });

  test("a bet I am not part of has no Duplicate on its page", async ({ page }) => {
    await setup(page, { 9: { ...mk(9), taker: "t.testnet", envelope: { ...mk(9).envelope, maker: "m.testnet" } } });
    await page.goto("/bet/9");
    await ready(page);
    await expect(page.getByTestId("payout-screen")).toBeVisible();
    await expect(page.getByTestId("payout-duplicate")).toHaveCount(0);
  });
});
