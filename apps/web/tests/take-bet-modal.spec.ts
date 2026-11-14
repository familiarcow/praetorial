// MODAL1c2: Take bet as a FlowModal over the bet page. Fully mocked (NEAR RPC, relayer, wallet seam); never a real Privy login.
// M1 (UX-37 #5, UIR1 §3.6): Take is ONE confirm step (5-line ReviewSummary with the referee as @username, pay box, one button);
// REVIEW1's frozen-terms / changed-bet block is unchanged. People come from a mocked username registry.
import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { screenPath } from "./lib/screens";
import nacl from "tweetnacl";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const RELAYER = "http://localhost:8788";
const USDC = "nep141:usdc.testnet";
const FUND_NS = Date.UTC(2037, 0, 2, 3, 4) * 1_000_000;
const RESOLVE_NS = Date.UTC(2037, 0, 5, 3, 4) * 1_000_000;
const REG = "http://registry.e2e.test";
const NAMES: Record<string, string> = { [WALLET]: "me", "maker.testnet": "mia", "ref.testnet": "kim", "mallory.testnet": "mal" };

interface World {
  relays: number; status: string; taker: string | null; referee: string | null; takerAllow: any;
  takeOnRelay: "taken" | "lost" | "none"; txLogs: string[] | null; relayFail: boolean; relayDelayMs: number;
}
const world = (o: Partial<World> = {}): World => ({ relays: 0, status: "Open", taker: null, referee: "ref.testnet", takerAllow: "Any", takeOnRelay: "taken", txLogs: [], relayFail: false, relayDelayMs: 0, ...o });

const betJson = (w: World) => ({
  envelope: { bet_id: 7, version: 1, maker: "maker.testnet", taker_allow: w.takerAllow, terms_hash: "ab".repeat(32), models_snapshot_hash: "cd".repeat(32), terms: null, outcomes: ["YES", "NO"], maker_side: "YES",
    maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: "10000000", taker_options: [], fee_bps: 100, funding_deadline: FUND_NS, resolve_deadline: RESOLVE_NS, settlement_period: 86_400_000_000_000,
    referee: w.referee ? { account: w.referee, mode: "Human" } : null },
  status: w.status, taker: w.taker, created_at: 0, taken_at: null, proposed_at: null, outcome: null, reserve_remaining: "0", bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0, fee_min_taker: "500000",
});

