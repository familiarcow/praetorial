// MODAL1c1: Create bet as a FlowModal. Fully mocked (NEAR RPC, source check, relayer, wallet seam); never a real Privy login.
import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { screenPath } from "./lib/screens";

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
  await expect(page.locator("dialog[open]").last()).toBeVisible();
}


const dlg = (p: Page) => p.locator("dialog[open]").last();
const world = (over: Partial<World> = {}): World => ({ relayCalls: 0, count: 5, hash: "", status: "Open", txLogs: [], openOnRelay: true, onSecondRelay: null, relayFail: false, ...over });

async function pickNws(page: Page) {
  await page.getByTestId("bet-type-card-nws_daily_high").click();
  await page.getByTestId("guided-station").selectOption("KNYC");
  await page.getByTestId("guided-date").fill("2027-12-08");
  await page.getByTestId("guided-op").selectOption(">=");
  await page.getByTestId("guided-x_f").fill("72");
}
async function toResolver(page: Page, stake = "10") {
  await pickNws(page);
  await page.getByTestId("fill-next").click();
  await page.getByTestId("maker-amount").fill(stake);
}
async function toChecked(page: Page, w: World) {
  await toResolver(page);
  await page.getByTestId("review-offer").click();
  await expect(page.getByTestId("review-card")).toBeVisible();
  await expect(page.getByTestId("source-check-status")).toContainText("Checking sources… ✓"); // C1: automatic on entering Review
}
async function noSeriousAxe(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  const r = await new AxeBuilder({ page }).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes[0]?.html?.slice(0, 120)}`)).toEqual([]);
}

test.describe("MODAL1c1 create bet flow modal", () => {
  test("/new opens the modal over the browse page; Esc closes it and lands on browse", async ({ page }) => {
    await setup(page, world());
    await expect(dlg(page)).toBeVisible();
    await expect(dlg(page).getByRole("heading", { name: "Make a bet" })).toBeVisible();
    await expect(dlg(page).getByTestId("create-offer-form")).toBeVisible();
    await expect(page.getByTestId("browse-page")).toBeAttached();
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/); // NAV1: closing lands on Home (Explore Bets is a Home section)
    await expect(page.getByTestId("browse-page")).toBeVisible();
  });

  test("opening from the nav and pressing browser Back closes the modal, not the app", async ({ page }) => {
    await setup(page, world());
    await page.keyboard.press("Escape");
    await page.getByTestId("nav-create").click();
    await expect(dlg(page)).toBeVisible();
    await expect(page).toHaveURL(/\/new$/);
    await page.goBack();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/); // NAV1: closing lands on Home (Explore Bets is a Home section)
  });

  test("happy path: type, fill, check sources, review, send -> success with TxLink and the share screen", async ({ page }) => {
    const w = world();
    await setup(page, w);
    await toChecked(page, w);
    await expect(dlg(page).getByTestId("open-offer-btn")).toHaveText(/^Open the bet · \d[\d.,]* NEAR$/); // C1: "Open the bet · <you pay now>"
    await dlg(page).getByTestId("open-offer-btn").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("tx-link")).toHaveAttribute("href", /TX1/);
    await expect(dlg(page).getByTestId("share-screen")).toBeVisible();
    expect(w.relayCalls).toBe(1);
  });

  test("relayer failure: plain reason, nothing opened, Try again keeps the values", async ({ page }) => {
    const w = world({ relayFail: true, openOnRelay: false, txLogs: "unavailable" });
    await setup(page, w);
    await toChecked(page, w);
    await dlg(page).getByTestId("open-offer-btn").click();
    await expect(dlg(page).getByTestId("flow-failure")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("flow-failure")).toContainText("nothing was opened");
    await expect(dlg(page).getByTestId("share-screen")).toHaveCount(0);
    await dlg(page).getByTestId("flow-retry").click();
    await expect(dlg(page).getByTestId("review-card")).toBeVisible();
    // C1: the same reviewed bet is back (five-line review; the hash is no longer printed, the checked terms are unchanged)
    await expect(dlg(page).getByTestId("review-stakes")).toHaveText("You put in 10 NEAR · they put in 10 NEAR");
    await expect(dlg(page).getByTestId("review-claim")).toContainText("72");
    await dlg(page).getByTestId("back-to-create").click();
    await expect(dlg(page).getByTestId("maker-amount")).toHaveValue("10");
  });

  test("pending on chain: still confirming with the transaction link, safe to close", async ({ page }) => {
    const w = world({ openOnRelay: false, txLogs: "unavailable" });
    await setup(page, w);
    await toChecked(page, w);
    await dlg(page).getByTestId("open-offer-btn").click();
    await expect(dlg(page).getByTestId("flow-pending")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("tx-link")).toBeVisible();
    await expect(dlg(page).getByTestId("share-screen")).toHaveCount(0);
  });

  test("wallet declined: nothing sent, you stay on the review and can try again", async ({ page }) => {
    const w = world();
    await setup(page, w, { decline: true });
    await toChecked(page, w);
    await dlg(page).getByTestId("open-offer-btn").click();
    await expect(dlg(page).getByTestId("open-result")).toHaveAttribute("data-kind", "declined");
    await expect(dlg(page).getByTestId("open-offer-btn")).toBeEnabled();
    expect(w.relayCalls).toBe(0);
  });

  test("close mid-flow asks to discard; Keep editing keeps the modal, Discard closes and clears the draft", async ({ page }) => {
    await setup(page, world());
    await toResolver(page, "25");
    await dlg(page).getByTestId("modal-close").click();
    await expect(page.getByTestId("discard-confirm")).toBeVisible();
    await page.getByTestId("discard-keep").click();
    await expect(dlg(page).getByTestId("maker-amount")).toHaveValue("25");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("discard-confirm")).toBeVisible();
    await page.getByTestId("discard-confirm").click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/); // NAV1: closing lands on Home (Explore Bets is a Home section)
    await page.goto("/new");
    await expect(dlg(page).getByTestId("bet-type-card-nws_daily_high")).toBeVisible();
  });

  test("reload mid-flow: the draft resumes on the same step with the typed values", async ({ page }) => {
    await setup(page, world());
    await toResolver(page, "25");
    // The draft is written after React settles; wait for it like the user's next second would.
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("flowdraft:create-bet") ?? "")).toMatch(/stakeText\\+"\s*:\s*\\+"25/);
    await page.reload();
    await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
    await expect(dlg(page).getByTestId("maker-amount")).toHaveValue("25");
    await expect(dlg(page).getByTestId("taker-amount")).toHaveValue("25"); // BET1b: even by default
    await dlg(page).getByTestId("resolver-back").click();
    await expect(dlg(page).getByTestId("guided-x_f")).toHaveValue("72");
  });

  test("busy blocks close: while sending, Close is disabled and Esc does nothing", async ({ page }) => {
    const w = world();
    await setup(page, w);
    await page.route("http://localhost:8788/relay", async (r) => { await new Promise((res) => setTimeout(res, 1500)); await r.fallback(); });
    await toChecked(page, w);
    await dlg(page).getByTestId("open-offer-btn").click();
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await expect(dlg(page).getByTestId("modal-close")).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dlg(page)).toBeVisible();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
  });

  test("browser Back while sending does not lose the result: success + TxLink still show, one send", async ({ page }) => {
    const w = world();
    await setup(page, w);
    await page.keyboard.press("Escape");
    await page.getByTestId("nav-create").click(); // history: /browse then /new, so Back has somewhere to go
    await expect(dlg(page)).toBeVisible();
    await page.route("http://localhost:8788/relay", async (r) => { await new Promise((res) => setTimeout(res, 1500)); await r.fallback(); });
    await toChecked(page, w);
    await dlg(page).getByTestId("open-offer-btn").click();
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await page.goBack();
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await expect(page).toHaveURL(/\/new$/);
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("tx-link")).toHaveAttribute("href", /TX1/);
    expect(w.relayCalls).toBe(1);
    // once settled, Back is free again
    await page.goBack();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
  });

  for (const [name, size] of [["1280", { width: 1280, height: 900 }], ["375", { width: 375, height: 800 }]] as const) {
    test(`${name}px: every create step has axe 0 serious/critical; screenshots; 375 is a bottom sheet`, async ({ page }) => {
      await page.setViewportSize(size);
      const w = world();
      await setup(page, w);
      const shot = async (n: string) => { await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)))); await page.screenshot({ path: screenPath(`modal1c1/${n}-${name}.png`) }); };
      await expect(dlg(page).getByTestId("modal-surface")).toHaveAttribute("data-presentation", name === "375" ? "sheet" : "dialog");
      await noSeriousAxe(page); await shot("1-bet-type");
      await pickNws(page); await noSeriousAxe(page); await shot("2-fill");
      await dlg(page).getByTestId("fill-next").click();
      await dlg(page).getByTestId("maker-amount").fill("10");
      await noSeriousAxe(page); await shot("3-stake");
      await dlg(page).getByTestId("review-offer").click();
      await expect(dlg(page).getByTestId("review-card")).toBeVisible();
      await noSeriousAxe(page); await shot("4-review-sources");
      await expect(dlg(page).getByTestId("source-check-status")).toContainText("Checking sources… ✓"); // C1: automatic on entering Review
      await dlg(page).getByTestId("open-offer-btn").click();
      await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
      await noSeriousAxe(page); await shot("5-success");
    });
  }
});
