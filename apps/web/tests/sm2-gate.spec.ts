// SM2: the cross-machine gate (lib/appState.ts gate + src/kit/Gate.tsx) on the real app. familiarcow 2026-11-11: everyone betting has a
// Praetorial account (a claimed @username). A signed-in user without one can look around, but Create / Take ask for the username first
// (GateNotice + "Pick a username"), and a registry outage holds them with "Try again". Fully mocked (NEAR RPC, registry, wallet).
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { readFileSync } from "node:fs";

const WALLET = "11".repeat(32);
const SIG = "22".repeat(64);
const REG = "http://registry.e2e.test";
const RPC = "https://test.rpc.fastnear.com";
const USDC = "nep141:usdc.testnet";
const WASM = JSON.parse(readFileSync(new URL("../lib/release.json", import.meta.url), "utf8")).resolver_wasm_hash;
const FUND_NS = Date.now() * 1e6 + 7 * 24 * 3600 * 1e9;
const RESOLVE_NS = Date.now() * 1e6 + 30 * 24 * 3600 * 1e9;
const bet = () => ({
  envelope: {
    bet_id: 7, version: 1, maker: "maker.testnet", taker_allow: "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "cd".repeat(32),
    outcomes: ["YES", "NO"], maker_side: "YES", maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: "10000000",
    taker_options: [], fee_bps: 100, reserve_per_side: "0", storage_charge_per_side: "0", keep_terms: false, terms: null, run_price: "0",
    max_paid_runs: 3, tier: 1, arbiter: null, arbiter_fee: "0", funding_deadline: FUND_NS,
    early_settle_outcome: null, finality_delay: 0, settlement_period: 24 * 3600 * 1e9, resolve_deadline: RESOLVE_NS,
    consent_party_controlled: false, referee: { account: "ref.testnet", mode: "Human" },
  },
  status: "Open", taker: null, created_at: 0, taken_at: null, proposed_at: null, outcome: null, reserve_remaining: "0",
  bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0, fee_min_taker: "0",
});

async function mockRpc(page: Page) {
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
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
        case "get_bet": r = args.bet_id === 7 ? bet() : null; break;
        case "asset_limit": r = { storage_per_kib: "1" }; break;
        case "resolver_keys": r = ["a", "b", WASM]; break;
        case "mt_balance_of": r = args.token_id === USDC ? "50000000" : "0"; break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
}

/** Mutable registry: `lookup` (404 = no username, 500 = down, or the name) and the /claim status. */
async function mockRegistry(page: Page, st: { lookup: number | { username: string }; claim: number }) {
  await page.route(`${REG}/**`, async (route) => {
    const req = route.request(); const url = new URL(req.url());
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST" } });
    if (url.pathname.startsWith("/lookup/account/")) return typeof st.lookup === "number" ? json(st.lookup, { error: "x" }) : json(200, st.lookup);
    if (url.pathname === "/search") return json(200, []);
    if (url.pathname === "/claim") {
      if (st.claim !== 200) return json(st.claim, { error: "internal" });
      const name = JSON.parse(req.postData() ?? "{}").username;
      st.lookup = { username: name };
      return json(200, { username: name, account_id: WALLET });
    }
    return json(404, {});
  });
}

async function signedIn(page: Page) {
  await page.addInitScript(({ address, sig, reg }) => {
    (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => sig };
    (window as any).__e2eRegistryUrl = reg;
  }, { address: WALLET, sig: SIG, reg: REG });
}
const ready = (page: Page) => page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });

/** First-login username step with the claim failing -> "Skip for now": a signed-in user with no username. */
async function skipUsername(page: Page) {
  await expect(page.getByTestId("username-step")).toBeVisible();
  await page.getByTestId("username-input").fill("gated_one");
  await expect(page.getByTestId("username-status")).toContainText("available");
  await page.getByTestId("username-claim-btn").click();
  await page.getByTestId("username-skip").click();
  await expect(page.getByTestId("username-step")).toHaveCount(0);
}
async function pickUsername(page: Page, name: string) {
  await expect(page.getByTestId("username-step")).toBeVisible();
  await page.getByTestId("username-input").fill(name);
  await expect(page.getByTestId("username-status")).toContainText("available");
  await page.getByTestId("username-claim-btn").click();
  await expect(page.getByTestId("username-step")).toHaveCount(0);
}

