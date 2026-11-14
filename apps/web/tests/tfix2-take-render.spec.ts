// TFIX2 (familiarcow, live mainnet bet #1, 2026-11-13): right after a successful Take the app showed a blank white page. Fully mocked; the
// bet is mainnet bet #1's real get_bet answer (tests/fixtures/tfix2: BTC price at a set time, AI judge, keep_terms, NEAR 3 vs 3) and
// its real indexer rows, with the times shifted so "now" is the take moment. A logged-in taker takes it with NEAR and with USDC stakes:
// the success sheet, then the page shows the bet taken by them, never a blank page and never an uncaught error. Then the safety net:
// any render error shows "Something went wrong. Reload" (Reload button + the bet link), logged to the console, never a white page.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { screenPath } from "./lib/screens";
import BET1 from "./fixtures/tfix2/mainnet-bet1.json" with { type: "json" };
import TXS1 from "./fixtures/tfix2/mainnet-bet1-txs.json" with { type: "json" };

const WALLET = "03c105e3c8dc8eccd940900a70fe34350a17fd72974289642e39c70e7168a5b5"; // bet #1's taker (a Privy implicit account)
const MAKER = "ad39d83eafc72b6761af760d120467a4e7861ef8d21455912e75679f3fc0c4b2";
const RPC = "https://test.rpc.fastnear.com";
const RELAYER = "http://localhost:8788";
const INDEXER = "http://localhost:8787";
const REG = "http://registry.e2e.test";
const NAMES: Record<string, string> = { [WALLET]: "testman1", [MAKER]: "familiarcow" };
// Bet #1's real asset_limit for wNEAR (bets.praetorial.near, read 2026-11-13); the USDC one is the same shape in 6 dp.
const LIMIT_NEAR = { min_per_side: "2731382215970391816778881", max_per_side: "1" + "0".repeat(34), min_fee_per_side: "136569110798519590838944", min_fee_cap_per_side: "682845553992597954194720", run_price: "1365691107985195908390", min_bond: "1365691107985195908389441", min_objection: "273138221597039181677889", storage_per_kib: "10240000000000000000000" };
const LIMIT_USDC = { min_per_side: "1000000", max_per_side: "1" + "0".repeat(14), min_fee_per_side: "50000", min_fee_cap_per_side: "250000", run_price: "500", min_bond: "500000", min_objection: "100000", storage_per_kib: "10000" };

interface Stake { name: string; asset: string; stake: string; feeMin: string; storage: string; limit: object; shown: RegExp }
const STAKES: Stake[] = [
  { name: "NEAR", asset: "nep141:wrap.testnet", stake: BET1.envelope.stake_maker, feeMin: BET1.fee_min_taker, storage: BET1.storage_taker, limit: LIMIT_NEAR, shown: /3 NEAR/ },
  { name: "USDC", asset: "nep141:usdc.testnet", stake: "3000000", feeMin: "50000", storage: "17060", limit: LIMIT_USDC, shown: /3(\.00)? USDC/ },
];

// Every real timestamp moves by the same offset, so the page sees the take moment (bet #1 was taken 2026-11-13 22:57:05 UTC, 4 min after
// the open price time and 62 min before the close: the "Live" phase of a price-at-a-set-time bet).
const TAKEN_NS = BigInt(BET1.taken_at);
const OFF = BigInt(Date.now()) * 1_000_000n - TAKEN_NS;
const sh = (ns: number | string) => (BigInt(String(ns).split(".")[0].split("e")[0].length > 15 ? BigInt(Math.round(Number(ns))) : BigInt(ns)) + OFF).toString();
const shIso = (iso: string) => new Date(Date.parse(iso) + Number(OFF / 1_000_000n)).toISOString().replace(/\.\d+Z$/, "Z");

