// FE2: login copy, username step (S1b) and add-money screen (S1c), fully mocked: NEAR RPC via page.route, the registry
// service via page.route, the wallet via window.__e2eTestWallet, the registry URL via window.__e2eRegistryUrl.
// Never a real Privy login/OTP.
import { swappableRoute } from "./swappableRoute";
import { base58FromHex } from "../lib/delegate";
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";

const WALLET = "11".repeat(32);
const SIG = "22".repeat(64);
const REG = "http://registry.e2e.test";
const RPC = "https://test.rpc.fastnear.com";

type Reg = { lookup: number | { username: string }; users: { username: string; account_tail: string }[]; claim: { status: number; body: any }; calls: { path: string; body?: any }[] };

async function mockRpc(page: Page, usdcUnits = "0", balanceStatus: "ok" | "fail" = "ok") {
  const mode = { usdcUnits, balanceStatus }; // FE10f: mutable, so a spec changes behaviour with no unroute gap (see swappableRoute)
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" })); // FE10e: never the real 1Click API
  await swappableRoute(page, RPC, async (route) => {
    const { usdcUnits, balanceStatus } = mode;
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8"));
      let r: unknown = null;
      if (params.method_name === "is_paused" || params.method_name === "is_shutdown") r = false;
      else if (params.method_name === "open_offers") r = [];
      else if (params.method_name === "mt_balance_of") {
        if (balanceStatus === "fail") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -32000, message: "boom" } }) });
        r = args.token_id === "nep141:usdc.testnet" ? usdcUnits : "0";
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  return { setBalance(units: string, status: "ok" | "fail" = "ok") { mode.usdcUnits = units; mode.balanceStatus = status; } };
}

