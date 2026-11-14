// FE8 (S8, S9): fund and publish. Fully mocked: NEAR RPC (views + tx logs), source check, relayer POST /relay, wallet seam.
// Never a real Privy login; never a testnet write.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const SC = "http://localhost:8790/sourcecheck";
const RELAYER = "http://localhost:8788";
const WASM = JSON.parse(readFileSync(new URL("../lib/release.json", import.meta.url), "utf8")).resolver_wasm_hash;

interface World {
  relayCalls: number;
  count: number;          // bet_count the mock reports
  hash: string;           // terms hash of the bet the app is opening
  status: string;         // get_bet status for the new bet
  txLogs: string[] | "unavailable";
  openOnRelay: boolean;   // the first relay call creates bet #6
  onSecondRelay: "Cancelled" | "Taken" | null;
  relayFail: boolean;
}
const FUNDING_NS = Date.UTC(2027, 0, 2, 3, 4) * 1_000_000;

function betJson(w: World) {
  return {
    envelope: { bet_id: 6, version: 1, maker: WALLET, taker_allow: "Any", terms_hash: w.hash, maker_asset: "nep141:wrap.testnet", taker_asset: "nep141:wrap.testnet", stake_maker: "10", stake_taker: "10", taker_options: [], funding_deadline: FUNDING_NS, referee: null, outcomes: ["YES", "NO"], maker_side: "YES" },
    status: w.status, taker: null, created_at: 0, taken_at: null, proposed_at: null, outcome: null, reserve_remaining: "0", bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0,
  };
}

async function setup(page: Page, w: World, opts: { decline?: boolean } = {}) {
  await page.addInitScript(({ address, decline }) => {
    (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => { if (decline) throw new Error("User rejected the request"); return "22".repeat(64); } };
    (window as any).__e2eConfirm = { delayMs: 50, attempts: 4 };
  }, { address: WALLET, decline: !!opts.decline });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const reply = (obj: object) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", ...obj }) });
    const ok = (result: unknown) => reply({ result });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (body.method === "tx" || body.method === "EXPERIMENTAL_tx_status") {
      if (w.txLogs === "unavailable") return reply({ error: { name: "UNKNOWN_TRANSACTION", cause: { name: "UNKNOWN_TRANSACTION" } } });
      return ok({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { logs: w.txLogs } }] });
    }
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      let r: unknown = null;
      const args = JSON.parse(Buffer.from(params.args_base64 ?? "e30=", "base64").toString("utf8") || "{}");
      switch (params.method_name) {
        case "is_paused": case "is_shutdown": r = false; break;
        case "open_offers": r = []; break;
        case "asset_limit": r = { storage_per_kib: "1" }; break;
        case "resolver_keys": r = ["a", "b", WASM]; break;
        case "mt_balance_of": r = "1" + "0".repeat(30); break;
        case "bet_count": r = w.count; break;
        case "get_bet": r = args.bet_id === 6 && w.count >= 6 ? betJson(w) : null; break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  await page.route(SC, async (route) => {
    const { terms } = JSON.parse(route.request().postData() ?? "{}");
    w.hash = createHash("sha256").update(terms).digest("hex"); // C1: the terms the app checked (= what the Open signs); the review no longer prints the hash
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: true, spec_hash: createHash("sha256").update(terms).digest("hex"), checked_at: String(Date.now() * 1_000_000), unreachable: [], signing: { signature_hex: "33".repeat(64) } }) });
  });
  await page.route(`${RELAYER}/relay`, (r) => {
    w.relayCalls++;
    if (w.relayFail) return r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "relayer down" }) });
    if (w.relayCalls === 1 && w.openOnRelay) { w.count = 6; w.status = "Open"; }
    if (w.relayCalls === 2 && w.onSecondRelay) w.status = w.onSecondRelay;
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: `TX${w.relayCalls}` }) });
  });
  await page.route("**/ticker**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ venue: "x", price: 1 }) }));
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto("/new");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
}

async function toChecked(page: Page, w: World) {
  await page.getByTestId("bet-type-card-nws_daily_high").click();
  await page.getByTestId("guided-station").selectOption("KNYC");
  await page.getByTestId("guided-date").fill("2027-12-08");
  await page.getByTestId("guided-op").selectOption(">=");
  await page.getByTestId("guided-x_f").fill("72");
  await page.getByTestId("fill-next").click();
  await page.getByTestId("maker-amount").fill("10");
  await page.getByTestId("review-offer").click();
  await expect(page.getByTestId("review-card")).toBeVisible();
  await expect(page.getByTestId("source-check-status")).toContainText("Checking sources… ✓"); // C1: automatic on entering Review
}

const world = (over: Partial<World> = {}): World => ({ relayCalls: 0, count: 5, hash: "", status: "Open", txLogs: [], openOnRelay: true, onSecondRelay: null, relayFail: false, ...over });

