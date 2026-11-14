// MODAL1c4: cancel offer and change referee as modals over /bet/:id. Fully mocked (NEAR RPC, relayer, wallet seam); never a real Privy login.
import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { mockUsernames, openMoreActions } from "./lib/betPage";
import { SCHEMA } from "@near-js/transactions";
import * as borsh from "borsh";
import { screenPath } from "./lib/screens";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const RELAYER = "http://localhost:8788";
const USDC = "nep141:usdc.testnet";
const HOUR = 3_600_000;
const NEW_REF = "newref.testnet";
const refValue = (a: string) => JSON.stringify({ account: a, mode: "Human" });

interface World { role: "maker" | "taker"; status: string; referee: string | null; proposal: { maker_value: string | null; taker_value: string | null }; relays: number; relayFail: boolean; relayDelayMs: number }
const world = (o: Partial<World> = {}): World => ({ role: "maker", status: "Open", referee: "ref.testnet", proposal: { maker_value: null, taker_value: null }, relays: 0, relayFail: false, relayDelayMs: 0, ...o });
const betJson = (w: World) => ({
  envelope: { bet_id: 7, version: 1, maker: w.role === "maker" ? WALLET : "maker.testnet", taker_allow: "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "cd".repeat(32), terms: null, outcomes: ["YES", "NO"], maker_side: "YES",
    maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: "10000000", taker_options: [], fee_bps: 100, funding_deadline: (Date.now() + 48 * HOUR) * 1e6, resolve_deadline: (Date.now() + 96 * HOUR) * 1e6, settlement_period: 86_400_000_000_000, max_paid_runs: 3,
    referee: w.referee ? { account: w.referee, mode: "Human" } : null },
  status: w.status, taker: w.status === "Open" ? null : w.role === "taker" ? WALLET : "taker.testnet", referee_proposal: w.proposal, created_at: 0, taken_at: null, proposed_at: null, outcome: null, reserve_remaining: "0", bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0,
  fee_min_maker: "500000", fee_min_taker: "500000", tip_maker: "0", tip_taker: "0", storage_maker: "0", runs_used: 0, pending_resolution_request: null, last_resolution_raw: null,
});

