// FE2b: (1) Open and Take hand off to /add-money when the Intents balance is short, and the user comes back to the same
// review; (2) Settings: current username + rename (NEP-413 claim). Fully mocked: NEAR RPC, registry, source check, wallet.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const WALLET = "11".repeat(32);
const SIG = "22".repeat(64);
const REG = "http://registry.e2e.test";
const RPC = "https://test.rpc.fastnear.com";
const SC = "http://localhost:8790/sourcecheck";
const USDC = "nep141:usdc.testnet";
const RELAYER = "http://localhost:8788";
const WASM = JSON.parse(readFileSync(new URL("../lib/release.json", import.meta.url), "utf8")).resolver_wasm_hash;

// Fixed once: a real bet's deadlines never move between reads (FE9's race guard compares them).
const FUND_NS = Date.now() * 1e6 + 7 * 24 * 3600 * 1e9;
const RESOLVE_NS = Date.now() * 1e6 + 30 * 24 * 3600 * 1e9;
const bet = (over: any = {}) => ({
  envelope: {
    bet_id: 7, version: 1, maker: "maker.testnet", taker_allow: "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "cd".repeat(32),
    outcomes: ["YES", "NO"], maker_side: "YES", maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: "10000000",
    taker_options: [], fee_bps: 100, reserve_per_side: "0", storage_charge_per_side: "0", keep_terms: false, terms: null, run_price: "0",
    max_paid_runs: 3, tier: 1, arbiter: null, arbiter_fee: "0", funding_deadline: FUND_NS,
    early_settle_outcome: null, finality_delay: 0, settlement_period: 24 * 3600 * 1e9, resolve_deadline: RESOLVE_NS,
    consent_party_controlled: false, referee: { account: "ref.testnet", mode: "Human" }, ...(over.envelope ?? {}),
  },
  status: "Open", taker: null, created_at: 0, taken_at: null, proposed_at: null, outcome: null, reserve_remaining: "0",
  bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0, fee_min_taker: "0",
});