interface World { status: string; taker: string | null; relays: number }
function betText(w: World, s: Stake): string {
  const t = JSON.parse(BET1.envelope.terms);
  const terms = JSON.stringify({ ...t, fields: { ...t.fields, open_utc: shIso(t.fields.open_utc), t_utc: shIso(t.fields.t_utc) } });
  const taken = w.status === "Taken";
  const bet = {
    ...BET1,
    envelope: { ...BET1.envelope, bet_id: 1, maker_asset: s.asset, taker_asset: s.asset, stake_maker: s.stake, stake_taker: s.stake, terms, storage_charge_per_side: "0",
      funding_deadline: "__FUND__", resolve_deadline: "__RESOLVE__" },
    fee_min_maker: s.feeMin, fee_min_taker: s.feeMin, storage_maker: s.storage, storage_taker: taken ? s.storage : "0",
    status: w.status, taker: w.taker, created_at: "__CREATED__", taken_at: taken ? "__TAKEN__" : null,
  };
  // u64 fields go out as bare JSON numbers with every digit, exactly as the contract writes them.
  return JSON.stringify(bet).replace('"__FUND__"', sh(BET1.envelope.funding_deadline)).replace('"__RESOLVE__"', sh(BET1.envelope.resolve_deadline))
    .replace('"__CREATED__"', sh(BET1.created_at)).replace('"__TAKEN__"', sh(BET1.taken_at));
}
const txs = (w: World, s: Stake) => TXS1.filter((t) => t.kind === "create" || w.status === "Taken").map((t) => ({
  ...t, at_ns: sh(t.at_ns), moved_in: t.moved_in.map((m) => ({ ...m, token: s.asset, amount: (BigInt(s.stake) + BigInt(s.storage)).toString() })),
}));

async function setup(page: Page, s: Stake, opts: { crash?: string } = {}) {
  const w: World = { status: "Open", taker: null, relays: 0 };
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  await page.addInitScript(({ address, crash }) => {
    (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => "22".repeat(64) };
    (window as any).__e2eConfirm = { delayMs: 50, attempts: 4 };
    if (crash) (window as any).__e2eRenderCrash = crash;
  }, { address: WALLET, crash: opts.crash ?? null });
  await page.addInitScript((reg) => { (window as any).__e2eRegistryUrl = reg; }, REG);
  await page.route(`${REG}/**`, (route) => {
    const m = /\/lookup\/account\/([^/?]+)/.exec(new URL(route.request().url()).pathname);
    const name = m ? NAMES[decodeURIComponent(m[1]!)] : undefined;
    return name ? route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ username: name }) })
      : route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" }, body: "not found" });
  });
  await page.route(`${INDEXER}/bet/txs*`, (r) => r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(txs(w, s)) }));
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    const okText = (text: string) => ok({ result: Array.from(Buffer.from(text, "utf8")) });
    if (body.method === "block") return ok({ header: { height: 100, timestamp_nanosec: (BigInt(Date.now()) * 1_000_000n).toString() } });
    if (body.method === "tx" || body.method === "EXPERIMENTAL_tx_status") return ok({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { logs: [] } }] });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1" + "0".repeat(24) });
    if (params.request_type === "call_function") {
      const args = JSON.parse(Buffer.from(params.args_base64 ?? "e30=", "base64").toString("utf8") || "{}");
      switch (params.method_name) {
        case "get_bet": return okText(args.bet_id === 1 ? betText(w, s) : "null");
        case "asset_limit": return okText(JSON.stringify(s.limit));
        case "mt_balance_of": return okText(JSON.stringify("1" + "0".repeat(26)));
        case "is_paused": case "is_shutdown": return okText("false");
        case "open_offers": case "pending_payouts": return okText("[]");
        default: return okText("null");
      }
    }
    return ok({});
  });
  await page.route(`${RELAYER}/relay`, async (r) => {
    w.relays++;
    // A real send takes seconds (Privy signs, the relayer waits for the block): the page's 1 s clock ticks while the bet is still Open.
    await new Promise((res) => setTimeout(res, 1500));
    w.status = "Taken"; w.taker = WALLET;
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: `TX${w.relays}` }) });
  });
  return { w, errors, consoleErrors };
}

const open = async (page: Page, path = "/bet/1") => {
  await page.goto(path);
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
};
const dlg = (p: Page) => p.locator("dialog[open]").last();
/** "Blank" = the app's root rendered nothing (React unmounted it) or the crash screen took over. */
async function expectNotBlank(page: Page) {
  expect(await page.evaluate(() => (document.getElementById("root")?.childElementCount ?? 0) > 0)).toBe(true);
  await expect(page.getByTestId("crash-screen")).toHaveCount(0);
  await expect(page.getByTestId("bet-page")).toBeVisible();
}

