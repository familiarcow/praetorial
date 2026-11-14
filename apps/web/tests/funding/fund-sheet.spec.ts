// F4 (FUND4 SPEC §4, familiarcow UX-37 FUND 12/13, D-FUND4a), mocked: the Add money sheet end to end on F2's mock Worker.
//   step 1 any token (search "trc20"), "Bet with" limited to the 6 (same token or USDC), the estimate, the ONE-TIME address (QR,
//   band, countdown, network warning, memo), never a permanent bridge address; every tracker state's copy; the address gone at
//   the deadline; the record survives a reload and shows on a second device; toasts on a live change; no near.com path (ACCT2);
//   the Worker down; the inline sheet over the take flow keeps the draft ("Back to your bet"); 375 px, axe, screenshots.
// The mainnet-only flow runs on this testnet dev build through the deposit-API seam (window.__e2eDepositApi), like F3's specs.
import { type Page } from "@playwright/test"; import { test, expect } from "../e2eGuard";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import {
  ONECLICK_TOKENS, ID, STATUS, T0, DEPOSIT_ADDRESS, XRP_DEPOSIT_ADDRESS, createMockFundingWorker, fundQuote, fundRecord, status,
  type MockWorkerOpts,
} from "./fixtures";
import type { SwapRecord } from "../../lib/funding/types";

const ME = "a".repeat(64);
const SIG = "22".repeat(64);
const RPC = "https://test.rpc.fastnear.com";
const FUNDING = "https://praetorial-funding-testnet.familiarcow.workers.dev";
const BRIDGE = "https://bridge.chaindefuser.com/rpc";
const RELAYER = "http://localhost:8788";
const USDC_T = "nep141:usdc.testnet";
const SHOTS = process.env.F4_SHOTS === "1" ? "../../spikes/fund4/shots" : "test-results/screens/f4";
const DEADLINE = Date.parse(fundQuote().deadline!); // T0 + 60 min