async function setup(page: Page, w: World, onRelay?: (w: World, d: { method: string; args: any }) => void) {
  await page.addInitScript((address) => {
    (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => { (window as any).__signs = ((window as any).__signs ?? 0) + 1; return "22".repeat(64); } };
    (window as any).__e2eConfirm = { delayMs: 50, attempts: 4 };
    (window as any).__e2eRegistryUrl = "";
  }, WALLET);
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const reply = (obj: object) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", ...obj }) });
    const ok = (result: unknown) => reply({ result });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (body.method === "tx" || body.method === "EXPERIMENTAL_tx_status") return ok({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { logs: [] } }] });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      let r: unknown = null;
      switch (params.method_name) {
        case "is_paused": case "is_shutdown": r = false; break;
        case "open_offers": r = []; break;
        case "asset_limit": r = { storage_per_kib: "457" }; break;
        case "mt_balance_of": r = "1" + "0".repeat(20); break;
        case "required_challenge_bond": r = null; break;
        case "pending_payouts": r = []; break;
        case "get_bet": r = betJson(w); break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  const relayed: any[] = [];
  await page.route(`${RELAYER}/relay`, async (r) => {
    w.relays++;
    if (w.relayDelayMs) await new Promise((res) => setTimeout(res, w.relayDelayMs));
    if (w.relayFail) return r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "relayer down" }) });
    const sd: any = borsh.deserialize(SCHEMA.SignedDelegate as any, Buffer.from(JSON.parse(r.request().postData() ?? "{}").signedDelegate, "base64"));
    const fc = sd.delegateAction.actions[0].functionCall;
    const d = { receiver: sd.delegateAction.receiverId as string, method: fc.methodName as string, args: JSON.parse(Buffer.from(fc.args).toString("utf8")), deposit: String(fc.deposit) };
    relayed.push(d); onRelay?.(w, d);
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: `TX${w.relays}` }) });
  });
  return relayed;
}
// B1 (UX-37 #4): cancel, concede and "change who decides" are under the collapsed More actions; open it whenever the page has one.
const open = async (page: Page, path = "/bet/7") => {
  await mockUsernames(page); // B1: people are @usernames (registered last so the spec's catch-all route doesn't shadow it)
  await page.goto(path); await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
  if (!path.startsWith("/bet/")) return;
  await expect(page.getByTestId("bet-chip")).toBeVisible();
  if (await page.getByTestId("more-actions").count()) await openMoreActions(page);
};
const dlg = (p: Page) => p.locator("dialog[open]").last();
const signs = (page: Page) => page.evaluate(() => (window as any).__signs ?? 0);
async function noSeriousAxe(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  const r = await new AxeBuilder({ page }).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes[0]?.html?.slice(0, 120)}`)).toEqual([]);
}

const onCancel = (x: World, d: { method: string }) => { if (d.method === "cancel") x.status = "Cancelled"; };
const onAmendNow = (x: World, d: { method: string; args: any }) => { if (d.method === "amend_referee") x.referee = JSON.parse(d.args.new_referee_json)?.account ?? null; };
const onPropose = (x: World, d: { method: string; args: any }) => { if (d.method === "amend_referee") x.proposal = { maker_value: d.args.new_referee_json, taker_value: null }; };
const typeRef = async (page: Page) => { await page.getByTestId("referee-change-input").fill(NEW_REF); await page.getByTestId("referee-change-submit").click(); };

test.describe("MODAL1c4 cancel offer + change referee modals", () => {
  // ---- Cancel offer
  test("cancel: the modal says what is refunded and where, and that there is no fee, before anything is signed; success after get_bet shows Cancelled", async ({ page }) => {
    const w = world();
    const relayed = await setup(page, w, onCancel);
    await open(page);
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.getByTestId("cancel-bet").click();
    const t = dlg(page).getByTestId("cancel-confirm-box");
    await expect(t).toContainText("Cancel this bet and get your money back?");
    await expect(t).toContainText("10 USDC");
    await expect(t).toContainText("Escrow balance");
    await expect(t).toContainText("no fee");
    await expect(page).toHaveURL(/\/bet\/7$/);
    expect(await signs(page)).toBe(0); expect(w.relays).toBe(0);
    await dlg(page).getByTestId("cancel-confirm").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("cancel-result")).toHaveAttribute("data-kind", "cancelled");
    await expect(dlg(page).getByTestId("cancel-result")).toHaveText("Your bet is cancelled and your money is back.");
    await expect(dlg(page).getByTestId("tx-link")).toHaveAttribute("href", /TX1/);
    expect(relayed.map((r) => r.method)).toEqual(["cancel"]);
    expect(relayed[0].args).toEqual({ bet_id: 7 });
    expect(await signs(page)).toBe(1);
    await dlg(page).getByTestId("flow-done").click();
    await expect(page.getByTestId("cancel-result")).toHaveAttribute("data-kind", "cancelled"); // the line stays on the page after Close
  });
  test("cancel: relayer failure -> plain reason, bet still open, Try again then succeeds", async ({ page }) => {
    const w = world(); w.relayFail = true;
    await setup(page, w, onCancel);
    await open(page);
    await page.getByTestId("cancel-bet").click();
    await dlg(page).getByTestId("cancel-confirm").click();
    await expect(dlg(page).getByTestId("flow-failure")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("cancel-result")).toContainText("Your bet is still open");
    w.relayFail = false;
    await dlg(page).getByTestId("flow-retry").click();
    await expect(dlg(page).getByTestId("cancel-confirm-box")).toContainText("10 USDC");
    await dlg(page).getByTestId("cancel-confirm").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
  });
  test("cancel: sent but the bet never shows Cancelled -> pending, never a success", async ({ page }) => {
    await setup(page, world());
    await open(page);
    await page.getByTestId("cancel-bet").click();
    await dlg(page).getByTestId("cancel-confirm").click();
    await expect(dlg(page).getByTestId("flow-pending")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("cancel-result")).toHaveAttribute("data-kind", "pending");
    await expect(dlg(page).getByTestId("flow-success")).toHaveCount(0);
  });
  test("cancel: someone took it first -> failure screen says it is live now", async ({ page }) => {
    await setup(page, world(), (x, d) => { if (d.method === "cancel") x.status = "Taken"; });
    await open(page);
    await page.getByTestId("cancel-bet").click();
    await dlg(page).getByTestId("cancel-confirm").click();
    await expect(dlg(page).getByTestId("flow-failure")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("cancel-result")).toHaveText("Someone took this bet a moment ago. It's live now.");
  });
  test("cancel: Keep it open and Esc close with nothing signed; busy blocks Esc; Back while sending keeps the result; exactly one relay", async ({ page }) => {
    const w = world(); w.relayDelayMs = 1500;
    await setup(page, w, onCancel);
    await open(page, "/browse");
    await page.evaluate(() => { window.history.pushState({}, "", "/bet/7"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await expect(page.getByTestId("bet-page")).toBeVisible();
    await openMoreActions(page); // B1 (UX-37 #4)
    await page.getByTestId("cancel-bet").click();
    await dlg(page).getByTestId("cancel-keep").click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.getByTestId("cancel-bet").click();
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    expect(w.relays).toBe(0); expect(await signs(page)).toBe(0);
    await page.getByTestId("cancel-bet").click();
    await dlg(page).getByTestId("cancel-confirm").click();
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await page.goBack();
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await expect(page).toHaveURL(/\/bet\/7$/);
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    expect(w.relays).toBe(1);
  });

  // ---- Change referee
  test("referee change (maker, Open): modal states who decides, right away, no money moves; one signature; success after get_bet shows it", async ({ page }) => {
    const w = world();
    const relayed = await setup(page, w, onAmendNow);
    await open(page);
    await typeRef(page);
    const t = dlg(page).getByTestId("referee-change-terms");
    // B1: the confirm names people by @username, never by account id
    await expect(t).toContainText("@newref will decide this bet instead of @ref");
    await expect(t).not.toContainText(".testnet");
    await expect(t).toContainText("right away");
    await expect(t).toContainText("no fee");
    expect(await signs(page)).toBe(0); expect(w.relays).toBe(0);
    await dlg(page).getByTestId("referee-change-confirm").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("referee-change-result")).toHaveAttribute("data-kind", "changed");
    await expect(dlg(page).getByTestId("referee-change-result")).toContainText("The referee is now @newref."); // B1: @username
    expect(relayed.map((r) => ({ m: r.method, dep: r.deposit, a: r.args }))).toEqual([{ m: "amend_referee", dep: "0", a: { bet_id: 7, new_referee_json: refValue(NEW_REF) } }]);
    expect(await signs(page)).toBe(1);
    await dlg(page).getByTestId("flow-done").click();
    await expect(page.getByTestId("referee-change-result")).toHaveAttribute("data-kind", "changed");
  });
  test("referee change: relayer failure -> nothing changed, Try again then succeeds", async ({ page }) => {
    const w = world(); w.relayFail = true;
    await setup(page, w, onAmendNow);
    await open(page);
    await typeRef(page);
    await dlg(page).getByTestId("referee-change-confirm").click();
    await expect(dlg(page).getByTestId("flow-failure")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("referee-change-result")).toContainText("Nothing changed");
    w.relayFail = false;
    await dlg(page).getByTestId("flow-retry").click();
    await dlg(page).getByTestId("referee-change-confirm").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
  });
  test("referee change: sent but unseen -> pending, never a success", async ({ page }) => {
    await setup(page, world());
    await open(page);
    await typeRef(page);
    await dlg(page).getByTestId("referee-change-confirm").click();
    await expect(dlg(page).getByTestId("flow-pending")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("flow-success")).toHaveCount(0);
  });
  test("referee change: Cancel and Esc send nothing and keep what was typed; busy blocks Esc; Back while sending keeps the result", async ({ page }) => {
    const w = world(); w.relayDelayMs = 1500;
    await setup(page, w, onAmendNow);
    await open(page, "/browse");
    await page.evaluate(() => { window.history.pushState({}, "", "/bet/7"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await expect(page.getByTestId("bet-page")).toBeVisible();
    await openMoreActions(page); // B1 (UX-37 #4)
    await typeRef(page);
    await dlg(page).getByTestId("referee-change-cancel").click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page.getByTestId("referee-change-input")).toHaveValue(NEW_REF);
    await page.getByTestId("referee-change-submit").click();
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    expect(w.relays).toBe(0); expect(await signs(page)).toBe(0);
    await page.getByTestId("referee-change-submit").click();
    await dlg(page).getByTestId("referee-change-confirm").click();
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await page.goBack();
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await expect(page).toHaveURL(/\/bet\/7$/);
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    expect(w.relays).toBe(1);
  });
  test("referee change after the take: proposing says nothing changes until the other side matches; success is 'proposed'", async ({ page }) => {
    const w = world({ status: "Taken" });
    const relayed = await setup(page, w, onPropose);
    await open(page);
    await typeRef(page);
    await expect(dlg(page).getByTestId("referee-change-terms")).toContainText("Nothing changes until @taker proposes the same"); // B1: @username
    await dlg(page).getByTestId("referee-change-confirm").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("referee-change-result")).toHaveAttribute("data-kind", "proposed");
    expect(relayed[0].args).toEqual({ bet_id: 7, new_referee_json: refValue(NEW_REF) });
  });
  test("referee change: agreeing to the other side's proposal goes through the same confirm", async ({ page }) => {
    const w = world({ status: "Taken", role: "taker", proposal: { maker_value: refValue(NEW_REF), taker_value: null } });
    const relayed = await setup(page, w, (x, d) => { if (d.method === "amend_referee") { x.referee = NEW_REF; x.proposal = { maker_value: null, taker_value: null }; } });
    await open(page);
    await page.getByTestId("referee-agree-btn").click();
    await expect(dlg(page).getByTestId("referee-change-terms")).toContainText("@maker already proposed @newref"); // B1: @username
    expect(w.relays).toBe(0);
    await dlg(page).getByTestId("referee-change-confirm").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("referee-change-result")).toHaveAttribute("data-kind", "changed");
    expect(relayed[0].args).toEqual({ bet_id: 7, new_referee_json: refValue(NEW_REF) });
  });

  // ---- axe + screenshots at 375 / 1280
  const flows = [
    { id: "cancel-offer", start: async (p: Page) => { await p.getByTestId("cancel-bet").click(); }, confirm: "cancel-confirm", mk: () => world(), on: onCancel },
    { id: "change-referee", start: async (p: Page) => { await typeRef(p); }, confirm: "referee-change-confirm", mk: () => world(), on: onAmendNow },
  ];
  for (const [name, size] of [["1280", { width: 1280, height: 900 }], ["375", { width: 375, height: 800 }]] as const) {
    for (const f of flows) {
      test(`${name}px ${f.id}: confirm, failure and success steps have axe 0 serious/critical; screenshots; 375 is a bottom sheet`, async ({ page }) => {
        await page.setViewportSize(size);
        const w = f.mk();
        await setup(page, w, f.on as any);
        await open(page);
        const shot = async (n: string) => { await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)))); await page.screenshot({ path: screenPath(`modal1c4/${f.id}-${n}-${name}.png`) }); };
        await f.start(page);
        await expect(dlg(page).getByTestId("modal-surface")).toHaveAttribute("data-presentation", name === "375" ? "sheet" : "dialog");
        await noSeriousAxe(page); await shot("1-confirm");
        w.relayFail = true;
        await dlg(page).getByTestId(f.confirm).click();
        await expect(dlg(page).getByTestId("flow-failure")).toBeVisible({ timeout: 20_000 });
        await noSeriousAxe(page); await shot("2-failure");
        w.relayFail = false;
        await dlg(page).getByTestId("flow-retry").click();
        await dlg(page).getByTestId(f.confirm).click();
        await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
        await noSeriousAxe(page); await shot("3-success");
      });
    }
  }
});
