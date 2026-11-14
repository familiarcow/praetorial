// GUEST1 (familiarcow 11-13): "Browse as guest" -- guests can look, every action still needs an account. Fully mocked (indexer + NEAR RPC
// via page.route); never the Privy test user or any shared credential. "Logged in" (for the return-to-the-same-page check) is the
// window.__e2eTestWallet seam, swapped in after load.
import { type Page, type Request } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { mkdirSync } from "node:fs";
import { ESCROW_CONTRACT_ID } from "../lib/config";
import { mockUsernames, E2E_REGISTRY } from "./lib/betPage";
import { guestRequestViolation } from "./lib/guestFetchPolicy";

const INDEXER = "http://localhost:8787";
const RPC = "https://test.rpc.fastnear.com";
// Screenshots go to the tracked spikes/guest1/shots only with GUEST1_SHOTS=1 (PUB1: ./test.sh fast leaves the tree clean).
const SHOTS = process.env.GUEST1_SHOTS === "1" ? new URL("../../../spikes/guest1/shots/", import.meta.url).pathname : new URL("../test-results/guest1-shots/", import.meta.url).pathname;
const POLICY = { rpcUrl: RPC, relayerUrl: "http://localhost:8788", registryUrl: E2E_REGISTRY, sourceCheckUrl: "http://localhost:8790/sourcecheck" };
const DAY_NS = 24 * 3600 * 1_000_000_000;

function bet(id: number, over: Record<string, any> = {}) {
  const base = {
    envelope: {
      bet_id: id, version: 1, maker: "maker.testnet", taker_allow: "Any", terms_hash: "deadbeef".repeat(4), models_snapshot_hash: "x",
      outcomes: ["YES", "NO"], maker_side: "YES", maker_asset: "nep141:usdc.testnet", taker_asset: "nep141:usdc.testnet",
      stake_maker: "100000000", stake_taker: "100000000", taker_options: [], fee_bps: 100, reserve_per_side: "0", storage_charge_per_side: "0",
      keep_terms: true, terms: JSON.stringify({ claimText: "BTC closes above $100k on Coinbase" }), run_price: "0", max_paid_runs: 3, tier: 1,
      arbiter: null, arbiter_fee: "0", funding_deadline: Date.now() * 1_000_000 + 7 * DAY_NS, early_settle_outcome: null, finality_delay: 0,
      settlement_period: DAY_NS, resolve_deadline: 0, consent_party_controlled: false, referee: null,
    },
    status: "Open", taker: null, created_at: 0, taken_at: null, proposed_at: null, outcome: null, reserve_remaining: "0", bonds: [], exhibits: [],
    challenged_by: null, window_extension_ns: 0,
  };
  return { ...base, ...over, envelope: { ...base.envelope, ...(over.envelope ?? {}) } };
}
const BETS: Record<number, any> = {
  1: bet(1),
  2: bet(2, { status: "Active", taker: "taker.testnet", envelope: { maker: "alice.testnet", terms: JSON.stringify({ claimText: "It snows in NYC on Dec 1" }) } }),
};

async function mockReads(page: Page) {
  await mockUsernames(page);
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route(`${INDEXER}/**`, (r) => {
    const p = new URL(r.request().url()).pathname;
    const rows = Object.values(BETS).filter((b) => (p.includes("offers") ? b.status === "Open" : b.status !== "Open"))
      .map((b) => ({ bet_id: b.envelope.bet_id, contract_id: ESCROW_CONTRACT_ID, maker: b.envelope.maker, maker_side: "YES", stake_maker: b.envelope.stake_maker,
        stake_taker: b.envelope.stake_taker, funding_deadline: b.envelope.funding_deadline, taker_allow: "Any", status: b.status, taker: b.taker }));
    return r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(rows) });
  });
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100, timestamp: Date.now() * 1_000_000, timestamp_nanosec: String(Date.now() * 1_000_000) } });
    if (params.request_type === "call_function") {
      const args = params.args_base64 ? JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8") || "{}") : {};
      let r: unknown = null;
      if (params.method_name === "is_paused" || params.method_name === "is_shutdown") r = false;
      else if (params.method_name === "get_bet") r = BETS[args.bet_id] ?? null;
      else if (params.method_name === "open_offers") r = Object.values(BETS).filter((b) => b.status === "Open");
      else if (params.method_name === "bet_count") r = Object.keys(BETS).length;
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
}