interface Opts { worker?: MockWorkerOpts; local?: SwapRecord[]; usdc?: string; bet?: unknown; tokens?: unknown }
async function mock(page: Page, o: Opts = {}) {
  const worker = createMockFundingWorker(o.worker ?? {});
  const bridge: unknown[] = [];
  await page.addInitScript(({ me, sig, local }) => {
    (window as any).__e2eTestWallet = { nearAddress: me, signRawHash: async () => sig };
    (window as any).__e2eDepositApi = true;
    (window as any).__e2eFundingWorker = true; // this spec mocks the Worker: background list + status polls on
    if (local.length && !sessionStorage.getItem("f4-seeded")) {
      localStorage.setItem(`praetorial:funding:v1:${me}`, JSON.stringify(local));
      sessionStorage.setItem("f4-seeded", "1");
    }
  }, { me: ME, sig: SIG, local: o.local ?? [] });
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o.tokens ?? ONECLICK_TOKENS) }));
  await page.route(`${FUNDING}/**`, (r) => worker.route(r));
  await page.route(BRIDGE, (r) => { bridge.push(r.request().postData()); return r.fulfill({ status: 500, body: "{}" }); });
  await page.route("**/praetorial-indexer-testnet.familiarcow.workers.dev/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("http://localhost:8787/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const p = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (p.request_type === "view_access_key") return ok({ nonce: 1 });
    if (p.request_type === "view_account") return ok({ amount: "0" });
    if (p.request_type !== "call_function") return ok({});
    const args = JSON.parse(Buffer.from(p.args_base64 ?? "e30=", "base64").toString("utf8") || "{}");
    const m = p.method_name as string;
    let r: unknown = null;
    const bal = (id: string) => (id === USDC_T ? o.usdc ?? "0" : "0");
    if (m === "mt_batch_balance_of") r = (args.token_ids as string[]).map(bal);
    else if (m === "mt_balance_of") r = bal(args.token_id);
    else if (m === "mt_tokens_for_owner") r = [];
    else if (m === "ft_balance_of") r = "0";
    else if (m === "is_paused" || m === "is_shutdown") r = false;
    else if (m === "open_offers") r = [];
    else if (m === "get_bet") r = args.bet_id === 7 ? o.bet ?? null : null;
    else if (m === "asset_limit") r = { storage_per_kib: "1" };
    else if (m === "resolver_keys") r = ["a", "b", JSON.parse(readFileSync(new URL("../../lib/release.json", import.meta.url), "utf8")).resolver_wasm_hash];
    else if (m === "pending_payouts") r = [];
    return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
  });
  return { worker, bridge };
}
const ready = (page: Page) => page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
async function noSeriousAxe(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  const r = await new AxeBuilder({ page }).include("[data-testid=add-money-sheet]").analyze();
  expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.html?.slice(0, 120)}`)).toEqual([]);
}
const noHScroll = async (page: Page, w: number) => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
const openSheet = async (page: Page) => {
  await page.getByTestId("account-add-money").or(page.getByTestId("empty-add-money")).first().click();
  await expect(page.getByTestId("fund-sheet")).toBeVisible();
};
const sheet = (page: Page) => page.getByTestId("add-money-sheet");
async function issueTronUsdt(page: Page) {
  await sheet(page).getByTestId("fund-search").fill("trc20");
  await sheet(page).getByTestId("fund-token-USDT-tron").click();
  await sheet(page).getByTestId("fund-betwith-USDC").click(); // USDT on Tron would land as USDT by default (same token)
  await sheet(page).getByTestId("fund-amount").fill("20");
  await expect(sheet(page).getByTestId("fund-you-get")).toHaveText("You'll get ≈ 19.97 USDC in your betting balance");
  await sheet(page).getByTestId("fund-get-address").click();
  await expect(sheet(page).getByTestId("fund-address")).toHaveText(DEPOSIT_ADDRESS);
}
const stored = (page: Page) => page.evaluate((me) => JSON.parse(localStorage.getItem(`praetorial:funding:v1:${me}`) ?? "[]"), ME);

test.describe("F4 Add money: one-time address", () => {
  for (const [name, size] of [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 900 }]] as const) {
    test(`${name}px: any token -> bet with -> estimate -> one-time address (QR, band, countdown) -> tracker to credited; axe; no h-scroll`, async ({ page }) => {
      await page.clock.install({ time: T0 });
      await page.setViewportSize(size);
      const { worker, bridge } = await mock(page);
      await page.goto("/account"); await ready(page);
      await openSheet(page);
      // ACCT2: one path, no tabs (the "From near.com" tab is gone); step 1 lists Popular with a network on every row.
      await expect(sheet(page).getByRole("tablist")).toHaveCount(0);
      await expect(sheet(page)).not.toContainText("near.com");
      await expect(sheet(page).getByTestId("fund-popular").locator("li").first()).toContainText("USDT");
      await expect(sheet(page).getByTestId("fund-popular").locator("li").first()).toContainText("Tron (TRC-20)");
      await expect(sheet(page).locator("[data-testid^=fund-token-BTC]")).toHaveCount(2); // Popular + All; the pseudo-asset is hidden
      await noSeriousAxe(page);
      await page.screenshot({ path: `${SHOTS}/f4-step1-${name}.png`, fullPage: true });
      // Search: exchange aliases find the network.
      await sheet(page).getByTestId("fund-search").fill("trc20");
      await expect(sheet(page).getByTestId("fund-results").locator("li")).toHaveCount(2); // USDT + TRX on Tron
      await sheet(page).getByTestId("fund-search").fill("zzzz");
      await expect(sheet(page).getByTestId("fund-no-results")).toHaveText("No match. Try the token symbol, like USDT, or the network, like Tron.");
      // A non-bet token (TRX) defaults to USDC; the picker offers exactly the 6.
      await sheet(page).getByTestId("fund-search").fill("trx");
      await sheet(page).getByTestId("fund-token-TRX-tron").click();
      await expect(sheet(page).getByTestId("fund-betwith").getByRole("radio")).toHaveText(["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"]);
      await expect(sheet(page).getByTestId("fund-betwith-USDC")).toHaveAttribute("aria-checked", "true");
      await sheet(page).getByTestId("fund-back").click();
      // A bet token on another network defaults to the same token.
      await sheet(page).getByTestId("fund-search").fill("usdt eth");
      await sheet(page).getByTestId("fund-token-USDT-eth").click();
      await expect(sheet(page).getByTestId("fund-betwith-USDT")).toHaveAttribute("aria-checked", "true");
      await sheet(page).getByTestId("fund-back").click();
      // The Get button waits for an estimate for exactly these inputs.
      await sheet(page).getByTestId("fund-search").fill("trc20");
      await sheet(page).getByTestId("fund-token-USDT-tron").click();
      await expect(sheet(page).getByTestId("fund-get-address")).toBeDisabled();
      await sheet(page).getByTestId("fund-betwith-USDC").click();
      await sheet(page).getByTestId("fund-amount").fill("20");
      await expect(sheet(page).getByTestId("fund-you-get")).toHaveText("You'll get ≈ 19.97 USDC in your betting balance");
      await expect(sheet(page).getByTestId("fund-eta")).toHaveText("in about 1 min · fee ≈ 0.02 USDC");
      const dry = worker.calls.filter((c) => c.path === "/fund/quote");
      expect(dry.at(-1)!.body).toEqual({ account: ME, originAsset: ID.TRON_USDT, betWith: ID.USDC, amountIn: "20000000", dry: true });
      await page.screenshot({ path: `${SHOTS}/f4-amount-${name}.png`, fullPage: true });
      await sheet(page).getByTestId("fund-get-address").click();
      // The one-time address: saved locally BEFORE it was shown.
      await expect(sheet(page).getByTestId("fund-address")).toHaveText(DEPOSIT_ADDRESS);
      const saved = await stored(page);
      expect(saved.map((r: SwapRecord) => [r.id, r.kind, r.state, r.recipient])).toEqual([[DEPOSIT_ADDRESS, "fund", "waiting", null]]);
      const real = worker.calls.filter((c) => c.path === "/fund/quote" && c.body.dry === false);
      expect(real).toHaveLength(1);
      expect(real[0]!.body).toEqual({ account: ME, originAsset: ID.TRON_USDT, betWith: ID.USDC, amountIn: "20000000", dry: false });
      await expect(sheet(page).getByTestId("fund-qr")).toBeVisible();
      await expect(sheet(page).getByTestId("fund-address-title")).toHaveText("Send USDT on Tron");
      await expect(sheet(page).getByTestId("fund-network-badge")).toHaveText("Tron network");
      await expect(sheet(page).getByTestId("fund-band")).toHaveText("Send between 19.80 USDT and 20.00 USDT. More is fine; it's converted too.");
      await expect(sheet(page).getByTestId("fund-deadline")).toContainText(/^Send before \d\d:\d\d — 59:\d\d left$/);
      await expect(sheet(page).getByTestId("fund-only-this")).toHaveText("⚠ Only USDT on Tron. Other tokens or networks are lost.");
      await expect(sheet(page).getByTestId("fund-exchange")).toHaveText(`Sending from an exchange? Pick the "Tron (TRC-20)" network there.`);
      await expect(sheet(page).getByTestId("fund-memo-block")).toHaveCount(0);
      await noSeriousAxe(page);
      await noHScroll(page, size.width);
      await page.screenshot({ path: `${SHOTS}/f4-address-${name}.png`, fullPage: true });
      // No permanent bridge address was ever asked for (familiarcow UX-37 FUND 13).
      expect(bridge).toEqual([]);
      // Sent -> the tracker walks waiting -> confirming -> converting -> credited (mock sequence), with a toast on each change.
      await sheet(page).getByTestId("fund-sent").click();
      await expect(sheet(page).getByTestId("fund-track-message")).toContainText("Waiting for your USDT on Tron.");
      await page.clock.runFor(6_000);
      await expect(sheet(page).getByTestId("fund-track-message")).toHaveText("We see your deposit. Waiting for the Tron network to confirm it (usually about 1 min).");
      await expect(page.getByTestId("toast")).toContainText("We see your USDT deposit (Tron).");
      await page.clock.runFor(6_000);
      await expect(sheet(page).getByTestId("fund-track-message")).toHaveText("Converting 20.00 USDT (Tron) to USDC for betting…");
      await page.screenshot({ path: `${SHOTS}/f4-tracker-${name}.png`, fullPage: true });
      await page.clock.runFor(11_000);
      await expect(sheet(page).getByTestId("fund-track-message")).toHaveText("19.97 USDC added to your betting balance.");
      await expect(sheet(page).getByTestId("fund-step-done")).toHaveCount(4);
      await expect(page.getByTestId("toast").last()).toHaveText(/19\.97 USDC added to your betting balance\./);
      await expect(sheet(page).getByTestId("fund-cta-bet")).toHaveText("Place a bet");
      await noSeriousAxe(page);
      await page.screenshot({ path: `${SHOTS}/f4-credited-${name}.png`, fullPage: true });
      // Final: polling stops.
      const n = worker.calls.filter((c) => c.path === "/fund/status").length;
      await page.clock.runFor(31_000);
      expect(worker.calls.filter((c) => c.path === "/fund/status").length).toBe(n);
    });
  }

  test("memo chains: the memo has its own QR + Copy and the must-include warning", async ({ page }) => {
    await page.clock.install({ time: T0 });
    await mock(page, { worker: { quote: () => fundQuote({ depositAddress: XRP_DEPOSIT_ADDRESS, depositMemo: "998877", amountIn: "20000000", minAmountIn: "19800000" }) } });
    await page.goto("/account"); await ready(page);
    await openSheet(page);
    await sheet(page).getByTestId("fund-search").fill("xrp");
    await sheet(page).getByTestId("fund-token-XRP-xrp").click();
    await sheet(page).getByTestId("fund-amount").fill("20");
    await expect(sheet(page).getByTestId("fund-you-get")).toBeVisible();
    await sheet(page).getByTestId("fund-get-address").click();
    await expect(sheet(page).getByTestId("fund-address")).toHaveText(XRP_DEPOSIT_ADDRESS);
    await expect(sheet(page).getByTestId("fund-memo")).toHaveText("998877");
    await expect(sheet(page).getByTestId("fund-memo-qr")).toBeVisible();
    await expect(sheet(page).getByTestId("fund-memo-warning")).toHaveText("You must include this memo, or the deposit is lost.");
    expect((await stored(page))[0].id).toBe(`${XRP_DEPOSIT_ADDRESS}#998877`);
    await page.screenshot({ path: `${SHOTS}/f4-memo-375.png`, fullPage: true });
  });

  test("the address is REMOVED at the deadline (after the < 10 min warning); only 'Get a new address' remains", async ({ page }) => {
    await page.clock.install({ time: DEADLINE - 11 * 60_000 });
    await mock(page, { worker: { statuses: { [DEPOSIT_ADDRESS]: [STATUS.waiting] } } });
    await page.goto("/account"); await ready(page);
    await openSheet(page);
    await issueTronUsdt(page);
    await expect(sheet(page).getByTestId("fund-soon")).toHaveCount(0);
    await page.clock.runFor(61_000);
    await expect(sheet(page).getByTestId("fund-soon")).toHaveText("Less than 10 minutes left. If your send might be slow, get a new address.");
    await page.clock.runFor(10 * 60_000);
    await expect(sheet(page).getByTestId("fund-address")).toHaveCount(0);
    await expect(sheet(page).getByTestId("fund-qr")).toHaveCount(0);
    await expect(sheet(page).getByTestId("fund-track-message")).toHaveText("This address has expired. Don't send to it.");
    await expect(sheet(page).getByText(DEPOSIT_ADDRESS)).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/f4-expired-375.png`, fullPage: true });
    // A new address starts again with the same token.
    await sheet(page).getByTestId("fund-cta-new-address").click();
    await expect(sheet(page).getByTestId("fund-origin")).toHaveText("Send USDT on Tron");
  });

  test("reload mid-tracker: the strip on every page restores it, and it opens the same deposit", async ({ page }) => {
    await page.clock.install({ time: T0 });
    await mock(page, { worker: { statuses: { [DEPOSIT_ADDRESS]: [STATUS.waiting, STATUS.converting] } } });
    await page.goto("/account"); await ready(page);
    await openSheet(page);
    await issueTronUsdt(page);
    await page.goto("/"); await ready(page);
    await expect(page.getByTestId("fund-strip")).toBeVisible();
    await expect(page.getByTestId("fund-compact-text")).toHaveText("Adding 20.00 USDT (Tron) → USDC · Waiting for your deposit");
    await page.screenshot({ path: `${SHOTS}/f4-strip-375.png` });
    await page.getByTestId("fund-compact").click();
    await expect(sheet(page).getByTestId("fund-address")).toHaveText(DEPOSIT_ADDRESS);
    await page.clock.runFor(6_000);
    await page.clock.runFor(6_000);
    await expect(sheet(page).getByTestId("fund-track-message")).toHaveText("Converting 20.00 USDT (Tron) to USDC for betting…");
    // Account: the in-progress card opens the same tracker (F3's card, F4's sheet).
    await sheet(page).getByTestId("modal-close").click();
    await page.getByTestId("nav-account").click();
    await expect(page.getByTestId("fund-strip")).toHaveCount(0);
    await page.getByTestId("inflight-line").getByRole("button").click();
    await expect(sheet(page).getByTestId("fund-tracker")).toHaveAttribute("data-state", "converting");
  });

  test("second device: a deposit only the server knows shows in the strip", async ({ page }) => {
    await page.clock.install({ time: T0 });
    await mock(page, { worker: { records: [fundRecord({ state: "credited", lastStatus: "PROCESSING" })], statuses: { [DEPOSIT_ADDRESS]: [STATUS.converting] } } });
    await page.goto("/"); await ready(page);
    // The Worker's own `state` is ignored: lastStatus PROCESSING is what tracker.advance maps (SM2 F4-2).
    await expect(page.getByTestId("fund-compact-text")).toHaveText("Adding 20.00 USDT (Tron) → USDC · Converting");
  });
});

test.describe("F4 tracker: every SPEC §4.6 state renders its copy", () => {
  const cases: [string, ReturnType<typeof status> | "down", string, string?][] = [
    ["confirming", STATUS.confirming, "We see your deposit. Waiting for the Tron network to confirm it (usually about 1 min)."],
    ["converting", STATUS.converting, "Converting 20.00 USDT (Tron) to USDC for betting…"],
    ["short", STATUS.short, "We got 15.00 USDT, but this address needs at least 19.80 USDT. Send 4.80 USDT more before"],
    ["credited", STATUS.credited, "19.97 USDC added to your betting balance."],
    ["refunded", STATUS.refunded, `We couldn't convert it, so we returned 15.00 USDT (Tron) to your account. It's under "Not usable for bets yet".`, "You sent less than the minimum."],
    ["failed", STATUS.failed, "Something went wrong on the conversion side. Your money is traceable."],
    ["checking", "down", "We can't check right now. Your deposit is still being processed. Retrying…"],
  ];
  for (const [name, st, text, reason] of cases) {
    test(name, async ({ page }) => {
      await page.clock.install({ time: T0 + 60_000 });
      const worker = name === "checking" ? { errors: { "GET /fund/status": { code: "upstream_down" as const } } } : { statuses: { [DEPOSIT_ADDRESS]: [st as ReturnType<typeof status>] } };
      await mock(page, { local: [fundRecord()], worker: { ...worker, records: [fundRecord()] } });
      await page.goto("/"); await ready(page);
      await page.getByTestId("fund-compact").click();
      for (let i = 0; i < 4; i++) await page.clock.runFor(31_000);
      await expect(sheet(page).getByTestId("fund-track-message")).toContainText(text);
      if (reason) await expect(sheet(page).getByTestId("fund-track-reason")).toHaveText(reason);
      if (name === "failed") await expect(sheet(page).getByTestId("fund-cta-help")).toHaveText("Get help");
      if (name === "checking") await expect(sheet(page).getByTestId("fund-track-notice")).not.toHaveAttribute("data-tone", "bad");
      await page.screenshot({ path: `${SHOTS}/f4-state-${name}-375.png`, fullPage: true });
    });
  }

  test("expired: still waiting 30 min after the deadline", async ({ page }) => {
    await page.clock.install({ time: DEADLINE + 29 * 60_000 });
    await mock(page, { local: [fundRecord()], worker: { records: [fundRecord()], statuses: { [DEPOSIT_ADDRESS]: [STATUS.waiting] } } });
    await page.goto("/"); await ready(page);
    await page.getByTestId("fund-compact").click();
    await page.clock.runFor(2 * 60_000);
    await expect(sheet(page).getByTestId("fund-track-message")).toHaveText("This address expired and nothing arrived. If you did send, get help.");
    await expect(sheet(page).getByTestId("fund-cta-new-address")).toBeVisible();
  });
});

test.describe("F4 no near.com path (ACCT2), errors", () => {
  test("ACCT2: no near.com tab, account-ID send or Confidential warning; a NEAR-network token still gets a one-time address with 'Only <token> on <network>'", async ({ page }) => {
    await page.clock.install({ time: T0 });
    await mock(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/account"); await ready(page);
    await openSheet(page);
    await expect(sheet(page).getByRole("tab")).toHaveCount(0);
    await expect(sheet(page).locator("[data-testid^=fund-tab-], [data-testid^=nearcom-], [data-testid=fund-nearcom]")).toHaveCount(0);
    await expect(sheet(page)).not.toContainText(/near\.com|confidential|account id/i);
    await expect(sheet(page)).not.toContainText(ME); // the account id is never offered as somewhere to send
    // How a near.com user funds now: Add money -> USDC -> network NEAR -> paste the one-time address.
    await sheet(page).getByTestId("fund-search").fill("usdc");
    await sheet(page).getByTestId("fund-token-USDC-near").first().click();
    await sheet(page).getByTestId("fund-amount").fill("20");
    await sheet(page).getByTestId("fund-get-address").click();
    await expect(sheet(page).getByTestId("fund-address")).toBeVisible();
    await expect(sheet(page).getByTestId("fund-only-this")).toHaveText("⚠ Only USDC on NEAR. Other tokens or networks are lost.");
    await expect(sheet(page)).not.toContainText(/near\.com|confidential/i);
    await noSeriousAxe(page);
    await noHScroll(page, 375);
  });

  test("the Worker down: plain 'unavailable' copy, no address, nothing saved", async ({ page }) => {
    await mock(page, { worker: { down: true } });
    await page.goto("/account"); await ready(page);
    await openSheet(page);
    await sheet(page).getByTestId("fund-search").fill("trc20");
    await sheet(page).getByTestId("fund-token-USDT-tron").click();
    await sheet(page).getByTestId("fund-amount").fill("20");
    await expect(sheet(page).getByTestId("fund-error")).toHaveText("Adding money and cashing out are unavailable right now. Your balances are safe.");
    await expect(sheet(page).getByTestId("fund-get-address")).toBeDisabled();
    expect(await stored(page)).toEqual([]);
  });

  test("below the minimum: the minimum is named (rounded up)", async ({ page }) => {
    await mock(page, { worker: { errors: { "POST /fund/quote": { code: "too_low", minUnits: "1870001" } } } });
    await page.goto("/account"); await ready(page);
    await openSheet(page);
    await sheet(page).getByTestId("fund-search").fill("trc20");
    await sheet(page).getByTestId("fund-token-USDT-tron").click();
    await sheet(page).getByTestId("fund-amount").fill("1");
    await expect(sheet(page).getByTestId("fund-error")).toHaveText("That's below the minimum of 1.88 USDT.");
  });
});

// The take flow (FE2b scenario) with the mainnet seam: Add money opens OVER the bet page and the take draft is kept.
const FUND_NS = Date.now() * 1e6 + 7 * 24 * 3600 * 1e9;
const RESOLVE_NS = Date.now() * 1e6 + 30 * 24 * 3600 * 1e9;
const BET7 = {
  envelope: {
    bet_id: 7, version: 1, maker: "maker.testnet", taker_allow: "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "cd".repeat(32),
    outcomes: ["YES", "NO"], maker_side: "YES", maker_asset: USDC_T, taker_asset: USDC_T, stake_maker: "10000000", stake_taker: "10000000",
    taker_options: [], fee_bps: 100, reserve_per_side: "0", storage_charge_per_side: "0", keep_terms: false, terms: null, run_price: "0",
    max_paid_runs: 3, tier: 1, arbiter: null, arbiter_fee: "0", funding_deadline: FUND_NS,
    early_settle_outcome: null, finality_delay: 0, settlement_period: 24 * 3600 * 1e9, resolve_deadline: RESOLVE_NS,
    consent_party_controlled: false, referee: { account: "ref.testnet", mode: "Human" },
  },
  status: "Open", taker: null, created_at: 0, taken_at: null, proposed_at: null, outcome: null, reserve_remaining: "0",
  bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0, fee_min_taker: "0",
};

test.describe("F4 inline Add money from a bet flow", () => {
  test("take, short: the sheet opens over the bet page (URL unchanged), locked to USDC, sized to the shortfall; Back to your bet keeps the draft", async ({ page }) => {
    const { worker } = await mock(page, { usdc: "5000000", bet: BET7, worker: { statuses: { [DEPOSIT_ADDRESS]: [STATUS.credited] } } });
    let relays = 0;
    await page.route(`${RELAYER}/relay`, (r) => { relays++; return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: "t" }) }); });
    await page.goto("/bet/7"); await ready(page);
    await expect(page.getByTestId("take-section")).toBeVisible();
    await page.waitForTimeout(300);
    await page.getByTestId("take-open").click();
    await page.getByTestId("take-tip-checkbox").check();
    await page.getByTestId("take-confirm").click(); // M1: one confirm step
    await expect(page.getByTestId("modal-short")).toBeVisible();
    await page.getByTestId("modal-add-money").click();
    await expect(sheet(page)).toBeVisible();
    await expect(page).toHaveURL(/\/bet\/7$/);
    await expect(sheet(page).getByTestId("fund-locked-note")).toHaveText("This bet is in USDC");
    // The bet's token comes first on every network.
    await expect(sheet(page).getByTestId("fund-popular").locator("li").first()).toContainText("USDC");
    await sheet(page).getByTestId("fund-popular").getByTestId("fund-token-USDC-base").click();
    await expect(sheet(page).getByTestId("fund-betwith-locked")).toHaveText("This bet is in USDC");
    await expect(sheet(page).getByTestId("fund-betwith").getByRole("radio")).toHaveCount(0);
    // Sized to the shortfall: full pay-now minus the 5 USDC already there, asked as needOut; the amount is pre-filled.
    await expect(sheet(page).getByTestId("fund-amount")).toHaveValue("20");
    await expect(sheet(page).getByTestId("fund-covers")).toHaveText(/^Covers the 5\.\d\d USDC you need for this bet$/);
    const sized = worker.calls.find((c) => c.path === "/fund/quote" && c.body.needOut);
    expect(BigInt(sized!.body.needOut)).toBeGreaterThan(5_000_000n);
    expect(BigInt(sized!.body.needOut)).toBeLessThan(6_000_000n);
    await page.screenshot({ path: `${SHOTS}/f4-inline-take-375.png`, fullPage: true });
    await sheet(page).getByTestId("fund-get-address").click();
    await expect(sheet(page).getByTestId("fund-cta-back")).toHaveText("Back to your bet", { timeout: 15_000 });
    expect(relays).toBe(0);
    await sheet(page).getByTestId("fund-cta-back").click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/bet\/7$/);
    // The take modal is where the user left it, tip kept.
    await expect(page.getByTestId("take-confirm-summary")).toContainText("Referee tip");
  });
});