test.describe("SM2 gate: Pick a username before any bet action", () => {
  test("create: no username -> the create form is replaced by the gate; Pick a username -> claim -> the form opens", async ({ page }) => {
    await signedIn(page);
    await mockRpc(page);
    const reg = { lookup: 404 as number | { username: string }, claim: 500 };
    await mockRegistry(page, reg);
    await page.goto("/new");
    await ready(page);
    await skipUsername(page);
    // Browsing stays open; Create is not disabled, it explains itself and offers the one fix.
    await expect(page.getByTestId("create-offer-form")).toHaveCount(0);
    const g = page.getByTestId("create-gate");
    await expect(g).toHaveAttribute("data-gate", "no-username");
    await expect(g).toContainText("Pick a username first.");
    await expect(page.getByTestId("nav-create")).toBeEnabled();
    reg.claim = 200;
    await page.getByTestId("gate-fix-pick-username").click();
    await pickUsername(page, "gated_one");
    await expect(page.getByTestId("create-gate")).toHaveCount(0);
    await expect(page.getByTestId("create-offer-form")).toBeVisible();
  });

  test("create from the nav: a user without a username gets the gate, never the form", async ({ page }) => {
    await signedIn(page);
    await mockRpc(page);
    await mockRegistry(page, { lookup: 404, claim: 500 });
    await page.goto("/about");
    await ready(page);
    await skipUsername(page);
    await page.getByTestId("nav-create").click();
    // The nav button opens the picker directly.
    await expect(page.getByTestId("username-step")).toBeVisible();
    await expect(page.getByTestId("create-offer-form")).toHaveCount(0);
  });

  test("take: no username -> Take is disabled with the gate notice; Pick a username -> claim -> Take is enabled", async ({ page }) => {
    await signedIn(page);
    await mockRpc(page);
    const reg = { lookup: 404 as number | { username: string }, claim: 500 };
    await mockRegistry(page, reg);
    await page.goto("/bet/7");
    await ready(page);
    await skipUsername(page);
    await expect(page.getByTestId("take-section")).toBeVisible(); // the bet itself is open to look at
    await expect(page.getByTestId("take-open")).toBeDisabled();
    await expect(page.getByTestId("gate-take")).toHaveAttribute("data-gate", "no-username");
    reg.claim = 200;
    await page.getByTestId("gate-fix-pick-username").click();
    await pickUsername(page, "gated_two");
    await expect(page.getByTestId("gate-take")).toHaveCount(0);
    await expect(page.getByTestId("take-open")).toBeEnabled();
  });

  test("registry down: create is held with 'Try again'; once the registry answers, the form opens", async ({ page }) => {
    await signedIn(page);
    await mockRpc(page);
    const reg = { lookup: 500 as number | { username: string }, claim: 200 };
    await mockRegistry(page, reg);
    await page.goto("/new");
    await ready(page);
    await expect(page.getByTestId("registry-down-note")).toBeVisible();
    await expect(page.getByTestId("create-offer-form")).toHaveCount(0);
    await expect(page.getByTestId("create-gate")).toHaveAttribute("data-gate", "username-unknown");
    reg.lookup = { username: "back_again" };
    await page.getByTestId("gate-fix-retry").click();
    await expect(page.getByTestId("create-offer-form")).toBeVisible();
  });

  test("a username claimed on Account or Settings lifts the gate at once (no reload)", async ({ page }) => {
    await signedIn(page);
    await mockRpc(page);
    const reg = { lookup: 404 as number | { username: string }, claim: 500 };
    await mockRegistry(page, reg);
    await page.goto("/new");
    await ready(page);
    await skipUsername(page);
    await expect(page.getByTestId("create-gate")).toBeVisible();
    reg.claim = 200;
    await page.getByTestId("nav-account").click();
    await page.getByTestId("wallet-pick-username").click();
    await pickUsername(page, "from_account");
    await expect(page.getByTestId("wallet-username")).toHaveText("@from_account");
    await page.getByTestId("nav-create").click();
    await expect(page.getByTestId("create-gate")).toHaveCount(0);
    await expect(page.getByTestId("create-offer-form")).toBeVisible();
  });

  test("a user with a username is never gated", async ({ page }) => {
    await signedIn(page);
    await mockRpc(page);
    await mockRegistry(page, { lookup: { username: "alice" }, claim: 200 });
    await page.goto("/bet/7");
    await ready(page);
    await expect(page.getByTestId("take-section")).toBeVisible();
    await expect(page.getByTestId("gate-take")).toHaveCount(0);
    await expect(page.getByTestId("take-open")).toBeEnabled();
  });
});
