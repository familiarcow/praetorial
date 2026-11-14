// MODAL1c5: username setup / change, Add money (move to betting balance) and Withdraw as modals. Fully mocked: NEAR RPC, relayer, registry,
// wallet seam (window.__e2eTestWallet); never a real Privy login.
import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { SCHEMA } from "@near-js/transactions";
import * as borsh from "borsh";
import { screenPath } from "./lib/screens";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const RELAYER = "http://localhost:8788";
const REG = "http://registry.e2e.test";
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST" };

interface World { username: string | null; claimStatus: number; claimDelayMs: number; claims: any[]; intents: bigint; wallet: bigint; native: bigint; relays: string[]; relayFail: boolean; relayDelayMs: number }
const world = (o: Partial<World> = {}): World => ({ username: "alice", claimStatus: 200, claimDelayMs: 0, claims: [], intents: 20_000_000n, wallet: 0n, native: 0n, relays: [], relayFail: false, relayDelayMs: 0, ...o });

async function setup(page: Page, w: World) {
  await page.addInitScript(({ address, reg }) => {
    (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => { (window as any).__signs = ((window as any).__signs ?? 0) + 1; return "22".repeat(64); } };
    (window as any).__e2eRegistryUrl = reg;
  }, { address: WALLET, reg: REG });
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (body.method === "tx" || body.method === "EXPERIMENTAL_tx_status") return ok({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { logs: [] } }] });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: w.native.toString() });
    if (params.request_type === "call_function") {
      const a = JSON.parse(Buffer.from(params.args_base64 ?? "", "base64").toString() || "{}");
      let r: unknown = null;
      switch (params.method_name) {
        case "is_paused": case "is_shutdown": r = false; break;
        case "open_offers": r = []; break;
        case "mt_balance_of": r = a.token_id === "nep141:usdc.testnet" ? w.intents.toString() : "0"; break;
        case "ft_balance_of": r = params.account_id === "usdc.testnet" ? w.wallet.toString() : "0"; break;
        case "storage_balance_of": r = { total: "1250000000000000000000", available: "0" }; break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  await page.route(`${RELAYER}/relay`, async (r) => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: cors });
    if (w.relayDelayMs) await new Promise((res) => setTimeout(res, w.relayDelayMs));
    if (w.relayFail) return r.fulfill({ status: 500, contentType: "application/json", headers: cors, body: JSON.stringify({ ok: false, error: "relayer down" }) });
    const sd: any = borsh.deserialize(SCHEMA.SignedDelegate as any, Buffer.from(JSON.parse(r.request().postData() ?? "{}").signedDelegate, "base64"));
    const fc = sd.delegateAction.actions[0].functionCall;
    const method = fc.methodName as string; const args = JSON.parse(Buffer.from(fc.args).toString("utf8"));
    w.relays.push(method);
    if (method === "ft_transfer_call") { w.intents += w.wallet; w.wallet = 0n; }
    if (method === "ft_withdraw") { w.intents -= BigInt(args.amount); w.wallet += BigInt(args.amount); }
    return r.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ ok: true, txHash: `TX${w.relays.length}` }) });
  });
  await page.route(`${REG}/**`, async (route) => {
    const req = route.request(); const url = new URL(req.url());
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (url.pathname.startsWith("/lookup/account/")) return w.username ? json(200, { username: w.username }) : json(404, { error: "not_found" });
    if (url.pathname === "/search") return json(200, []);
    if (url.pathname === "/claim") {
      const b = JSON.parse(req.postData() ?? "{}"); w.claims.push(b);
      if (w.claimDelayMs) await new Promise((res) => setTimeout(res, w.claimDelayMs));
      if (w.claimStatus !== 200) return json(w.claimStatus, { error: "internal" });
      w.username = b.username;
      return json(200, { username: b.username, account_id: WALLET });
    }
    return json(404, {});
  });
}
const open = async (page: Page, path: string) => { await page.goto(path); await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 }); };
const dlg = (p: Page) => p.locator("dialog[open]").last();
const signs = (page: Page) => page.evaluate(() => (window as any).__signs ?? 0);
async function noSeriousAxe(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  // CS1: axe samples colours as rendered; a kit Button that just became enabled fades in from opacity 0.5. Let finite running
  // transitions end first (a half-faded label read as low contrast under load). The assertion below is unchanged.
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  const r = await new AxeBuilder({ page }).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes[0]?.html?.slice(0, 120)}`)).toEqual([]);
}
const claimName = async (page: Page, name: string) => { await dlg(page).getByTestId("username-input").fill(name); await expect(dlg(page).getByTestId("username-status")).toContainText("available"); await dlg(page).getByTestId("username-claim-btn").click(); };
const pushRoute = async (page: Page, path: string) => { await page.evaluate((p) => { window.history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, path); };
const openWithdraw = async (page: Page, amount?: string) => {
  await page.getByTestId("asset-row-USDC").click(); // F3: Cash out to my NEAR account is in the token sheet
  await page.getByTestId("withdraw-btn-USDC").click();
  if (amount) await dlg(page).getByTestId("withdraw-amount-USDC").fill(amount);
};

test.describe("MODAL1c5 username modal", () => {
  test("first login: the username step is a modal over the gate; claim posts a signed body and closes it; failure keeps it open and retry works", async ({ page }) => {
    const w = world({ username: null, claimStatus: 500 });
    await setup(page, w);
    await open(page, "/browse");
    await expect(dlg(page).getByTestId("username-step")).toBeVisible();
    await expect(dlg(page).getByTestId("username-rules")).toContainText("3 to 20");
    await expect(dlg(page).getByTestId("username-step")).toContainText("Your email is never shown.");
    await claimName(page, "alice_9");
    await expect(dlg(page).getByTestId("username-error")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("username-step")).toBeVisible();
    w.claimStatus = 200;
    await dlg(page).getByTestId("username-claim-btn").click();
    await expect(page.locator("dialog[open]")).toHaveCount(0, { timeout: 20_000 });
    expect(w.claims.at(-1).username).toBe("alice_9");
    expect(Buffer.from(w.claims.at(-1).signature, "base64").length).toBe(64);
  });
  test("first login: Esc closes the sheet and the user keeps browsing (A1: no gate page); Create reopens it; busy blocks Esc and Back", async ({ page }) => {
    const w = world({ username: null, claimDelayMs: 1500 });
    await setup(page, w);
    await open(page, "/browse"); await pushRoute(page, "/judges");
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page.getByTestId("docs-page")).toBeVisible(); // DOCS1: /judges -> the Docs (was About)
    await page.getByTestId("nav-create").click();
    await claimName(page, "slow_one");
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await page.goBack().catch(() => undefined);
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await expect(page.locator("dialog[open]")).toHaveCount(0, { timeout: 20_000 });
    expect(w.claims).toHaveLength(1);
  });
  test("settings (F3: folded into Account details): shows the name, Change username opens the modal, rename closes it and Account shows the result", async ({ page }) => {
    const w = world();
    await setup(page, w);
    await open(page, "/settings");
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page.getByTestId("wallet-username")).toHaveText("@alice");
    await page.getByTestId("account-details").locator("summary").click();
    await expect(page.getByTestId("settings-username")).toHaveText("@alice");
    await page.getByTestId("settings-change-username").click();
    await expect(dlg(page).getByTestId("username-settings")).toBeVisible();
    await expect(dlg(page).locator("h2").first()).toHaveText("Change username"); // A1: the sheet's one title (no repeated heading)
    await dlg(page).getByTestId("username-input").fill("alice");
    await expect(dlg(page).getByTestId("username-status")).toHaveText("That is already your username.");
    await expect(dlg(page).getByTestId("username-claim-btn")).toBeDisabled();
    await claimName(page, "alice_new");
    await expect(page.locator("dialog[open]")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId("settings-username")).toHaveText("@alice_new");
    await expect(page.getByTestId("wallet-username")).toHaveText("@alice_new");
    await expect(page.getByTestId("settings-saved")).toHaveText("Username changed to @alice_new.");
  });
});

test.describe("MODAL1c5 add money / move modal", () => {
  // NAV1 (UX-31): Add money is the Wallet page now (a page, not a modal); old /add-money links redirect there with their query.
  test("/add-money deep link lands on the Wallet page (not a modal) with the hand-off headline", async ({ page }) => {
    await setup(page, world());
    await open(page, "/add-money?asset=USDC&need=30");
    await expect(page.getByTestId("add-money")).toBeVisible();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page.getByTestId("balance-headline")).toHaveText("Your balance: 20.00 USDC. You need 10.00 USDC more.");
    await expect(page).toHaveURL(/\/account\?asset=USDC&need=30$/);
  });
  test("move: the confirm says amount, asset, destination and no fee before anything is signed; one ft_transfer_call; success; balance refreshes", async ({ page }) => {
    const w = world({ wallet: 7_000_000n });
    await setup(page, w);
    await open(page, "/add-money");
    await page.getByTestId("move-USDC-token").click();
    const t = dlg(page).getByTestId("move-terms");
    await expect(t).toContainText("7.00 USDC"); await expect(t).toContainText("betting balance"); await expect(t).toContainText("no fee");
    expect(await signs(page)).toBe(0); expect(w.relays).toEqual([]);
    await dlg(page).getByTestId("move-confirm").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("move-result")).toHaveText("Moved to your betting balance.");
    await expect(dlg(page).getByTestId("tx-link")).toHaveAttribute("href", /TX1/);
    expect(w.relays).toEqual(["ft_transfer_call"]); expect(await signs(page)).toBe(1);
    await dlg(page).getByTestId("flow-done").click();
    await expect(page.getByTestId("balance-row-USDC")).toHaveText("27.00 USDC");
    await expect(page.getByTestId("move-USDC-token")).toHaveCount(0);
  });
  test("move: relayer failure -> plain reason with the detail, nothing lost, Try again then succeeds", async ({ page }) => {
    const w = world({ wallet: 7_000_000n, relayFail: true });
    await setup(page, w);
    await open(page, "/add-money");
    await page.getByTestId("move-USDC-token").click();
    await dlg(page).getByTestId("move-confirm").click();
    await expect(dlg(page).getByTestId("flow-failure")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("move-result")).toContainText("We couldn't move your money. Nothing was lost");
    await expect(dlg(page).getByTestId("move-error-detail")).toContainText("relayer down");
    w.relayFail = false;
    await dlg(page).getByTestId("flow-retry").click();
    await dlg(page).getByTestId("move-confirm").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
  });
  test("move: Cancel and Esc send nothing; busy blocks Esc; Back while sending keeps the result; exactly one relay", async ({ page }) => {
    const w = world({ wallet: 7_000_000n, relayDelayMs: 1500 });
    await setup(page, w);
    await open(page, "/browse"); await pushRoute(page, "/add-money");
    await page.getByTestId("move-USDC-token").click();
    await dlg(page).getByTestId("move-cancel").click();
    await expect(dlg(page).getByTestId("move-terms")).toHaveCount(0);
    await page.getByTestId("move-USDC-token").click();
    await page.keyboard.press("Escape");
    await expect(dlg(page).getByTestId("move-terms")).toHaveCount(0);
    expect(w.relays).toEqual([]); expect(await signs(page)).toBe(0);
    await page.getByTestId("move-USDC-token").click();
    await dlg(page).getByTestId("move-confirm").click();
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await page.goBack().catch(() => undefined);
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await expect(page).toHaveURL(/\/account/);
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    expect(w.relays).toEqual(["ft_transfer_call"]);
  });
});

test.describe("MODAL1c5 withdraw modal", () => {
  test("withdraw: amount step (Max), confirm step says amount, asset, wallet, no fee; one ft_withdraw; success; balance refreshes", async ({ page }) => {
    const w = world({ intents: 3_000_000n });
    await setup(page, w);
    await open(page, "/add-money");
    await openWithdraw(page);
    await dlg(page).getByTestId("withdraw-max-USDC").click();
    await expect(dlg(page).getByTestId("withdraw-amount-USDC")).toHaveValue("3");
    await dlg(page).getByTestId("withdraw-amount-USDC").fill("2");
    await dlg(page).getByTestId("withdraw-review").click();
    const t = dlg(page).getByTestId("withdraw-terms");
    await expect(t).toContainText("2.00 USDC"); await expect(t).toContainText("your NEAR account"); await expect(t).toContainText("no fee");
    await expect(t).not.toContainText(WALLET); // M1 (UIR1 §3.6): not the 64-char id over two lines
    expect(await signs(page)).toBe(0); expect(w.relays).toEqual([]);
    await dlg(page).getByTestId("withdraw-confirm").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("withdraw-result")).toHaveText("2.00 USDC is in your wallet.");
    expect(w.relays).toEqual(["ft_withdraw"]);
    await dlg(page).getByTestId("flow-done").click();
    await expect(page.getByTestId("balance-row-USDC")).toContainText("1.00 USDC");
  });
  test("withdraw: blank and over-balance amounts are refused on the amount step, nothing relayed", async ({ page }) => {
    const w = world({ intents: 3_000_000n });
    await setup(page, w);
    await open(page, "/add-money");
    await openWithdraw(page);
    await dlg(page).getByTestId("withdraw-review").click();
    await expect(dlg(page).getByTestId("flow-error")).toHaveText("Enter an amount to withdraw.");
    await dlg(page).getByTestId("withdraw-amount-USDC").fill("9");
    await dlg(page).getByTestId("withdraw-review").click();
    await expect(dlg(page).getByTestId("flow-error")).toHaveText("That's more than your betting balance.");
    await expect(dlg(page).getByTestId("withdraw-terms")).toHaveCount(0);
    expect(w.relays).toEqual([]);
  });
  test("withdraw: relayer failure -> plain reason with detail, balance stays, Try again keeps the amount and succeeds", async ({ page }) => {
    const w = world({ intents: 3_000_000n, relayFail: true });
    await setup(page, w);
    await open(page, "/add-money");
    await openWithdraw(page, "1");
    await dlg(page).getByTestId("withdraw-review").click();
    await dlg(page).getByTestId("withdraw-confirm").click();
    await expect(dlg(page).getByTestId("flow-failure")).toBeVisible({ timeout: 20_000 });
    await expect(dlg(page).getByTestId("withdraw-result")).toContainText("We couldn't withdraw your money. Anything not sent stays in your betting balance.");
    await expect(dlg(page).getByTestId("withdraw-error-detail")).toContainText("relayer down");
    w.relayFail = false;
    await dlg(page).getByTestId("flow-retry").click();
    await dlg(page).getByTestId("withdraw-confirm").click();
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
  });
  test("withdraw: Cancel and Esc send nothing; busy blocks Esc; Back while sending keeps the result; exactly one relay", async ({ page }) => {
    const w = world({ intents: 3_000_000n, relayDelayMs: 1500 });
    await setup(page, w);
    await open(page, "/browse"); await pushRoute(page, "/add-money");
    await openWithdraw(page, "1");
    await dlg(page).getByTestId("withdraw-review").click();
    await dlg(page).getByTestId("withdraw-cancel").click();
    await expect(dlg(page).getByTestId("withdraw-terms")).toHaveCount(0);
    expect(w.relays).toEqual([]); expect(await signs(page)).toBe(0);
    await openWithdraw(page, "1");
    await dlg(page).getByTestId("withdraw-review").click();
    await dlg(page).getByTestId("withdraw-confirm").click();
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await page.goBack().catch(() => undefined);
    await expect(dlg(page).getByTestId("flow-busy")).toBeVisible();
    await expect(page).toHaveURL(/\/account/);
    await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
    expect(w.relays).toEqual(["ft_withdraw"]);
  });
});

test.describe("MODAL1c5 axe + screenshots at 375 / 1280", () => {
  for (const [name, size] of [["1280", { width: 1280, height: 900 }], ["375", { width: 375, height: 800 }]] as const) {
    const shotter = (page: Page) => async (n: string) => { await noSeriousAxe(page); await page.screenshot({ path: screenPath(`modal1c5/${n}-${name}.png`) }); };
    test(`${name}px username: first-login modal, error, change-username modal`, async ({ page }) => {
      await page.setViewportSize(size);
      const w = world({ username: null, claimStatus: 500 });
      await setup(page, w);
      await open(page, "/browse");
      const shot = shotter(page);
      await expect(dlg(page).getByTestId("modal-surface")).toHaveAttribute("data-presentation", name === "375" ? "sheet" : "dialog");
      await shot("username-1-first-login");
      await claimName(page, "alice_9");
      await expect(dlg(page).getByTestId("username-error")).toBeVisible({ timeout: 20_000 });
      await shot("username-2-error");
      w.claimStatus = 200;
      await dlg(page).getByTestId("username-claim-btn").click();
      await expect(page.locator("dialog[open]")).toHaveCount(0, { timeout: 20_000 });
      await page.goto("/settings"); await page.waitForFunction(() => (window as any).__e2e?.ready === true);
      // CS1: let the Account page finish loading first. Cash out turns enabled when the balances arrive and fades in; axe ran
      // mid-fade under load and flagged its half-opacity label (the settled colours pass).
      await expect(page.getByTestId("account-cash-out")).toBeEnabled({ timeout: 20_000 });
      await page.getByTestId("account-details").locator("summary").click();
      await page.getByTestId("settings-change-username").click();
      await shot("username-3-change");
    });
    test(`${name}px add money, move and withdraw: every step has axe 0 serious/critical; screenshots`, async ({ page }) => {
      await page.setViewportSize(size);
      const w = world({ wallet: 7_000_000n });
      await setup(page, w);
      await open(page, "/add-money?asset=USDC&need=30");
      const shot = shotter(page);
      await shot("add-money-1-open");
      await page.getByTestId("move-USDC-token").click();
      await shot("move-1-confirm");
      w.relayFail = true;
      await dlg(page).getByTestId("move-confirm").click();
      await expect(dlg(page).getByTestId("flow-failure")).toBeVisible({ timeout: 20_000 });
      await shot("move-2-failure");
      w.relayFail = false;
      await dlg(page).getByTestId("flow-retry").click();
      await dlg(page).getByTestId("move-confirm").click();
      await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
      await shot("move-3-success");
      await dlg(page).getByTestId("flow-done").click();
      await openWithdraw(page, "2");
      await shot("withdraw-1-amount");
      await dlg(page).getByTestId("withdraw-review").click();
      await shot("withdraw-2-confirm");
      w.relayFail = true;
      await dlg(page).getByTestId("withdraw-confirm").click();
      await expect(dlg(page).getByTestId("flow-failure")).toBeVisible({ timeout: 20_000 });
      await shot("withdraw-3-failure");
      w.relayFail = false;
      await dlg(page).getByTestId("flow-retry").click();
      await dlg(page).getByTestId("withdraw-confirm").click();
      await expect(dlg(page).getByTestId("flow-success")).toBeVisible({ timeout: 20_000 });
      await shot("withdraw-4-success");
    });
  }
});