/** Records every fetch / XHR / beacon the page makes, and ANY non-GET whatever its type, with method and body. Only the dev server's
 *  own module/asset GETs (scripts, styles, images, fonts, the document) are left out: they are code, not calls. */
const ASSET_TYPES = new Set(["document", "script", "stylesheet", "image", "font", "media", "manifest"]);
function recordRequests(page: Page) {
  const seen: { method: string; url: string; body: string | null }[] = [];
  page.on("request", (r: Request) => {
    if (r.method() === "GET" && ASSET_TYPES.has(r.resourceType())) return;
    seen.push({ method: r.method(), url: r.url(), body: r.postData() });
  });
  return seen;
}
const violations = (seen: { method: string; url: string; body: string | null }[]) =>
  seen.map((r) => ({ r, why: guestRequestViolation(r, POLICY) })).filter((x) => x.why).map((x) => `${x.why}: ${x.r.method} ${x.r.url} ${x.r.body?.slice(0, 120) ?? ""}`);

async function ready(page: Page) { await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 }); }
/** The tab starts as a guest (seeded once, so a later page.goto in the same tab keeps whatever the app did to the flag). */
async function startAsGuest(page: Page) {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("e2e:guest-seeded")) return;
    window.sessionStorage.setItem("e2e:guest-seeded", "1");
    window.sessionStorage.setItem("praetorial:guest", "1");
  });
}
async function expectGuestShell(page: Page) {
  await expect(page.getByTestId("guest-banner")).toHaveText("You're browsing as a guest. Log in to bet.");
  await expect(page.getByTestId("nav-home")).toBeVisible();
  await expect(page.getByTestId("nav-docs")).toBeVisible();
  await expect(page.getByTestId("nav-login")).toHaveText("Log in");
  await expect(page.getByTestId("nav-account")).toHaveCount(0);
  await expect(page.getByTestId("nav-logout")).toHaveCount(0);
  await expect(page.getByTestId("login-gate")).toHaveCount(0);
}
async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const [w, h] of [[375, 812], [1280, 900]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}${name}-${w}.png`, fullPage: true });
  }
}

test.describe("GUEST1 browse as guest (mocked)", () => {
  test("login page: 'Browse as guest' below the form; pressing it opens guest Home with no Privy call and no account data", async ({ page }) => {
    await mockReads(page);
    const privy: string[] = [];
    page.on("request", (r) => { if (/auth\.privy\.io\/api\/v1\/(passwordless|siwe|sessions|users|embedded_wallets)/.test(r.url())) privy.push(r.url()); });
    await page.goto("/");
    await ready(page);
    const btn = page.getByTestId("browse-as-guest");
    await expect(btn).toHaveText("Browse as guest");
    // below the login form, inside the card
    const formBox = (await page.getByTestId("login-form").locator("form").boundingBox())!;
    expect((await btn.boundingBox())!.y).toBeGreaterThan(formBox.y + formBox.height - 1);
    await shot(page, "login-with-guest-button");
    const before = privy.length;
    await btn.click();
    await expectGuestShell(page);
    await expect(page).toHaveURL(/\/$/);
    expect(await page.evaluate(() => window.sessionStorage.getItem("praetorial:guest"))).toBe("1");
    await expect(page.getByTestId("home")).toBeVisible();
    await expect(page.getByTestId("browse-list").or(page.getByTestId("home"))).toBeVisible();
    // no "my" anything: no My Bets, no balances, no username
    for (const id of ["my-bets", "mybets-wallet-pending", "balance-headline", "wallet-page", "username-step"]) await expect(page.getByTestId(id), id).toHaveCount(0);
    expect(privy.length, "no Privy auth call on 'Browse as guest'").toBe(before);
    expect(await page.evaluate(() => (window as any).__e2e?.nearAddress)).toBeNull();
  });

  test("security: a guest browsing Home, a bet, Docs and the guide and pressing every action sends no write / signer / relayer / funding / registry-write request", async ({ page }) => {
    await mockReads(page);
    const seen = recordRequests(page);
    await startAsGuest(page);
    await page.goto("/");
    await ready(page);
    await expectGuestShell(page);
    await shot(page, "guest-home");
    await page.goto("/bet/1");
    await expect(page.getByTestId("bet-page")).toBeVisible();
    await expect(page.getByTestId("bet-question")).toContainText("BTC");
    await expectGuestShell(page);
    await shot(page, "guest-bet");
    await page.getByTestId("take-open").click();
    await expect(page.getByTestId("login-gate")).toBeVisible();
    await page.getByTestId("browse-as-guest").click();
    await page.goto("/bet/2");
    await expect(page.getByTestId("bet-page")).toBeVisible();
    await page.goto("/docs");
    await expect(page.getByTestId("docs-page")).toBeVisible();
    await expectGuestShell(page);
    await page.goto("/guide/custom-bet");
    await page.goto("/");
    await expectGuestShell(page);
    await page.getByTestId("nav-create").click();
    await expect(page.getByTestId("login-gate")).toBeVisible();
    await page.waitForTimeout(500);
    expect(seen.length).toBeGreaterThan(5); // the recorder really ran
    expect(seen.some((r) => r.url.startsWith(RPC) && r.body?.includes("call_function")), "the bet came from the public RPC read").toBe(true);
    expect(violations(seen)).toEqual([]);
  });

  test("bet page: Take opens 'Log in to bet' on the same URL; after login the user lands back on that bet", async ({ page }) => {
    await mockReads(page);
    await startAsGuest(page);
    await page.goto("/bet/1");
    await ready(page);
    await expect(page.getByTestId("bet-page")).toBeVisible();
    // nothing that needs an account: no wallet-only sections, the Take button is live (it leads to the login)
    await expect(page.getByTestId("take-open")).toBeEnabled();
    for (const id of ["share-section", "concede-section", "referee-section", "more-actions"]) await expect(page.getByTestId(id), id).toHaveCount(0);
    await page.getByTestId("take-open").click();
    await expect(page.getByTestId("login-gate")).toBeVisible();
    await expect(page.getByTestId("login-line")).toHaveText("Log in to bet. You will come back to this page.");
    await expect(page).toHaveURL(/\/bet\/1$/);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0); // no take modal behind the login
    expect(await page.evaluate(() => window.sessionStorage.getItem("praetorial:guest"))).toBeNull();
    await shot(page, "login-to-bet-prompt");
    // log in (seam): the same bet page renders, signed in, not a guest
    await page.evaluate(() => {
      (window as any).__e2eTestWallet = { nearAddress: "11".repeat(32), signRawHash: async () => "22".repeat(64) };
      window.dispatchEvent(new Event("e2e-wallet-changed"));
    });
    await expect(page.getByTestId("bet-page")).toBeVisible();
    await expect(page).toHaveURL(/\/bet\/1$/);
    await expect(page.getByTestId("guest-banner")).toHaveCount(0);
    await expect(page.getByTestId("nav-account")).toBeVisible();
  });

  test("'Browse as guest' after an action prompt goes back to browsing the same page", async ({ page }) => {
    await mockReads(page);
    await startAsGuest(page);
    await page.goto("/bet/1");
    await ready(page);
    await page.getByTestId("take-open").click();
    await expect(page.getByTestId("login-gate")).toBeVisible();
    await page.getByTestId("browse-as-guest").click();
    await expect(page).toHaveURL(/\/bet\/1$/);
    await expect(page.getByTestId("bet-page")).toBeVisible();
    await expectGuestShell(page);
  });

  test("Create (nav) opens the login on /new; after login the create form opens there", async ({ page }) => {
    await mockReads(page);
    await startAsGuest(page);
    await page.goto("/");
    await ready(page);
    await page.getByTestId("nav-create").click();
    await expect(page.getByTestId("login-gate")).toBeVisible();
    await expect(page).toHaveURL(/\/new$/);
    await expect(page.getByTestId("login-line")).toHaveText("Log in to bet. You will come back to this page.");
    await page.evaluate(() => {
      (window as any).__e2eTestWallet = { nearAddress: "11".repeat(32), signRawHash: async () => "22".repeat(64) };
      window.dispatchEvent(new Event("e2e-wallet-changed"));
    });
    await expect(page).toHaveURL(/\/new$/);
    await expect(page.getByTestId("create-offer-form")).toBeVisible();
  });

  test("a guest opening /account directly gets the login page (Account is an action)", async ({ page }) => {
    await mockReads(page);
    await startAsGuest(page);
    await page.goto("/account");
    await ready(page);
    await expect(page.getByTestId("login-gate")).toBeVisible();
    await expect(page).toHaveURL(/\/account$/);
    for (const id of ["wallet-page", "balance-headline", "nav-account"]) await expect(page.getByTestId(id), id).toHaveCount(0);
  });

  test("Docs for a guest: the guest nav and banner, Docs tab active", async ({ page }) => {
    await mockReads(page);
    await startAsGuest(page);
    await page.goto("/docs");
    await ready(page);
    await expect(page.getByTestId("docs-page")).toBeVisible();
    await expectGuestShell(page);
    await expect(page.getByTestId("nav-docs")).toHaveAttribute("aria-current", "page");
  });

  test("'Log in' clears the flag (login page, same URL); a session that ends never falls back to guest", async ({ page }) => {
    await mockReads(page);
    await startAsGuest(page);
    await page.goto("/docs");
    await ready(page);
    await page.getByTestId("nav-login").click();
    await expect(page.getByTestId("login-gate")).toBeVisible();
    await expect(page).toHaveURL(/\/docs$/);
    expect(await page.evaluate(() => window.sessionStorage.getItem("praetorial:guest"))).toBeNull();
    await page.evaluate(() => {
      (window as any).__e2eTestWallet = { nearAddress: "11".repeat(32), signRawHash: async () => "22".repeat(64) };
      window.dispatchEvent(new Event("e2e-wallet-changed"));
    });
    await expect(page.getByTestId("nav-account")).toBeVisible();
    // log out (the seam goes away): the login page, not guest browsing
    await page.getByTestId("nav-home").click();
    await page.evaluate(() => { delete (window as any).__e2eTestWallet; window.dispatchEvent(new Event("e2e-wallet-changed")); });
    await expect(page.getByTestId("login-gate")).toBeVisible();
    await expect(page.getByTestId("guest-banner")).toHaveCount(0);
  });

  test("logging in clears a stale guest flag (a signed-in user is never a guest)", async ({ page }) => {
    await mockReads(page);
    await startAsGuest(page);
    await page.addInitScript(() => { (window as any).__e2eTestWallet = { nearAddress: "11".repeat(32), signRawHash: async () => "22".repeat(64) }; });
    await page.goto("/");
    await ready(page);
    await expect(page.getByTestId("nav-account")).toBeVisible();
    await expect(page.getByTestId("guest-banner")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem("praetorial:guest"))).toBeNull();
  });

  test("classic brand: the same guest flow (button, shell, bet page, prompt)", async ({ page }) => {
    await mockReads(page);
    await page.goto("/?brand=classic");
    await ready(page);
    expect(await page.evaluate(() => document.documentElement.dataset.brand)).toBe("classic");
    await shot(page, "classic-login-with-guest-button");
    await page.getByTestId("browse-as-guest").click();
    await expectGuestShell(page);
    await shot(page, "classic-guest-home");
    await page.getByTestId("nav-home").click();
    await page.evaluate(() => { history.pushState({}, "", "/bet/1"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await expect(page.getByTestId("bet-page")).toBeVisible();
    await shot(page, "classic-guest-bet");
    await page.getByTestId("take-open").click();
    await expect(page.getByTestId("login-line")).toHaveText("Log in to bet. You will come back to this page.");
    await shot(page, "classic-login-to-bet-prompt");
  });
});