test.describe("TFIX2 take: never a white page after the take succeeds", () => {
  for (const s of STAKES) {
    for (const [vw, size] of [["375", { width: 375, height: 800 }], ["1280", { width: 1280, height: 900 }]] as const) {
      test(`${s.name} stakes, ${vw}px: take succeeds -> success sheet -> the page shows the bet taken by me (no blank, no uncaught error)`, async ({ page }) => {
        await page.setViewportSize(size);
        const { w, errors } = await setup(page, s);
        await open(page);
        await expect(page.getByTestId("bet-page")).toContainText(s.shown);
        await page.getByTestId("take-open").click();
        await dlg(page).getByTestId("take-confirm").click();
        await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
        await expect(dlg(page).getByTestId("take-result")).toHaveAttribute("data-kind", "taken");
        expect(w.relays).toBe(1);
        // The bet page under the success sheet already follows the taken bet (onTaken re-reads it): it must still be there.
        await expect(page.getByTestId("bet-status")).toHaveText("Taken", { timeout: 10_000 });
        await expectNotBlank(page);
        await dlg(page).getByTestId("flow-done").click();
        await expect(page.locator("dialog[open]")).toHaveCount(0);
        await expectNotBlank(page);
        await expect(page.getByTestId("bet-page")).toContainText("You");
        await expect(page.getByTestId("bet-activity")).toContainText(/You took it on NO with 3(\.00)? (NEAR|USDC)/);
        // Every section a taker can open renders too (activity receipts, More actions: concede / change who decides, Details).
        for (let i = 0; i < 3; i++) await page.evaluate(() => document.querySelectorAll("details").forEach((d) => { (d as HTMLDetailsElement).open = true; }));
        await expectNotBlank(page);
        // One more poll cycle (15 s) and the clock tick: the taken-by-me view keeps rendering.
        await page.waitForTimeout(16_000);
        await expectNotBlank(page);
        expect(errors).toEqual([]);
        if (s.name === "NEAR") await page.screenshot({ path: screenPath(`tfix2/after-take-${s.name}-${vw}.png`), fullPage: true });
      });
    }
  }
});

test.describe("TFIX2 safety net: a render error shows 'Something went wrong. Reload', never a white page", () => {
  test("a render error on a bet page: message, Reload button and the bet link; the error is logged to the console", async ({ page }) => {
    const { errors, consoleErrors } = await setup(page, STAKES[0]!, { crash: "bet-page" });
    await page.goto("/bet/1?invite=ab12");
    const crash = page.getByTestId("crash-screen");
    await expect(crash).toBeVisible({ timeout: 20_000 });
    await expect(crash.getByRole("heading")).toHaveText("Something went wrong. Reload");
    await expect(crash.getByTestId("crash-bet-link")).toHaveAttribute("href", "/bet/1?invite=ab12");
    await expect(crash.getByTestId("crash-bet-link")).toHaveText("Open bet #1");
    await expect(crash.getByRole("button", { name: "Reload" })).toBeVisible();
    expect(consoleErrors.some((l) => l.includes("[praetorial] render crashed") && l.includes("e2e render crash (bet-page)"))).toBe(true);
    expect(errors).toEqual([]); // caught by the boundary: nothing uncaught
    await page.screenshot({ path: screenPath("tfix2/crash-screen-1280.png") });
    // Reload reloads the same URL.
    const reloaded = page.waitForEvent("load");
    await crash.getByRole("button", { name: "Reload" }).click();
    await reloaded;
    await expect(page).toHaveURL(/\/bet\/1\?invite=ab12$/);
  });

  test("the incident: a render error right after the take succeeds -> the crash screen with the bet link, not a white page", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    const { w, consoleErrors } = await setup(page, STAKES[0]!, { crash: "taken-by-me" });
    await open(page);
    await page.getByTestId("take-open").click();
    await dlg(page).getByTestId("take-confirm").click();
    const crash = page.getByTestId("crash-screen");
    await expect(crash).toBeVisible({ timeout: 20_000 });
    expect(w.relays).toBe(1);
    await expect(crash.getByRole("heading")).toHaveText("Something went wrong. Reload");
    await expect(crash.getByTestId("crash-bet-link")).toHaveAttribute("href", "/bet/1");
    await expect(crash.getByRole("button", { name: "Reload" })).toBeVisible();
    expect(consoleErrors.some((l) => l.includes("[praetorial] render crashed") && l.includes("e2e render crash (taken-by-me)"))).toBe(true);
    await page.screenshot({ path: screenPath("tfix2/crash-screen-375.png") });
  });

  test("a render error off a bet page: message and Reload, no bet link", async ({ page }) => {
    await setup(page, STAKES[0]!, { crash: "app" });
    await page.goto("/");
    const crash = page.getByTestId("crash-screen");
    await expect(crash).toBeVisible({ timeout: 20_000 });
    await expect(crash.getByRole("button", { name: "Reload" })).toBeVisible();
    await expect(crash.getByTestId("crash-bet-link")).toHaveCount(0);
  });
});