test.describe("FE8 fund and publish", () => {
  test("success: one signature, read back with get_bet, then the share screen (copy link, expiry, no redeploy note)", async ({ page }) => {
    const w = world();
    await setup(page, w);
    await toChecked(page, w);
    await expect(page.getByTestId("open-pending-note")).toHaveCount(0);
    await expect(page.getByTestId("open-offer-btn")).toHaveText(/^Open the bet · \d[\d.,]* NEAR$/); // C1: one primary, "Open the bet · <you pay now>"
    await page.getByTestId("open-offer-btn").click();
    await expect(page.getByTestId("share-screen")).toBeVisible({ timeout: 20_000 });
    expect(w.relayCalls).toBe(1);
    await expect(page.getByTestId("share-title")).toHaveText("Your bet is open. Share the link so the other person can take it.");
    const origin = new URL(page.url()).origin;
    await expect(page.getByTestId("share-link")).toHaveValue(`${origin}/bet/6`);
    // C1 (UX-37 #6): relative closing time; the exact one (the bet's funding_deadline) is the <time datetime> shown on tap
    await expect(page.getByTestId("share-status")).toHaveText(/^Waiting for someone to take it · closes in \d+ (months?|days?)$/);
    await expect(page.getByTestId("share-status").locator("time")).toHaveAttribute("datetime", "2027-01-02T03:04:00.000Z");
    await expect(page.getByTestId("share-help")).toContainText("Send this link to the person you're betting.");
    await page.getByTestId("share-copy").click();
    await expect(page.getByTestId("share-copied")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/bet/6`);
    await expect(page.getByTestId("review-card")).toHaveCount(0);
    await expect(page.getByTestId("cancel-bet")).toBeVisible();
  });

  test("wallet declined: plain message, nothing sent, can try again", async ({ page }) => {
    const w = world();
    await setup(page, w, { decline: true });
    await toChecked(page, w);
    await page.getByTestId("open-offer-btn").click();
    await expect(page.getByTestId("open-result")).toHaveText("You cancelled. Nothing was sent.");
    await expect(page.getByTestId("open-result")).toHaveAttribute("data-kind", "declined");
    expect(w.relayCalls).toBe(0);
    await expect(page.getByTestId("share-screen")).toHaveCount(0);
    await expect(page.getByTestId("open-offer-btn")).toBeEnabled();
  });

  test("contract refusal: mapped message, refund confirmed, no share screen", async ({ page }) => {
    const w = world({ openOnRelay: false, txLogs: ["open_rejected bet=unassigned reason=stake ratio exceeds 10:1 max odds"] });
    await setup(page, w);
    await toChecked(page, w);
    await page.getByTestId("open-offer-btn").click();
    await expect(page.getByTestId("open-result")).toHaveAttribute("data-kind", "refused", { timeout: 20_000 });
    const t = (await page.getByTestId("open-result").textContent()) ?? "";
    expect(t).toMatch(/^The contract refused this bet: .+\. Your money was returned\.$/);
    expect(t).toMatch(/odds/i);
    expect(t).not.toMatch(/stake ratio|10:1 max/);
    await expect(page.getByTestId("share-screen")).toHaveCount(0);
  });

  test("no readable result: Still confirming, money safe, never a green state", async ({ page }) => {
    const w = world({ openOnRelay: false, txLogs: "unavailable" });
    await setup(page, w);
    await toChecked(page, w);
    await page.getByTestId("open-offer-btn").click();
    await expect(page.getByTestId("open-result")).toHaveText("Still confirming. Your money is safe; check My bets.", { timeout: 20_000 });
    await expect(page.getByTestId("share-screen")).toHaveCount(0);
  });

  test("relayer failure: a plain message and no share screen", async ({ page }) => {
    const w = world({ relayFail: true, openOnRelay: false, txLogs: "unavailable" });
    await setup(page, w);
    await toChecked(page, w);
    await page.getByTestId("open-offer-btn").click();
    await expect(page.getByTestId("open-result")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("open-result")).not.toHaveAttribute("data-kind", "opened");
    await expect(page.getByTestId("share-screen")).toHaveCount(0);
  });

  test("cancel: asks first, Keep it open does nothing, confirm relays cancel and reads back Cancelled", async ({ page }) => {
    const w = world({ onSecondRelay: "Cancelled" });
    await setup(page, w);
    await toChecked(page, w);
    await page.getByTestId("open-offer-btn").click();
    await expect(page.getByTestId("share-screen")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("cancel-bet").click();
    await expect(page.getByTestId("cancel-confirm-box")).toContainText("Cancel this bet and get your money back?");
    expect(w.relayCalls).toBe(1);
    await page.getByTestId("cancel-keep").click();
    await expect(page.getByTestId("cancel-confirm-box")).toHaveCount(0);
    expect(w.relayCalls).toBe(1);
    await page.getByTestId("cancel-bet").click();
    await page.getByTestId("cancel-confirm").click();
    await expect(page.getByTestId("cancel-result")).toHaveText("Your bet is cancelled and your money is back.", { timeout: 20_000 });
    expect(w.relayCalls).toBe(2);
  });

  test("cancel race: someone took it first -> 'It's live now.'", async ({ page }) => {
    const w = world({ onSecondRelay: "Taken" });
    await setup(page, w);
    await toChecked(page, w);
    await page.getByTestId("open-offer-btn").click();
    await expect(page.getByTestId("share-screen")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("cancel-bet").click();
    await page.getByTestId("cancel-confirm").click();
    await expect(page.getByTestId("cancel-result")).toHaveText("Someone took this bet a moment ago. It's live now.", { timeout: 20_000 });
  });
});