import { swappableRoute, type RouteHandler } from "./swappableRoute";
type Rpc = { usdc: string; calls: { method: string; args: any }[]; swap(h: RouteHandler): void };
async function mockRpc(page: Page, usdc = "0"): Promise<Rpc> {
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" })); // FE10e: never the real 1Click API
  const st: Rpc = { usdc, calls: [], swap: () => {} };
  const sw = await swappableRoute(page, RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8"));
      st.calls.push({ method: params.method_name, args });
      let r: unknown = null;
      switch (params.method_name) {
        case "is_paused": case "is_shutdown": r = false; break;
        case "open_offers": r = []; break;
        case "get_bet": r = args.bet_id === 7 ? bet() : null; break;
        case "asset_limit": r = { storage_per_kib: "1" }; break;
        case "resolver_keys": r = ["a", "b", WASM]; break;
        case "required_challenge_bond": r = null; break;
        case "mt_balance_of": r = args.token_id === USDC ? st.usdc : "0"; break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  st.swap = sw.set; // FE10g: swap the RPC behaviour in place (never unroute)
  return st;
}

async function mockRegistry(page: Page, lookup: number | { username: string }, users: any[] = [], claim = { status: 200 }) {
  const calls: { path: string; body?: any }[] = [];
  await page.route(`${REG}/**`, async (route) => {
    const req = route.request(); const url = new URL(req.url());
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST" } });
    calls.push({ path: url.pathname + url.search, body: req.method() === "POST" ? JSON.parse(req.postData() ?? "{}") : undefined });
    if (url.pathname.startsWith("/lookup/account/")) return typeof lookup === "number" ? json(lookup, { error: "x" }) : json(200, lookup);
    if (url.pathname === "/search") return json(200, users);
    if (url.pathname === "/claim") return claim.status !== 200 ? json(claim.status, { error: "internal" }) : json(200, { username: calls[calls.length - 1].body.username, account_id: WALLET });
    return json(404, {});
  });
  return calls;
}

async function signedIn(page: Page, reg = true) {
  await page.addInitScript(({ address, sig, reg }) => {
    (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => sig };
    if (reg) (window as any).__e2eRegistryUrl = reg;
  }, { address: WALLET, sig: SIG, reg: reg ? REG : "" });
}
const ready = (page: Page) => page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
const goTo = (page: Page, path: string) => page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, path);

test.describe("FE2b take hand-off (S11)", () => {
  test("short balance: nothing is signed, we land on Add money with the exact need, and Back restores tip + asset choice", async ({ page }) => {
    await signedIn(page, false);
    const rpc = await mockRpc(page, "5000000");
    let relays = 0;
    await page.route(`${RELAYER}/relay`, (r) => { relays++; return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: "t" }) }); });
    await page.goto("/bet/7");
    await ready(page);
    await expect(page.getByTestId("take-section")).toBeVisible();
    await expect.poll(() => rpc.calls.filter((c) => c.method === "asset_limit").length).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    await page.getByTestId("take-open").click();
    await page.getByTestId("take-tip-checkbox").check();
    await page.getByTestId("take-confirm").click(); // M1: one confirm step
    // FUND1b: the modal itself says exactly what is missing and offers a plain "Add money"; nothing navigates until it is pressed.
    await expect(page.getByTestId("modal-short")).toBeVisible();
    await expect(page.getByTestId("modal-short")).toContainText(/You need 5\.\d\d USDC more in your betting balance to do this\./);
    await expect(page.getByTestId("add-money")).toHaveCount(0);
    await page.getByTestId("modal-add-money").click();
    await expect(page.getByTestId("add-money")).toBeVisible();
    await expect(page).toHaveURL(/\/account\?asset=USDC&need=10(\.\d+)?&return=%2Fbet%2F7$/); // NAV1: Add money is the Wallet page
    // Exact: stake 10 USDC plus the contract storage charge, minus the 5 USDC already there.
    const need = new URL(page.url()).searchParams.get("need")!;
    expect(Number(need)).toBeGreaterThan(10);
    // F3 (FUND3 §4.3 / SPEC §6): an amount shown as NEEDED rounds up to the cent, so the user never adds too little.
    const shortCents = Math.ceil((Math.round(Number(need) * 1e6) - 5_000_000) / 10_000);
    await expect(page.getByTestId("balance-headline")).toHaveText(`Your balance: 5.00 USDC. You need ${(shortCents / 100).toFixed(2)} USDC more.`);
    expect(relays).toBe(0);
    await page.getByTestId("add-money-back").click();
    await expect(page).toHaveURL(/\/bet\/7$/);
    // MODAL1c2: the take modal reopens where the user left; M1: it is one step, so the tip choice is kept, ticked and in the pay box.
    await expect(page.getByTestId("take-confirm-summary")).toContainText("Referee tip");
    await expect(page.getByTestId("take-tip-checkbox")).toBeChecked();
  });

  test("enough balance: no detour, the take is signed and relayed", async ({ page }) => {
    await signedIn(page, false);
    const rpc = await mockRpc(page, "50000000");
    let relays = 0;
    await page.route(`${RELAYER}/relay`, (r) => { relays++; return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: "take-tx" }) }); });
    await page.goto("/bet/7");
    await ready(page);
    await expect(page.getByTestId("take-section")).toBeVisible();
    await expect.poll(() => rpc.calls.filter((c) => c.method === "asset_limit").length).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    await page.getByTestId("take-open").click();
    await page.getByTestId("take-confirm").click(); // M1: one confirm step
    // M1 (UIR1 §3.6): the raw take-tx hash line is gone; the take reached a result screen after exactly one relay.
    await expect(page.getByTestId("take-result")).toBeVisible({ timeout: 20_000 });
    expect(relays).toBe(1);
    await expect(page.getByTestId("add-money")).toHaveCount(0);
  });

  test("balance read fails: the take proceeds (the contract refunds a wrong deposit), no false block", async ({ page }) => {
    await signedIn(page, false);
    const rpc = await mockRpc(page, "0");
    const limitCalls: number[] = [];
    rpc.swap(async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      const params = body.params ?? {};
      const args = params.args_base64 ? JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8")) : {};
      if (params.method_name === "mt_balance_of") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -32000, message: "boom" } }) });
      const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
      if (body.method === "block") return ok({ header: { height: 100 } });
      if (params.request_type === "view_access_key") return ok({ nonce: 1 });
      if (params.request_type === "call_function") {
        if (params.method_name === "asset_limit") limitCalls.push(1);
        const r = params.method_name === "get_bet" ? bet() : params.method_name === "asset_limit" ? { storage_per_kib: "1" } : params.method_name === "is_paused" || params.method_name === "is_shutdown" ? false : params.method_name === "open_offers" ? [] : null;
        void args;
        return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
      }
      return ok({});
    });
    let relays2 = 0;
    await page.route(`${RELAYER}/relay`, (r) => { relays2++; return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: "take-tx2" }) }); });
    await page.goto("/bet/7");
    await ready(page);
    await expect(page.getByTestId("take-section")).toBeVisible();
    await expect.poll(() => limitCalls.length).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    await page.getByTestId("take-open").click();
    await page.getByTestId("take-confirm").click(); // M1: one confirm step
    await expect(page.getByTestId("take-result")).toBeVisible({ timeout: 20_000 }); // M1: no raw hash line; it was relayed (no false block)
    await expect(page.getByTestId("modal-short")).toHaveCount(0);
    expect(relays2).toBe(1);
  });
});

