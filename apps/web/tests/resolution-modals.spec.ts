// MODAL1c3: resolution flows as modals over /bet/:id: request result, challenge (bond up front), concede, referee ruling.
// Fully mocked (NEAR RPC, relayer, wallet seam); never a real Privy login. Mutual settle is not built: the contract has none (D-SETTLE3), see the commit body.
import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { openMoreActions } from "./lib/betPage";
import { SCHEMA, decodeSignedTransaction } from "@near-js/transactions";
import * as borsh from "borsh";
import { screenPath } from "./lib/screens";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const RELAYER = "http://localhost:8788";
const USDC = "nep141:usdc.testnet";
const HOUR = 3_600_000;
const TERMS = JSON.stringify({ claim: "BTC closes above 100k", sources_allowed: [{ id: "S_CB", publisher: "Coinbase BTC-USD", url: "https://coinbase.example/btc" }] });

interface World { role: "maker" | "taker" | "referee"; ai: boolean; status: string; outcome: string | null; bonds: number; ageNs: number; fundMs: number; resolveMs: number; pendingReq: boolean; balance: string; relays: number; relayFail: boolean; relayDelayMs: number }
const world = (o: Partial<World> = {}): World => ({ role: "taker", ai: true, status: "Taken", outcome: null, bonds: 0, ageNs: 60_000_000_000, fundMs: Date.now() - HOUR, resolveMs: Date.now() + 48 * HOUR, pendingReq: false, balance: "1" + "0".repeat(20), relays: 0, relayFail: false, relayDelayMs: 0, ...o });
const betJson = (w: World) => ({
  envelope: { bet_id: 7, version: 1, maker: w.role === "maker" ? WALLET : "maker.testnet", taker_allow: "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "cd".repeat(32), terms: w.ai ? TERMS : JSON.stringify({ claim: "Team A wins" }), outcomes: ["YES", "NO"], maker_side: "YES",
    maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: "10000000", taker_options: [], fee_bps: 100, funding_deadline: w.fundMs * 1e6, resolve_deadline: w.resolveMs * 1e6, settlement_period: 86_400_000_000_000, max_paid_runs: 3,
    referee: w.ai ? null : { account: w.role === "referee" ? WALLET : "ref.testnet", mode: "Human" } },
  status: w.status, taker: w.role === "taker" ? WALLET : "taker.testnet", created_at: 0, taken_at: null, proposed_at: w.outcome ? Date.now() * 1e6 - w.ageNs : null, outcome: w.outcome, reserve_remaining: "0",
  bonds: Array.from({ length: w.bonds }, (_, i) => ({ holder: "x", amount: "1", round: i + 1, pre_challenge_outcome: "YES", asset: USDC })), exhibits: [], challenged_by: null, window_extension_ns: 0,
  fee_min_maker: "500000", fee_min_taker: "500000", tip_maker: "0", tip_taker: "0", runs_used: 0, pending_resolution_request: w.pendingReq ? {} : null, last_resolution_raw: null,
});

