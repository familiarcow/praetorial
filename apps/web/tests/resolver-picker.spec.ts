// FE4 (S4 / S4b): "Who decides?" picker. Fully mocked: NEAR RPC + ticker + 1Click + the username registry via page.route,
// wallet via window.__e2eTestWallet, registry URL via window.__e2eRegistryUrl. Never a real Privy login.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";

const WALLET = "11".repeat(32); // the maker; its search-result tail is the last 8 chars: "11111111"
const SIG = "22".repeat(64);
const RPC = "https://test.rpc.fastnear.com";
const REG = "http://registry.e2e.test";
const FEE = "fee.praetorial-dev-1101.testnet"; // lib/release.json fee_account

const USERS = [
  { username: "alice", account_tail: "alice.testnet" },
  { username: "alicia_k", account_tail: "alicia-k.testnet" },
  { username: "me_myself", account_tail: "11111111" },
  { username: "feebot", account_tail: FEE },
];

async function setup(page: Page) {
  await page.addInitScript(({ address, sig, reg }) => { (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => sig }; (window as any).__e2eRegistryUrl = reg; }, { address: WALLET, sig: SIG, reg: REG });
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      const name = params.method_name;
      const r = name === "is_paused" || name === "is_shutdown" ? false : name === "open_offers" ? [] : name === "asset_limit" ? { storage_per_kib: "1" } : null;
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  await page.route(`${REG}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST" } });
    if (url.pathname.startsWith("/lookup/account/")) return json(200, { username: "me_myself" });
    if (url.pathname.startsWith("/lookup/username/")) { // FE4b: the picker resolves the full account id by exact username
      const u = USERS.find((x) => x.username === decodeURIComponent(url.pathname.split("/").pop()!));
      return u ? json(200, { username: u.username, account_id: u.account_tail }) : json(404, { error: "not_found" });
    }
    if (url.pathname === "/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return json(200, USERS.filter((u) => u.username.includes(q)));
    }
    return json(404, {});
  });
  await page.route("**/ticker**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ venue: "x", price: 100000 }) }));
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto("/new");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
  await expect(page.getByTestId("create-offer-form")).toBeVisible();
}

async function toResolver(page: Page) {
  await setup(page);
  await page.getByTestId("bet-type-card-nws_daily_high").click();
  await page.getByTestId("guided-station").selectOption("KNYC");
  await page.getByTestId("guided-date").fill("2027-12-08");
  await page.getByTestId("guided-op").selectOption(">=");
  await page.getByTestId("guided-x_f").fill("72");
  await page.getByTestId("fill-next").click();
  await expect(page.getByTestId("step-resolver")).toBeVisible();
}
const search = async (page: Page, q: string) => page.getByTestId("referee-search").fill(q);

test.describe("FE4 resolver picker (S4/S4b)", () => {
  test("the AI is the default: no search box, no tip checkbox", async ({ page }) => {
    await toResolver(page);
    await expect(page.getByTestId("decider-ai")).toBeChecked();
    await expect(page.getByTestId("referee-search")).toHaveCount(0);
    await expect(page.getByTestId("tip-maker-checkbox")).toHaveCount(0);
    await expect(page.getByTestId("referee-cost-line")).toHaveCount(0);
  });

  test("empty search prompts; no match shows 'No one with that name' and the invite text", async ({ page }) => {
    await toResolver(page);
    await page.getByTestId("decider-person").check();
    await expect(page.getByTestId("referee-search-hint")).toHaveText("Start typing a username.");
    await expect(page.getByTestId("referee-block-hint")).toHaveText("Pick someone, or switch back to the AI.");
    await search(page, "zzzz");
    await expect(page.getByTestId("referee-no-results")).toHaveText("No one with that name");
    await expect(page.getByTestId("referee-invite-text")).toContainText("Not on Praetorial yet?");
    await expect(page.getByTestId("referee-invite-text")).toContainText("join Praetorial");
    await expect(page.getByTestId("referee-invite-text")).toContainText("Once they've joined, you can pick them.");
    await search(page, "");
    await expect(page.getByTestId("referee-search-hint")).toHaveText("Start typing a username.");
    await expect(page.getByTestId("referee-no-results")).toHaveCount(0);
  });

  test("rows show username + account tail only; pick, change, clear", async ({ page }) => {
    await toResolver(page);
    await page.getByTestId("decider-person").check();
    await search(page, "ali");
    await expect(page.getByTestId("referee-result-0")).toContainText("@alice");
    await expect(page.getByTestId("referee-result-0")).toContainText("alice.testnet");
    await expect(page.getByTestId("referee-result-0")).not.toContainText("gmail");
    await page.getByTestId("referee-result-0").click();
    await expect(page.getByTestId("referee-selected")).toContainText("@alice \u2014 referee");
    await expect(page.getByTestId("referee-block-hint")).toHaveCount(0);
    await expect(page.getByTestId("referee-search")).toHaveCount(0);
    // the fixed agreement text names the person and says the other side agrees by taking the bet; nothing to accept
    await expect(page.getByTestId("referee-agree-text")).toContainText("doesn't have to accept");
    await expect(page.getByTestId("referee-agree-text")).toContainText("by taking the bet");
    // Change -> search again, old pick gone until a new one is made
    await page.getByTestId("referee-change").click();
    await expect(page.getByTestId("referee-selected")).toHaveCount(0);
    await search(page, "alicia");
    await page.getByTestId("referee-result-0").click();
    await expect(page.getByTestId("referee-selected")).toContainText("@alicia_k \u2014 referee");
    // Clear -> nobody picked, blocked hint back
    await page.getByTestId("referee-clear").click();
    await expect(page.getByTestId("referee-selected")).toHaveCount(0);
    await expect(page.getByTestId("referee-block-hint")).toBeVisible();
    // choosing the AI drops everything
    await search(page, "alice");
    await page.getByTestId("referee-result-0").click();
    await page.getByTestId("decider-ai").check();
    await expect(page.getByTestId("referee-selected")).toHaveCount(0);
    await expect(page.getByTestId("tip-maker-checkbox")).toHaveCount(0);
    await page.getByTestId("decider-person").check();
    await expect(page.getByTestId("referee-selected")).toHaveCount(0);
  });

  test("C1: a pick whose lookup lands AFTER the user switched to the AI is dropped (the AI stays the decider)", async ({ page }) => {
    await setup(page);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await toResolver(page);
    await page.getByTestId("decider-person").check();
    await search(page, "alice");
    await expect(page.getByTestId("referee-result-0")).toBeVisible();
    // later routes win: hold every registry call the pick makes (exact-username lookup, registered check), then let the mock answer
    await page.route(`${REG}/**`, async (route) => { await held; await route.fallback(); });
    await page.getByTestId("referee-result-0").click();
    await page.getByTestId("decider-ai").check();
    const answered = page.waitForResponse((r) => r.url().startsWith(REG));
    release();
    await answered;
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("decider-ai")).toBeChecked();
    await expect(page.getByTestId("referee-selected")).toHaveCount(0);
    await page.getByTestId("decider-person").check();
    await expect(page.getByTestId("referee-selected")).toHaveCount(0);
  });

  test("cannot pick yourself, the named taker or the fee account", async ({ page }) => {
    await toResolver(page);
    await page.getByTestId("decider-person").check();
    await search(page, "me_");
    await page.getByTestId("referee-result-0").click();
    await expect(page.getByTestId("referee-pick-error")).toHaveText("You can't pick yourself.");
    await expect(page.getByTestId("referee-selected")).toHaveCount(0);
    await search(page, "feebot");
    await page.getByTestId("referee-result-0").click();
    await expect(page.getByTestId("referee-pick-error")).toContainText("can't be a referee");
    await expect(page.getByTestId("referee-selected")).toHaveCount(0);
    await page.getByTestId("more-options-toggle").click(); // BET1c: More options is collapsed by default
    await page.getByTestId("taker-account-input").fill("alice.testnet");
    await search(page, "alice");
    await page.getByTestId("referee-result-0").click();
    await expect(page.getByTestId("referee-pick-error")).toContainText("Referee cannot be the taker");
    await expect(page.getByTestId("referee-selected")).toHaveCount(0);
    await expect(page.getByTestId("review-offer")).toBeVisible(); // still on the step; nothing was selected
  });

  test("the tip checkbox (off by default) changes the cost line; the tip is its own line carved from the stake", async ({ page }) => {
    await toResolver(page);
    await page.getByTestId("decider-person").check();
    await search(page, "alice");
    await page.getByTestId("referee-result-0").click();
    await expect(page.getByTestId("tip-maker-checkbox")).not.toBeChecked();
    await expect(page.getByTestId("referee-tip-line")).toContainText("to the referee when the bet ends, whatever the result");
    await expect(page.getByTestId("referee-tip-line")).toContainText("same as the platform fee on your stake");
    const off = await page.getByTestId("referee-cost-line").innerText();
    expect(off).toMatch(/No tip/);
    await page.getByTestId("tip-maker-checkbox").check();
    const on = await page.getByTestId("referee-cost-line").innerText();
    expect(on).not.toBe(off);
    expect(on).toMatch(/out of your .* stake/);
    await page.getByTestId("tip-maker-checkbox").uncheck();
    await expect(page.getByTestId("referee-cost-line")).toHaveText(off);
  });

  test("a picked person reaches the review card with no acceptance step", async ({ page }) => {
    await toResolver(page);
    await page.getByTestId("decider-person").check();
    await search(page, "alice");
    await page.getByTestId("referee-result-0").click();
    await page.getByTestId("tip-maker-checkbox").check();
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("review-card")).toBeVisible();
    // C1: the 5-line review names the person; Full terms holds the rule-by / refund rule and the tip
    await expect(page.getByTestId("review-decider")).toHaveText("@alice, a person (no AI)");
    await expect(page.getByTestId("review-term-window")).toContainText("If they don't, you're both refunded.");
    await expect(page.getByTestId("review-term-tip")).toContainText(/^Tip to the referee: [\d.]+ NEAR, out of your 10 NEAR stake\./);
    await expect(page.getByText(/waiting for .* to accept/i)).toHaveCount(0);
  });
});