test.describe("FE2b open hand-off (S7/S8)", () => {
  test("short balance: Open sends nothing, goes to Add money with the pay-now need, Back returns to the same review", async ({ page }) => {
    await signedIn(page, false);
    await mockRpc(page, "0");
    let relays = 0;
    await page.route(`${RELAYER}/relay`, (r) => { relays++; return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: "t" }) }); });
    await page.route(SC, async (route) => {
      const { terms } = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: true, spec_hash: createHash("sha256").update(terms).digest("hex"), checked_at: String(Date.now() * 1_000_000), unreachable: [], signing: { signature_hex: "33".repeat(64) } }) });
    });
    await page.route("**/ticker**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ venue: "x", price: 1 }) }));
    await page.goto("/new");
    await ready(page);
    // FE3 (D-UX21): the dev presets are gone; pick a bet type and fill it in, then the resolver step.
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
    await page.getByTestId("open-offer-btn").click();
    await expect(page.getByTestId("modal-short")).toContainText(/You need 10(\.\d+)? NEAR more in your betting balance to do this\./);
    await expect(page.getByTestId("add-money")).toHaveCount(0);
    await page.getByTestId("modal-add-money").click();
    await expect(page.getByTestId("add-money")).toBeVisible();
    await expect(page).toHaveURL(/\/account\?asset=NEAR&need=10(\.\d+)?&return=%2Fnew$/); // NAV1: Add money is the Wallet page
    expect(relays).toBe(0);
    await page.getByTestId("add-money-back").click();
    await expect(page).toHaveURL(/\/new$/);
    await expect(page.getByTestId("review-card")).toBeVisible();
  });
});