async function mockRegistry(page: Page, reg: Partial<Reg> = {}) {
  const state: Reg = { lookup: 404, users: [], claim: { status: 200, body: {} }, calls: [], ...reg };
  await page.route(`${REG}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST" } });
    state.calls.push({ path: url.pathname + url.search, body: req.method() === "POST" ? JSON.parse(req.postData() ?? "{}") : undefined });
    if (url.pathname.startsWith("/lookup/account/")) {
      if (typeof state.lookup === "number") return json(state.lookup, { error: state.lookup === 404 ? "not_found" : "internal" });
      return json(200, state.lookup);
    }
    if (url.pathname === "/search") return json(200, state.users);
    if (url.pathname === "/claim") return json(state.claim.status, state.claim.body);
    return json(404, {});
  });
  return state;
}

async function signedIn(page: Page, withRegistry = true) {
  await page.addInitScript(({ address, sig, reg }) => {
    (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => sig };
    if (reg) (window as any).__e2eRegistryUrl = reg;
  }, { address: WALLET, sig: SIG, reg: withRegistry ? REG : "" });
}
const ready = (page: Page) => page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });

test.describe("FE2 login copy", () => {
  test("login form shows the spec title and a plain validation message for a bad email", async ({ page }) => {
    await mockRpc(page);
    await page.goto("/");
    await ready(page);
    await expect(page.getByTestId("login-form")).toContainText("Log in with your email");
    await page.getByTestId("email-input").fill("not-an-email");
    await page.getByTestId("send-code").click();
    await expect(page.getByTestId("login-error")).toHaveText("Enter a valid email address.");
  });
});

test.describe("FE2 username step (S1b)", () => {
  test("free -> claimed: live check says available, rules are shown, claim posts a NEP-413 signed body, then the app opens", async ({ page }) => {
    await signedIn(page);
    await mockRpc(page, "20000000");
    const reg = await mockRegistry(page, { lookup: 404, users: [], claim: { status: 200, body: { username: "alice_9", account_id: WALLET } } });
    await page.goto("/new");
    await ready(page);
    await expect(page.getByTestId("username-step")).toBeVisible();
    await expect(page.getByTestId("create-offer-form")).toHaveCount(0);
    await expect(page.getByTestId("username-rules")).toContainText("3 to 20");
    await expect(page.getByTestId("username-step")).toContainText("Your email is never shown.");
    await expect(page.getByTestId("username-discoverable")).toBeChecked();
    await page.getByTestId("username-input").fill("Alice_9");
    await expect(page.getByTestId("username-status")).toHaveText("@alice_9 is available");
    await page.getByTestId("username-claim-btn").click();
    await expect(page.getByTestId("username-step")).toHaveCount(0);
    await expect(page.getByTestId("create-offer-form")).toBeVisible();
    const claim = reg.calls.find((c) => c.path === "/claim")!;
    expect(claim.body.username).toBe("alice_9");
    expect(claim.body.account_id).toBe(WALLET);
    // REGCLAIM1: the registry requires NEAR key form ed25519:<base58>, not the raw-hex account id.
    expect(claim.body.public_key).toBe(`ed25519:${base58FromHex(WALLET)}`);
    expect(Buffer.from(claim.body.signature, "base64").length).toBe(64);
    expect(Buffer.from(claim.body.nonce, "base64").length).toBe(32);
    expect(claim.body.discoverable).toBeUndefined();
  });

  test("unticking 'Let people find me as a referee' sends discoverable:false", async ({ page }) => {
    await signedIn(page);
    await mockRpc(page, "20000000");
    const reg = await mockRegistry(page, { claim: { status: 200, body: { username: "quiet_one", account_id: WALLET } } });
    await page.goto("/new");
    await ready(page);
    await page.getByTestId("username-input").fill("quiet_one");
    await page.getByTestId("username-discoverable").uncheck();
    await expect(page.getByTestId("username-status")).toContainText("available");
    await page.getByTestId("username-claim-btn").click();
    await expect(page.getByTestId("create-offer-form")).toBeVisible();
    expect(reg.calls.find((c) => c.path === "/claim")!.body.discoverable).toBe(false);
  });

  test("taken: live message with a suggestion, claim disabled", async ({ page }) => {
    await signedIn(page);
    await mockRpc(page);
    await mockRegistry(page, { users: [{ username: "alice", account_tail: "bob.testnet" }] });
    await page.goto("/new");
    await ready(page);
    await page.getByTestId("username-input").fill("alice");
    await expect(page.getByTestId("username-status")).toContainText("That name is taken. Try ");
    await expect(page.getByTestId("username-claim-btn")).toBeDisabled();
  });

  test("look-alike refused: a1ice vs existing alice", async ({ page }) => {
    await signedIn(page);
    await mockRpc(page);
    await mockRegistry(page, { users: [{ username: "alice", account_tail: "bob.testnet" }] });
    await page.goto("/new");
    await ready(page);
    await page.getByTestId("username-input").fill("a1ice");
    await expect(page.getByTestId("username-status")).toHaveText("That name looks too much like @alice. Pick a different one.");
    await expect(page.getByTestId("username-claim-btn")).toBeDisabled();
  });

  test("server refusal after a free check (race): taken 409 and reserved 400 map to messages", async ({ page }) => {
    await signedIn(page);
    await mockRpc(page);
    const reg = await mockRegistry(page, { claim: { status: 409, body: { error: "username_taken" } } });
    await page.goto("/new");
    await ready(page);
    await page.getByTestId("username-input").fill("sam_x");
    await expect(page.getByTestId("username-status")).toContainText("available");
    await page.getByTestId("username-claim-btn").click();
    await expect(page.getByTestId("username-error")).toContainText("That name is taken. Try ");
    await expect(page.getByTestId("username-step")).toBeVisible();
    reg.claim = { status: 400, body: { error: "username_reserved" } };
    await page.getByTestId("username-claim-btn").click();
    await expect(page.getByTestId("username-error")).toContainText("can't be used");
  });

  test("reserved and bad names are refused locally, with no registry search", async ({ page }) => {
    await signedIn(page);
    await mockRpc(page);
    const reg = await mockRegistry(page);
    await page.goto("/new");
    await ready(page);
    await page.getByTestId("username-input").fill("adm1n");
    await expect(page.getByTestId("username-status")).toContainText("can't be used");
    await page.getByTestId("username-input").fill("ab");
    await expect(page.getByTestId("username-status")).toContainText("at least 3");
    await page.getByTestId("username-input").fill("al ice");
    await expect(page.getByTestId("username-status")).toContainText("letters, digits");
    await expect(page.getByTestId("username-claim-btn")).toBeDisabled();
    expect(reg.calls.filter((c) => c.path.startsWith("/search"))).toHaveLength(0);
  });

  // SM2 (familiarcow 2026-11-11: every bettor has a Praetorial account): a registry outage no longer lets a user bet unnamed; they can look
  // around and Create is held behind "Try again" (tests/sm2-gate.spec.ts covers the retry).
  test("registry down: plain note, user can look around but Create waits for the registry", async ({ page }) => {
    await signedIn(page);
    await mockRpc(page, "20000000");
    await mockRegistry(page, { lookup: 500 });
    await page.goto("/new");
    await ready(page);
    await expect(page.getByTestId("registry-down-note")).toHaveText("We can't reach usernames right now. You can look around; betting needs a username, so try again in a moment.");
    await expect(page.getByTestId("create-gate")).toHaveAttribute("data-gate", "username-unknown");
    await expect(page.getByTestId("create-offer-form")).toHaveCount(0);
    await expect(page.getByTestId("username-step")).toHaveCount(0);
  });

  test("a user who already has a name never sees the step", async ({ page }) => {
    await signedIn(page);
    await mockRpc(page, "20000000");
    await mockRegistry(page, { lookup: { username: "alice" } });
    await page.goto("/new");
    await ready(page);
    await expect(page.getByTestId("create-offer-form")).toBeVisible();
    await expect(page.getByTestId("username-step")).toHaveCount(0);
  });

  test("no registry configured (live/dev default): no step, app works", async ({ page }) => {
    await signedIn(page, false);
    await mockRpc(page, "20000000");
    await page.goto("/new");
    await ready(page);
    await expect(page.getByTestId("create-offer-form")).toBeVisible();
    await expect(page.getByTestId("username-step")).toHaveCount(0);
  });
});

test.describe("FE2 add money (S1c)", () => {
  test("empty balance shows the add-money screen: balance, shortfall, per-asset rows (FE2c: never the account id as an address)", async ({ page }) => {
    await signedIn(page);
    await mockRpc(page, "0");
    await mockRegistry(page, { lookup: { username: "alice" } });
    await page.goto("/add-money?asset=USDC&need=12.55");
    await ready(page);
    await expect(page.getByTestId("add-money")).toBeVisible();
    await expect(page.getByTestId("balance-headline")).toHaveText("Your balance: 0.00 USDC. You need 12.55 USDC more.");
    await expect(page.getByTestId("deposit-address")).toHaveCount(0);
    // F3 (PEOPLE RULE): the account id appears once, only inside the collapsed Account details row, labelled as the account ID.
    await expect(page.getByText(WALLET)).toHaveCount(1);
    await expect(page.getByTestId("account-details").getByText(WALLET)).toHaveCount(1);
    await expect(page.getByTestId("balance-row-USDC")).toContainText("0.00 USDC");
    await expect(page.getByTestId("balance-row-NEAR")).toBeVisible();
  });

  test("no bet in progress: spec empty copy; partly funded shows the exact remaining shortfall", async ({ page }) => {
    await signedIn(page);
    const rpc = await mockRpc(page, "0");
    await mockRegistry(page, { lookup: { username: "alice" } });
    await page.goto("/add-money");
    await ready(page);
    // F3: no bet in progress -> the token rows (1 NEAR sits on the NEAR account here, so this is not the empty hero), no hand-off headline.
    await expect(page.getByTestId("balance-row-USDC")).toHaveText("0.00 USDC");
    await expect(page.getByTestId("wallet-amount-NEAR")).toHaveText("In your NEAR account: 1 NEAR");
    await expect(page.getByTestId("balance-headline")).toHaveCount(0);
    rpc.setBalance("5000000");
    await page.goto("/add-money?asset=USDC&need=12.55");
    await ready(page);
    await expect(page.getByTestId("balance-headline")).toHaveText("Your balance: 5.00 USDC. You need 7.55 USDC more.");
  });

  test("balance read failure: plain message and a Retry that works", async ({ page }) => {
    await signedIn(page);
    const rpc = await mockRpc(page, "0", "fail");
    await mockRegistry(page, { lookup: { username: "alice" } });
    await page.goto("/add-money");
    await ready(page);
    await expect(page.getByTestId("balance-error")).toContainText("We can't read your balance right now.");
    await expect(page.getByTestId("balance-row-USDC")).toHaveText("Can't read"); // never a 0
    rpc.setBalance("3000000"); // FE10f: in-place swap; unroute+route let in-flight holdings reads escape to the guard
    await page.getByTestId("balance-retry").click();
    await expect(page.getByTestId("balance-error")).toHaveCount(0);
    await expect(page.getByTestId("balance-row-USDC")).toHaveText("3.00 USDC");
  });

  test("logged out /add-money is login-gated", async ({ page }) => {
    await mockRpc(page);
    await page.goto("/add-money");
    await ready(page);
    await expect(page.getByTestId("login-gate")).toBeVisible();
    await expect(page.getByTestId("add-money")).toHaveCount(0);
  });

  test("first login with an empty balance: claiming a name lands on the deposit screen", async ({ page }) => {
    await signedIn(page);
    await mockRpc(page, "0");
    await mockRegistry(page, { claim: { status: 200, body: { username: "newbie", account_id: WALLET } } });
    await page.goto("/new");
    await ready(page);
    await page.getByTestId("username-input").fill("newbie");
    await expect(page.getByTestId("username-status")).toContainText("available");
    await page.getByTestId("username-claim-btn").click();
    await expect(page.getByTestId("add-money")).toBeVisible();
    await expect(page).toHaveURL(/\/account$/); // NAV1 + F3: Add money is on the Account page (was Wallet)
  });
});