async function setup(page: Page, w: World, opts: { decline?: boolean } = {}) {
  await page.addInitScript(({ address, decline }) => {
    (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => { (window as any).__signs = ((window as any).__signs ?? 0) + 1; if (decline) throw new Error("User rejected the request"); return "22".repeat(64); } };
    (window as any).__e2eConfirm = { delayMs: 50, attempts: 4 };
  }, { address: WALLET, decline: !!opts.decline });
  await page.addInitScript((reg) => { (window as any).__e2eRegistryUrl = reg; }, REG);
  await page.route(`${REG}/**`, (route) => {
    const m = /\/lookup\/account\/([^/?]+)/.exec(new URL(route.request().url()).pathname);
    const name = m ? NAMES[decodeURIComponent(m[1]!)] : undefined;
    return name ? route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ username: name }) })
      : route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" }, body: "not found" });
  });
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const reply = (obj: object) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", ...obj }) });
    const ok = (result: unknown) => reply({ result });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (body.method === "tx" || body.method === "EXPERIMENTAL_tx_status") {
      if (w.txLogs === null) return reply({ error: { name: "UNKNOWN_TRANSACTION", cause: { name: "UNKNOWN_TRANSACTION" } } });
      return ok({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { logs: w.txLogs } }] });
    }
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      const args = JSON.parse(Buffer.from(params.args_base64 ?? "e30=", "base64").toString("utf8") || "{}");
      let r: unknown = null;
      switch (params.method_name) {
        case "is_paused": case "is_shutdown": r = false; break;
        case "open_offers": r = []; break;
        case "asset_limit": r = { storage_per_kib: "457" }; break;
        case "mt_balance_of": r = "1" + "0".repeat(20); break;
        case "required_challenge_bond": r = null; break;
        case "get_bet": r = args.bet_id === 7 ? betJson(w) : null; break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  await page.route(`${RELAYER}/relay`, async (r) => {
    w.relays++;
    if (w.relayDelayMs) await new Promise((res) => setTimeout(res, w.relayDelayMs));
    if (w.relayFail) return r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "relayer down" }) });
    if (w.takeOnRelay === "taken") { w.status = "Taken"; w.taker = WALLET; }
    if (w.takeOnRelay === "lost") { w.status = "Taken"; w.taker = "other.testnet"; }
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: `TX${w.relays}` }) });
  });
}
const open = async (page: Page, path = "/bet/7") => {
  await page.goto(path);
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
};
const dlg = (p: Page) => p.locator("dialog[open]").last();
/** The 5 review lines (C1's ReviewCard summary list; "Full terms" below it has its own rows). */
const five = (p: Page) => dlg(p).getByTestId("review-summary");
const signs = (page: Page) => page.evaluate(() => (window as any).__signs ?? 0);
async function toConfirm(page: Page) {
  await page.getByTestId("take-open").click();
  await expect(dlg(page)).toBeVisible();
  await expect(dlg(page).getByTestId("take-confirm")).toBeVisible();
}
/** M1: confirm on top of cancel; on a phone both full width (stacked); no button text or sheet content cut off or scrolling sideways. */
async function expectSheetFits(page: Page, confirmId: string, cancelId: string, phone: boolean) {
  const ok = dlg(page).getByTestId(confirmId), no = dlg(page).getByTestId(cancelId);
  const a = (await ok.boundingBox())!, b = (await no.boundingBox())!;
  if (phone) {
    expect(a.y + a.height).toBeLessThanOrEqual(b.y + 1); // primary on top
    expect(Math.abs(a.width - b.width)).toBeLessThan(2); // same full width
    const surface = (await dlg(page).getByTestId("modal-surface").boundingBox())!;
    expect(a.width).toBeGreaterThan(surface.width - 48);
  }
  for (const el of [ok, no]) expect(await el.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  expect(await dlg(page).getByTestId("modal-surface").evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
}
async function noSeriousAxe(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  const r = await new AxeBuilder({ page }).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes[0]?.html?.slice(0, 120)}`)).toEqual([]);
}

test.describe("MODAL1c2 take bet flow modal", () => {
  test("Take opens ONE confirm sheet over /bet/:id: 5 lines (referee as @username), pay box, what you can lose; no progress bar", async ({ page }) => {
    await setup(page, world());
    await open(page);
    await expect(page.getByTestId("bet-page")).toBeVisible();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.getByTestId("take-open").click();
    await expect(dlg(page).getByRole("heading", { name: "Take this bet" })).toBeVisible();
    await expect(page).toHaveURL(/\/bet\/7$/);
    await expect(dlg(page).getByTestId("flow-progress")).toHaveCount(0);
    await expect(dlg(page).getByLabel("Steps")).toHaveCount(0);
    await expect(dlg(page).getByTestId("take-next")).toHaveCount(0);
    const terms = dlg(page).getByTestId("take-terms");
    // The same 5 lines as create (C1's ReviewCard, take variant), the referee as @username.
    await expect(terms.getByTestId("review-card")).toHaveAttribute("data-variant", "take");
    await expect(five(page).locator("dd[data-row]")).toHaveCount(5);
    await expect(terms.getByTestId("review-stakes")).toHaveText("You put in 10.00 USDC · they put in 10.00 USDC");
    await expect(terms.getByTestId("review-decider")).toHaveText("@kim, a person (no AI)");
    await expect(terms).not.toContainText("ref.testnet"); // PEOPLE RULE
    const c = dlg(page).getByTestId("take-confirm-summary");
    await expect(c.locator('dd[data-row="pay-now"]')).toContainText("10.00 USDC (+");
    await expect(c.locator('dd[data-row="fee"]')).toHaveText("0.50 USDC, taken from your stake only if someone wins");
    await expect(c).not.toContainText("Referee tip");
    await expect(terms.getByTestId("take-lose")).toContainText("10.00 USDC");
    await dlg(page).getByTestId("take-tip-checkbox").check();
    await expect(c.locator('dd[data-row="tip"]')).toHaveText("0.50 USDC, out of your stake");
    await expect(dlg(page).getByTestId("review-term-tip")).toContainText("out of your 10.00 USDC stake. It is not added on top."); // C1: Full terms row, lib/money
    await expect(dlg(page).getByTestId("take-lose")).toContainText("out of that stake, not on top");
  });

  test("Cancel closes the sheet and throws the draft away: reopening starts clean", async ({ page }) => {
    await setup(page, world());
    await open(page);
    await page.getByTestId("take-open").click();
    await dlg(page).getByTestId("take-tip-checkbox").check();
    await dlg(page).getByTestId("take-cancel").click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.reload();
    await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.getByTestId("take-open").click();
    await expect(dlg(page).getByTestId("take-tip-checkbox")).not.toBeChecked();
  });

  test("happy path: one signature, one relay, success screen with the TxLink; the bet page then shows it taken", async ({ page }) => {
    const w = world();
    await setup(page, w);
    await open(page);
    await toConfirm(page);
    await dlg(page).getByTestId("take-confirm").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("take-result")).toHaveAttribute("data-kind", "taken");
    await expect(dlg(page).getByTestId("take-result")).toContainText("You took this bet");
    await expect(dlg(page).getByTestId("tx-link")).toHaveAttribute("href", /TX1/);
    expect(w.relays).toBe(1);
    expect(await signs(page)).toBe(1);
    await dlg(page).getByTestId("flow-done").click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page.getByTestId("bet-status")).toHaveText("Taken", { timeout: 10_000 });
  });

  test("relayer failure: plain reason, nothing taken, Try again returns to the confirm step with the tip kept", async ({ page }) => {
    const w = world({ relayFail: true });
    await setup(page, w);
    await open(page);
    await page.getByTestId("take-open").click();
    await dlg(page).getByTestId("take-tip-checkbox").check();
    await dlg(page).getByTestId("take-confirm").click();
    await expect(dlg(page).getByTestId("flow-failure")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("flow-failure")).toContainText("Nothing was taken and no money moved.");
    await dlg(page).getByTestId("flow-retry").click();
    await expect(dlg(page).getByTestId("take-confirm")).toBeEnabled();
    await expect(dlg(page).getByTestId("take-confirm-summary")).toContainText("Referee tip");
    w.relayFail = false;
    await dlg(page).getByTestId("take-confirm").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
  });

  test("on-chain receipt failure (contract refused): plain reason with the refund, Try again keeps state", async ({ page }) => {
    const w = world({ takeOnRelay: "none", txLogs: ["take_rejected reason=referee_ack does not match the bet's referee"] });
    await setup(page, w);
    await open(page);
    await toConfirm(page);
    await dlg(page).getByTestId("take-confirm").click();
    await expect(dlg(page).getByTestId("flow-failure")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("take-result")).toHaveAttribute("data-kind", "refused");
    await expect(dlg(page).getByTestId("take-result")).toContainText("The contract refused this take: the referee on this bet changed");
    await expect(dlg(page).getByTestId("take-result")).toContainText("Your money was returned.");
    await dlg(page).getByTestId("flow-retry").click();
    await expect(dlg(page).getByTestId("take-confirm")).toBeEnabled();
  });

  test("someone else took it first: failure screen with the honest message, not a success", async ({ page }) => {
    await setup(page, world({ takeOnRelay: "lost" }));
    await open(page);
    await toConfirm(page);
    await dlg(page).getByTestId("take-confirm").click();
    await expect(dlg(page).getByTestId("flow-failure")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("take-result")).toHaveAttribute("data-kind", "lost");
    await expect(dlg(page).getByTestId("take-result")).toContainText("Someone else took this bet first");
  });

  test("wallet declined: plain message, nothing sent, Try again", async ({ page }) => {
    const w = world();
    await setup(page, w, { decline: true });
    await open(page);
    await toConfirm(page);
    await dlg(page).getByTestId("take-confirm").click();
    await expect(dlg(page).getByTestId("take-result")).toHaveAttribute("data-kind", "declined");
    await expect(dlg(page).getByTestId("take-result")).toHaveText("You cancelled. Nothing was sent.");
    expect(w.relays).toBe(0);
    await dlg(page).getByTestId("flow-retry").click();
    await expect(dlg(page).getByTestId("take-confirm")).toBeEnabled();
  });

  test("race guard: the terms changed after the page loaded -> error on the confirm step, nothing signed, modal stays", async ({ page }) => {
    const w = world();
    await setup(page, w);
    await open(page);
    await toConfirm(page);
    w.referee = "evil.testnet";
    await dlg(page).getByTestId("take-confirm").click();
    await expect(dlg(page).getByTestId("take-error")).toContainText(/referee changed/i);
    expect(w.relays).toBe(0);
    expect(await signs(page)).toBe(0);
    await expect(dlg(page).getByTestId("take-confirm")).toBeEnabled();
  });

  test("close mid-flow asks Discard; Keep editing stays, Discard closes; a closed flow can be reopened clean", async ({ page }) => {
    await setup(page, world());
    await open(page);
    await toConfirm(page);
    // M1: one step, nothing entered yet -> nothing to discard, Esc just closes.
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await toConfirm(page);
    await dlg(page).getByTestId("take-tip-checkbox").check(); // now there is something to lose
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("discard-keep")).toBeVisible();
    await page.getByTestId("discard-keep").click();
    await expect(dlg(page).getByTestId("take-confirm")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByTestId("discard-confirm").click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page.getByTestId("bet-page")).toBeVisible();
    await page.getByTestId("take-open").click();
    await expect(dlg(page).getByTestId("take-terms")).toBeVisible();
  });

  test("busy blocks close: Esc, the Close button and Back do nothing while the send is in flight", async ({ page }) => {
    const w = world({ relayDelayMs: 1500 });
    await setup(page, w);
    await open(page);
    await toConfirm(page);
    await dlg(page).getByTestId("take-confirm").click();
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await expect(dlg(page).getByTestId("modal-close")).toBeDisabled();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    expect(w.relays).toBe(1);
  });

  test("browser Back while sending keeps the result screen; exactly one relay call", async ({ page }) => {
    const w = world({ relayDelayMs: 1500 });
    await setup(page, w);
    await open(page, "/browse");
    await page.evaluate(() => { window.history.pushState({}, "", "/bet/7"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await expect(page.getByTestId("bet-page")).toBeVisible();
    await toConfirm(page);
    await dlg(page).getByTestId("take-confirm").click();
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await page.goBack();
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await expect(page).toHaveURL(/\/bet\/7$/);
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("tx-link")).toHaveAttribute("href", /TX1/);
    expect(w.relays).toBe(1);
  });

  test("invite-only bet: the invite link opens the same flow and the take goes through", async ({ page }) => {
    // A real maker-signed invite for this wallet (same message the contract checks).
    const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5));
    const sig = Buffer.from(nacl.sign.detached(new TextEncoder().encode(`praetorial:invite:v1:7:${WALLET}`), kp.secretKey)).toString("hex");
    const w = world({ takerAllow: { InvitePubkey: Buffer.from(kp.publicKey).toString("hex") } });
    await setup(page, w);
    await open(page, `/bet/7?invite=${sig}`);
    await toConfirm(page);
    await dlg(page).getByTestId("take-confirm").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    expect(w.relays).toBe(1);
  });

  for (const [name, size] of [["1280", { width: 1280, height: 900 }], ["375", { width: 375, height: 800 }]] as const) {
    test(`${name}px: the one take sheet and its result have axe 0 serious/critical; screenshots; 375 is a bottom sheet, buttons stacked, nothing cut off`, async ({ page }) => {
      await page.setViewportSize(size);
      await setup(page, world());
      await open(page);
      const shot = async (n: string) => { await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)))); await page.screenshot({ path: screenPath(`m1/take-${n}-${name}.png`) }); };
      await page.getByTestId("take-open").click();
      await expect(dlg(page).getByTestId("modal-surface")).toHaveAttribute("data-presentation", name === "375" ? "sheet" : "dialog");
      await dlg(page).getByTestId("take-tip-checkbox").check();
      await noSeriousAxe(page); await shot("1-confirm");
      await expectSheetFits(page, "take-confirm", "take-cancel", name === "375");
      await dlg(page).getByTestId("take-confirm").click();
      await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
      await noSeriousAxe(page); await shot("2-success");
    });
  }
});

// REVIEW1 (#3, SM1 CRT-5): the take is checked against what the user reviewed when the modal opened, not against BetPage's 15 s poll.
test.describe("REVIEW1 take: freeze what was reviewed", () => {
  test("the one confirm step names the referee the user is agreeing to (as @username)", async ({ page }) => {
    await setup(page, world());
    await open(page);
    await toConfirm(page);
    await expect(five(page).getByTestId("review-decider")).toHaveText("@kim, a person (no AI)");
  });

  test("#3 CRT-5: the maker swaps the referee after the modal opened and the page's poll picks it up -> the take is blocked, the change is shown, nothing is signed", async ({ page }) => {
    test.setTimeout(60_000);
    const w = world();
    await setup(page, w);
    await open(page);
    await toConfirm(page);
    w.referee = "mallory.testnet"; // amend_referee on the untaken offer
    // BetPage re-reads the bet every 15 s; after that the live bet has the new referee.
    await expect(dlg(page).getByTestId("take-changed")).toContainText("Referee: ref.testnet -> mallory.testnet", { timeout: 25_000 });
    await expect(five(page).getByTestId("review-decider")).toHaveText("@kim, a person (no AI)"); // still what was reviewed
    await expect(dlg(page).getByTestId("take-confirm")).toBeDisabled();
    await page.waitForTimeout(500);
    expect(await signs(page)).toBe(0);
    expect(w.relays).toBe(0);
  });
});