// F3 (familiarcow UX-37 #8): Settings folded into the Account page's "Account details" row; /settings redirects to /account.
test.describe("FE2b settings (F3: Account details)", () => {
  test("shows the current username and renames through a signed claim", async ({ page }) => {
    await signedIn(page);
    await mockRpc(page);
    const reg = await mockRegistry(page, { username: "alice" });
    await page.goto("/");
    await ready(page);
    await expect(page.getByTestId("nav-account")).toHaveText("@alice"); // F3: the nav shows the user's @username
    await page.getByTestId("nav-account").click();
    await expect(page.getByTestId("wallet-username")).toHaveText("@alice");
    await page.getByTestId("account-details").locator("summary").click();
    await expect(page.getByTestId("settings-username")).toHaveText("@alice");
    await page.getByTestId("settings-change-username").click(); // MODAL1c5: the rename form is a modal
    await expect(page.getByTestId("username-settings")).toBeVisible();
    await expect(page.locator("dialog[open] h2").first()).toHaveText("Change username"); // A1: the sheet's one title
    await page.getByTestId("username-input").fill("alice");
    await expect(page.getByTestId("username-status")).toHaveText("That is already your username.");
    await expect(page.getByTestId("username-claim-btn")).toBeDisabled();
    await page.getByTestId("username-input").fill("alice_new");
    await expect(page.getByTestId("username-status")).toHaveText("@alice_new is available");
    await page.getByTestId("username-claim-btn").click();
    await expect(page.getByTestId("settings-username")).toHaveText("@alice_new");
    await expect(page.getByTestId("settings-saved")).toHaveText("Username changed to @alice_new.");
    await expect(page.getByTestId("nav-account")).toHaveText("@alice_new"); // the app state learns the new name at once
    const claim = reg.find((c) => c.path === "/claim")!;
    expect(claim.body.username).toBe("alice_new");
    expect(claim.body.account_id).toBe(WALLET);
    expect(Buffer.from(claim.body.signature, "base64").length).toBe(64);
  });

  test("skip at signup (registry down on claim) -> Settings -> claim", async ({ page }) => {
    await signedIn(page);
    await mockRpc(page, "20000000");
    const claim = { status: 500 };
    const reg = await mockRegistry(page, 404, [], claim);
    await page.goto("/new");
    await ready(page);
    await page.getByTestId("username-input").fill("later_one");
    await expect(page.getByTestId("username-status")).toContainText("available");
    await page.getByTestId("username-claim-btn").click();
    await expect(page.getByTestId("username-skip")).toBeVisible();
    await page.getByTestId("username-skip").click();
    // SM2 (familiarcow 2026-11-11): no username = no bet; /new shows the "Pick a username" gate instead of the create form.
    await expect(page.getByTestId("create-gate")).toHaveAttribute("data-gate", "no-username");
    await expect(page.getByTestId("create-offer-form")).toHaveCount(0);
    claim.status = 200;
    // NAV1 (UX-32): with no username yet, the Wallet page offers "Pick a username" (the same signed claim flow).
    await page.getByTestId("nav-account").click();
    await expect(page.getByTestId("settings-username")).toHaveCount(0);
    await page.getByTestId("wallet-pick-username").click(); // the same signed claim flow as at sign-up
    await page.getByTestId("username-input").fill("later_one");
    await expect(page.getByTestId("username-status")).toContainText("available");
    await page.getByTestId("username-claim-btn").click();
    await expect(page.getByTestId("wallet-username")).toHaveText("@later_one");
    expect(reg.filter((c) => c.path === "/claim").length).toBe(2);
  });

  test("a taken name is refused in Change username the same way as at first login", async ({ page }) => {
    await signedIn(page);
    await mockRpc(page);
    await mockRegistry(page, { username: "alice" }, [{ username: "bobby", account_tail: "other.testnet" }]);
    await page.goto("/settings");
    await ready(page);
    await expect(page).toHaveURL(/\/account$/);
    await page.getByTestId("account-details").locator("summary").click();
    await page.getByTestId("settings-change-username").click(); // MODAL1c5: the form is a modal opened from Settings
    await page.getByTestId("username-input").fill("bobby");
    await expect(page.getByTestId("username-status")).toContainText("That name is taken.");
    await expect(page.getByTestId("username-claim-btn")).toBeDisabled();
  });

  test("registry down: plain note instead of a form", async ({ page }) => {
    await signedIn(page);
    await mockRpc(page);
    await mockRegistry(page, 500);
    await page.goto("/settings");
    await ready(page);
    await expect(page.getByTestId("wallet-registry-down")).toBeVisible();
    await expect(page.getByTestId("settings-change-username")).toHaveCount(0);
    await expect(page.getByTestId("username-settings")).toHaveCount(0);
  });

  test("logged out /settings is login-gated (as /account) and there is no Settings nav", async ({ page }) => {
    await mockRpc(page);
    await page.goto("/settings");
    await ready(page);
    await expect(page.getByTestId("login-gate")).toContainText("Log in to open your account.");
    await expect(page.getByTestId("settings")).toHaveCount(0);
    await expect(page.getByTestId("nav-settings")).toHaveCount(0);
  });
});