async function setup(page: Page, w: World, onRelay?: (w: World, d: { receiver: string; method: string; args: any; deposit: string }) => void) {
  await page.addInitScript((address) => {
    (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => { (window as any).__signs = ((window as any).__signs ?? 0) + 1; return "22".repeat(64); } };
    (window as any).__e2eConfirm = { delayMs: 50, attempts: 4 };
  }, WALLET);
  const direct: any[] = [];
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const reply = (obj: object) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", ...obj }) });
    const ok = (result: unknown) => reply({ result });
    if (body.method === "block") return ok({ header: { height: 100, hash: "FDM3JkqRhGKqxqDqJm7cnzT1LgzDn3dHjkh8gCgV2tHB" } });
    if (body.method === "send_tx" && w.relayFail) return reply({ error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" } } });
    if (body.method === "send_tx") {
      // RELAYDEP1 / D-RELAYDEP1: deposit-bearing calls are the user's own transaction, broadcast straight to the RPC.
      const st = decodeSignedTransaction(Buffer.from(params.signed_tx_base64, "base64")); const fc = st.transaction.actions[0].functionCall!;
      const d = { receiver: st.transaction.receiverId, method: fc.methodName, args: JSON.parse(Buffer.from(fc.args).toString("utf8")), deposit: String(fc.deposit), signer: st.transaction.signerId };
      (direct as any[]).push(d); w.relays++; onRelay?.(w, d);
      return ok({ status: { SuccessValue: "" }, transaction: { hash: `TX${w.relays}` }, receipts_outcome: [] });
    }
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      let r: unknown = null;
      switch (params.method_name) {
        case "is_paused": case "is_shutdown": r = false; break;
        case "open_offers": r = []; break;
        case "asset_limit": r = { storage_per_kib: "457" }; break;
        case "mt_balance_of": r = w.balance; break;
        case "required_challenge_bond": r = w.bonds >= 2 ? null : { amount: ["4000000", "8000000"][w.bonds], asset: USDC }; break;
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
  return Object.assign(relayed, { direct });
}
// B1 (UX-37 #4): cancel, concede and "change who decides" are under the collapsed More actions; open it whenever the page has one.
const open = async (page: Page, path = "/bet/7") => {
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

const requestWorld = () => world({ status: "Taken" });
const challengeWorld = () => world({ status: "Proposed", outcome: "YES" });
const concedeWorld = () => world({ status: "Taken" });
const ruleWorld = () => world({ role: "referee", ai: false, status: "Taken" });
const onRequest = (x: World, d: { method: string }) => { if (d.method === "request_resolution") x.pendingReq = true; };
const onChallenge = (x: World, d: { method: string }) => { if (d.method === "mt_transfer_call") { x.bonds++; x.status = "Challenged"; } };
const onConcede = (x: World, d: { method: string }) => { if (d.method === "concede") { x.status = "Finalized"; x.outcome = "YES"; } };
const onRule = (x: World, d: { method: string }) => { if (d.method === "referee_rule") { x.status = "Finalized"; x.outcome = "YES"; } };

test.describe("MODAL1c3 resolution flow modals", () => {
  // ---- Request result (AI judge)
  test("request result: modal states the exact NEAR deposit and the refund rule before anything is signed; success after the contract shows the request", async ({ page }) => {
    const w = requestWorld();
    const relayed = await setup(page, w, onRequest);
    await open(page);
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.getByTestId("request-result-btn").click();
    const t = dlg(page).getByTestId("request-result-terms");
    await expect(t).toContainText(/\d+(\.\d+)? NEAR/);
    await expect(t).toContainText("from your wallet");
    await expect(t).toContainText("refunded");
    await expect(page).toHaveURL(/\/bet\/7$/);
    expect(await signs(page)).toBe(0);
    await dlg(page).getByTestId("request-result-confirm").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("request-result-result")).toHaveAttribute("data-kind", "requested");
    await expect(dlg(page).getByTestId("tx-link")).toHaveAttribute("href", /TX1/);
    // D-RELAYDEP1 (supersedes "the relayer carries the request_resolution bond"): the user signs and pays the bond, nothing is relayed.
    expect(relayed.length).toBe(0);
    expect(relayed.direct.map((r) => r.method)).toEqual(["request_resolution"]);
    expect(relayed.direct[0].signer).toBe(WALLET);
    expect(BigInt(relayed.direct[0].deposit) >= 20_062_500_000_000_000_000_000n).toBe(true);
    expect(await signs(page)).toBe(1);
  });
  test("request result: relayer failure -> plain reason, nothing sent, Try again then succeeds", async ({ page }) => {
    const w = requestWorld(); w.relayFail = true;
    await setup(page, w, onRequest);
    await open(page);
    await page.getByTestId("request-result-btn").click();
    await dlg(page).getByTestId("request-result-confirm").click();
    await expect(dlg(page).getByTestId("flow-failure")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("request-result-result")).toContainText("Nothing was sent");
    w.relayFail = false;
    await dlg(page).getByTestId("flow-retry").click();
    await dlg(page).getByTestId("request-result-confirm").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
  });
  test("request result: Cancel and Esc close with nothing signed; the button is still there", async ({ page }) => {
    const w = requestWorld();
    await setup(page, w, onRequest);
    await open(page);
    await page.getByTestId("request-result-btn").click();
    await dlg(page).getByTestId("request-result-cancel").click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.getByTestId("request-result-btn").click();
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    expect(w.relays).toBe(0); expect(await signs(page)).toBe(0);
    await expect(page.getByTestId("request-result-btn")).toBeVisible();
  });

  // ---- Challenge
  test("challenge: the bond (amount, asset, round) is shown before the confirm; one signature; success", async ({ page }) => {
    const w = challengeWorld();
    const relayed = await setup(page, w, onChallenge);
    await open(page);
    await page.getByTestId("challenge-btn").click();
    const t = dlg(page).getByTestId("challenge-terms");
    await expect(t).toContainText("Round 1: Review");
    await expect(t).toContainText("4 USDC");
    await expect(t).toContainText("back if you win"); // M1: the bond row (amount in the body, short button)
    await expect(dlg(page).getByTestId("challenge-confirm")).toHaveText("Post bond & challenge");
    await expect(dlg(page).getByTestId("flow-progress")).toHaveCount(0); // one step: no progress bar
    expect(await signs(page)).toBe(0); expect(w.relays).toBe(0);
    await dlg(page).getByTestId("challenge-confirm").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("challenge-result")).toContainText("Your challenge is in");
    expect(relayed[0].method).toBe("mt_transfer_call");
    expect(relayed[0].args.amount).toBe("4000000");
    expect(JSON.parse(relayed[0].args.msg)).toEqual({ kind: "Bond", bet_id: 7, round: 1 });
  });
  // M1 (SM2 B1-9): the shortfall is gate("challenge", {short}): the sheet stays open with the exact missing amount and Add money.
  test("challenge: not enough balance for the bond -> the gate names what is missing with Add money, nothing sent; after topping up it goes through", async ({ page }) => {
    const w = challengeWorld(); w.balance = "1000000";
    await setup(page, w, onChallenge);
    await open(page);
    await page.getByTestId("challenge-btn").click();
    await dlg(page).getByTestId("challenge-confirm").click();
    const g = dlg(page).getByTestId("challenge-gate");
    await expect(g).toHaveAttribute("data-gate", "short", { timeout: 20_000 });
    await expect(g).toContainText("You need 3.00 USDC more in your betting balance to do this.");
    await expect(g.getByTestId("gate-fix-add-money")).toBeVisible();
    await expect(dlg(page).getByTestId("challenge-confirm")).toBeDisabled();
    await expect(dlg(page).getByTestId("flow-failure")).toHaveCount(0);
    expect(w.relays).toBe(0); expect(await signs(page)).toBe(0);
    // Topped up elsewhere: closing and reopening the sheet starts clean, and the challenge goes through.
    w.balance = "1" + "0".repeat(20);
    await dlg(page).getByTestId("challenge-cancel").click();
    await page.getByTestId("challenge-btn").click();
    await expect(dlg(page).getByTestId("challenge-terms")).toContainText("4 USDC");
    await dlg(page).getByTestId("challenge-confirm").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
  });
  test("challenge: relayer failure -> failure screen, no result claimed; Cancel closes with nothing sent", async ({ page }) => {
    const w = challengeWorld(); w.relayFail = true;
    await setup(page, w, onChallenge);
    await open(page);
    await page.getByTestId("challenge-btn").click();
    await dlg(page).getByTestId("challenge-confirm").click();
    await expect(dlg(page).getByTestId("flow-failure")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("challenge-refusal")).toContainText("no money moved");
    await dlg(page).getByTestId("flow-done").click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.getByTestId("challenge-btn").click();
    await dlg(page).getByTestId("challenge-cancel").click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
  });

  // ---- Concede
  test("concede: terms name who is paid, the exact payout and fee, and that it cannot be undone; success only once get_bet shows it", async ({ page }) => {
    const w = concedeWorld();
    const relayed = await setup(page, w, onConcede);
    await open(page);
    await page.getByTestId("concede-btn").click();
    const t = dlg(page).getByTestId("concede-terms");
    await expect(t).toContainText("Unnamed account is paid"); // M1 (PEOPLE RULE): no name in the registry -> never the raw id
    await expect(t).not.toContainText("maker.testnet");
    await expect(t).toContainText("19 USDC");
    await expect(dlg(page).getByTestId("concede-confirm")).toHaveText("Concede");
    await expect(t).toContainText("1 USDC");
    await expect(t).toContainText("cannot be undone");
    expect(await signs(page)).toBe(0);
    await dlg(page).getByTestId("concede-confirm").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("concede-result")).toHaveAttribute("data-kind", "conceded");
    await expect(dlg(page).getByTestId("concede-result")).toContainText("You conceded");
    expect(relayed.map((r) => r.method)).toEqual(["concede"]);
    expect(await signs(page)).toBe(1);
    await dlg(page).getByTestId("flow-done").click();
    await expect(page.getByTestId("concede-result")).toHaveAttribute("data-kind", "conceded"); // the line stays on the page after Close
  });
  // REVIEW1 (SM1 LIFE-11): the concede modal re-reads the bet right before signing; a ruling that landed meanwhile stops it.
  test("LIFE-11: a ruling lands after the concede modal opened -> nothing is signed or sent, the change is named", async ({ page }) => {
    const w = concedeWorld();
    const relayed = await setup(page, w, onConcede);
    await open(page);
    await page.getByTestId("concede-btn").click();
    await expect(dlg(page).getByTestId("concede-terms")).toContainText("cannot be undone");
    w.status = "Proposed"; w.outcome = "NO"; // the AI ruled for me (taker = NO) before I pressed Concede
    await dlg(page).getByTestId("concede-confirm").click();
    await expect(dlg(page).getByTestId("flow-failure")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("concede-result")).toContainText("This bet changed since you opened this");
    await expect(dlg(page).getByTestId("concede-result")).toContainText("Nothing was conceded");
    expect(relayed.map((r) => r.method)).toEqual([]);
    expect(await signs(page)).toBe(0);
  });
  test("concede: sent but the contract did not decide -> pending screen, never a success", async ({ page }) => {
    await setup(page, concedeWorld());
    await open(page);
    await page.getByTestId("concede-btn").click();
    await dlg(page).getByTestId("concede-confirm").click();
    await expect(dlg(page).getByTestId("flow-pending")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("concede-result")).toHaveAttribute("data-kind", "pending");
    await expect(dlg(page).getByTestId("concede-result")).not.toContainText("You conceded");
  });
  test("concede: relayer failure -> plain reason, Try again", async ({ page }) => {
    const w = concedeWorld(); w.relayFail = true;
    await setup(page, w, onConcede);
    await open(page);
    await page.getByTestId("concede-btn").click();
    await dlg(page).getByTestId("concede-confirm").click();
    await expect(dlg(page).getByTestId("flow-failure")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("concede-result")).toContainText("Nothing was conceded");
    w.relayFail = false;
    await dlg(page).getByTestId("flow-retry").click();
    await dlg(page).getByTestId("concede-confirm").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
  });
  test("concede: Cancel signs and sends nothing; busy blocks Esc; browser Back while sending keeps the result; exactly one relay", async ({ page }) => {
    const w = concedeWorld(); w.relayDelayMs = 1500;
    await setup(page, w, onConcede);
    await open(page, "/browse");
    await page.evaluate(() => { window.history.pushState({}, "", "/bet/7"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await expect(page.getByTestId("bet-page")).toBeVisible();
    await openMoreActions(page); // B1 (UX-37 #4)
    await page.getByTestId("concede-btn").click();
    await dlg(page).getByTestId("concede-cancel").click();
    expect(w.relays).toBe(0); expect(await signs(page)).toBe(0);
    await page.getByTestId("concede-btn").click();
    await dlg(page).getByTestId("concede-confirm").click();
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await page.goBack();
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await expect(page).toHaveURL(/\/bet\/7$/);
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    expect(w.relays).toBe(1);
  });

  // ---- Referee ruling
  test("referee ruling: modal confirm names who is paid and the exact amount; one signature; success", async ({ page }) => {
    const w = ruleWorld();
    const relayed = await setup(page, w, onRule);
    await open(page);
    await page.getByTestId("referee-btn-YES").click();
    await expect(dlg(page).getByTestId("referee-confirm-text")).toHaveText("You're ruling YES: Unnamed account wins 19 USDC."); // M1: PEOPLE RULE
    await expect(dlg(page).getByTestId("referee-terms-risk")).toHaveText("This pays out immediately and can't be changed or challenged.");
    await expect(dlg(page).getByTestId("referee-terms")).toContainText("1 USDC");
    expect(await signs(page)).toBe(0);
    await dlg(page).getByTestId("referee-confirm-btn").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("referee-result")).toContainText("Done. Unnamed account has been paid.");
    expect(relayed[0].method).toBe("referee_rule");
    expect(relayed[0].args).toEqual({ bet_id: 7, outcome: "YES" });
  });
  test("referee ruling: relayer failure -> failure, nothing paid, Try again; Cancel sends nothing", async ({ page }) => {
    const w = ruleWorld(); w.relayFail = true;
    await setup(page, w, onRule);
    await open(page);
    await page.getByTestId("referee-btn-NO").click();
    await dlg(page).getByTestId("referee-cancel-btn").click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    expect(w.relays).toBe(0);
    await page.getByTestId("referee-btn-NO").click();
    await dlg(page).getByTestId("referee-confirm-btn").click();
    await expect(dlg(page).getByTestId("flow-failure")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("referee-result")).toContainText("no money moved");
    w.relayFail = false;
    await dlg(page).getByTestId("flow-retry").click();
    await dlg(page).getByTestId("referee-confirm-btn").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
  });

  // ---- axe + screenshots at 375 / 1280
  const flows = [
    { id: "request-result", open: "request-result-btn", confirm: "request-result-confirm", cancel: "request-result-cancel", label: "Request the result", danger: false, mk: requestWorld, on: onRequest },
    { id: "challenge", open: "challenge-btn", confirm: "challenge-confirm", cancel: "challenge-cancel", label: "Post bond & challenge", danger: false, mk: challengeWorld, on: onChallenge },
    { id: "concede", open: "concede-btn", confirm: "concede-confirm", cancel: "concede-cancel", label: "Concede", danger: true, mk: concedeWorld, on: onConcede },
    { id: "referee", open: "referee-btn-YES", confirm: "referee-confirm-btn", cancel: "referee-cancel-btn", label: "Confirm YES", danger: true, mk: ruleWorld, on: onRule },
  ];
  for (const [name, size] of [["1280", { width: 1280, height: 900 }], ["375", { width: 375, height: 800 }]] as const) {
    for (const f of flows) {
      test(`${name}px ${f.id}: confirm and result steps have axe 0 serious/critical; screenshots; 375 is a bottom sheet; M1 ConfirmSheet layout`, async ({ page }) => {
        await page.setViewportSize(size);
        await setup(page, f.mk(), f.on as any);
        await open(page);
        const shot = async (n: string) => { await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)))); await page.screenshot({ path: screenPath(`m1/${f.id}-${n}-${name}.png`) }); };
        await page.getByTestId(f.open).click();
        await expect(dlg(page).getByTestId("modal-surface")).toHaveAttribute("data-presentation", name === "375" ? "sheet" : "dialog");
        // M1 (UIR1 §3.6): one step = no progress bar / step list; short label; primary on top and both full width on a phone;
        // nothing cut off; the danger confirm is the filled high-contrast button.
        await expect(dlg(page).getByTestId("flow-progress")).toHaveCount(0);
        await expect(dlg(page).getByLabel("Steps")).toHaveCount(0);
        await expect(dlg(page).getByTestId(f.confirm)).toHaveText(f.label);
        const ok = (await dlg(page).getByTestId(f.confirm).boundingBox())!, no = (await dlg(page).getByTestId(f.cancel).boundingBox())!;
        if (name === "375") {
          expect(ok.y + ok.height).toBeLessThanOrEqual(no.y + 1);
          expect(Math.abs(ok.width - no.width)).toBeLessThan(2);
          expect(ok.width).toBeGreaterThan(375 - 64);
        } else {
          expect(Math.abs(ok.y - no.y)).toBeLessThan(2); // side by side on a wide screen
        }
        for (const id of [f.confirm, f.cancel]) expect(await dlg(page).getByTestId(id).evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
        expect(await dlg(page).getByTestId("modal-surface").evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        if (f.danger) {
          const bg = await dlg(page).getByTestId(f.confirm).evaluate((e) => getComputedStyle(e).backgroundColor);
          const errBg = await dlg(page).getByTestId(f.confirm).evaluate(() => { const d = document.createElement("span"); d.style.color = "var(--color-error)"; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; });
          expect(bg).toBe(errBg);
        }
        await noSeriousAxe(page); await shot("1-confirm");
        await dlg(page).getByTestId(f.confirm).click();
        await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
        await noSeriousAxe(page); await shot("2-success");
      });
    }
  }
});
