// A1 (UIR1 §3.1, §3.7, §3.9-3.11; SM2 gaps A1-1..3): the shell. First login opens "Pick a username" OVER the real page (browsing
// stays open); a session that ends by itself goes back to the login page with "You were logged out." and keeps the create draft;
// ONE page notice at a time (inside the login card when logged out); About = 3 step cards + collapsed sections; not-found EmptyState;
// "← Home" on a bet page; nav Home · About · @username. Fully mocked (NEAR RPC, registry, wallet). A1_SHOTS=1 also saves screenshots.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { mkdirSync } from "node:fs";

const WALLET = "11".repeat(32);
const SIG = "22".repeat(64);
const REG = "http://registry.e2e.test";
const RPC = "https://test.rpc.fastnear.com";
const SHOTS = process.env.A1_SHOTS === "1" ? new URL("../../../spikes/a1/shots/", import.meta.url).pathname : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  const w = page.viewportSize()?.width ?? 0;
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  await page.screenshot({ path: `${SHOTS}${name}-${w}.png`, fullPage: true });
}

async function mockRpc(page: Page, flags: { paused?: boolean; shutdown?: boolean } = {}) {
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "0" });
    if (params.request_type === "call_function") {
      let r: unknown = null;
      switch (params.method_name) {
        case "is_paused": r = !!flags.paused || !!flags.shutdown; break;
        case "is_shutdown": r = !!flags.shutdown; break;
        case "open_offers": r = []; break;
        case "mt_balance_of": r = "0"; break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
}
async function mockRegistry(page: Page, st: { lookup: number | { username: string } }) {
  await page.route(`${REG}/**`, async (route) => {
    const req = route.request(); const url = new URL(req.url());
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST" } });
    if (url.pathname.startsWith("/lookup/account/")) return typeof st.lookup === "number" ? json(st.lookup, { error: "x" }) : json(200, st.lookup);
    if (url.pathname.startsWith("/lookup/")) return json(404, {});
    if (url.pathname === "/search") return json(200, []);
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
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe("A1 shell", () => {
  test("first login (no username): 'Pick a username' opens over the real page; closing it keeps browsing; Create asks again", async ({ page }) => {
    await signedIn(page); await mockRpc(page); await mockRegistry(page, { lookup: 404 });
    await page.goto("/docs"); await ready(page); // DOCS1: About is now Docs (/about redirects there)
    const sheet = page.locator("dialog[open]");
    await expect(sheet.getByTestId("username-step")).toBeVisible();
    await expect(sheet.locator("h2").first()).toHaveText("Pick a username");
    await expect(sheet.getByTestId("flow-progress")).toHaveCount(0); // one step: no progress bar / "1. Username"
    await expect(page.getByTestId("docs-page")).toBeAttached(); // the real page is under the sheet, not a gate
    await expect(page.getByTestId("username-needed")).toHaveCount(0);
    // Rules collapsed; a rule break opens them by itself.
    await expect(page.getByTestId("username-rules-row")).not.toHaveAttribute("open", "");
    await expect(page.getByTestId("username-input")).toBeFocused();
    await page.getByTestId("username-input").fill("a b");
    await expect(page.getByTestId("username-status")).toContainText("letters, digits");
    await expect(page.getByTestId("username-rules-row")).toHaveAttribute("open", "");
    await expect(page.getByTestId("username-rules")).toBeVisible();
    await shot(page, "username-sheet");
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page.getByTestId("docs-page")).toBeVisible();
    await page.getByTestId("nav-home").click();
    await expect(page.getByTestId("home")).toBeVisible();
    await page.getByTestId("nav-create").click();
    await expect(page.locator("dialog[open]").getByTestId("username-step")).toBeVisible();
  });

  test("nav: Home · Docs (DOCS1: was About) · @username; the bet page has '← Home'", async ({ page }) => {
    await signedIn(page); await mockRpc(page); await mockRegistry(page, { lookup: { username: "alice" } });
    await page.goto("/"); await ready(page);
    await expect(page.getByTestId("nav-account")).toHaveText("@alice");
    await expect(page.getByTestId("nav-home")).toHaveText("Home");
    await expect(page.getByTestId("nav-docs")).toHaveText("Docs");
    await expect(page.getByTestId("nav-about")).toHaveCount(0);
    await expect(page.getByTestId("nav-logout")).toHaveCount(0); // Log out lives on Account once ready
    await shot(page, "home-nav");
    await page.goto("/bet/7"); await ready(page);
    await page.getByTestId("bet-back-home").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("home")).toBeVisible();
  });

  test("session expiry: back to the login page, 'You were logged out.', the create draft kept", async ({ page }) => {
    await signedIn(page); await mockRpc(page); await mockRegistry(page, { lookup: { username: "alice" } });
    await page.goto("/new"); await ready(page);
    await expect(page.getByTestId("create-offer-form")).toBeVisible();
    await page.getByTestId("bet-type-card-nws_daily_high").click(); // a started draft
    await page.waitForFunction(() => sessionStorage.getItem("flowdraft:create-bet") !== null);
    const draft = await page.evaluate(() => sessionStorage.getItem("flowdraft:create-bet"));
    // Privy flips `authenticated` (here: the test wallet goes away) without the user pressing Log out.
    await page.evaluate(() => { delete (window as any).__e2eTestWallet; window.dispatchEvent(new Event("e2e-wallet-changed")); });
    await expect(page.getByTestId("login-gate")).toBeVisible();
    await expect(page.getByTestId("toast")).toHaveText(/You were logged out\./);
    await expect(page).toHaveURL(/\/new$/);
    expect(await page.evaluate(() => sessionStorage.getItem("flowdraft:create-bet"))).toBe(draft);
    await shot(page, "logged-out-toast");
    // Signing back in lands on the same create form, past the bet-type step.
    await page.evaluate(({ address, sig }) => { (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => sig }; window.dispatchEvent(new Event("e2e-wallet-changed")); }, { address: WALLET, sig: SIG });
    await expect(page.getByTestId("create-offer-form")).toBeVisible();
    await expect(page.getByTestId("bet-type-picker")).toHaveCount(0);
  });

  test("one page notice at a time: offline outranks paused; shutdown outranks offline; no repeated 'create disabled' note", async ({ page, context }) => {
    await signedIn(page); await mockRpc(page, { paused: true }); await mockRegistry(page, { lookup: { username: "alice" } });
    await page.goto("/"); await ready(page);
    await expect(page.getByTestId("banner-paused")).toBeVisible();
    await expect(page.locator("[data-page-notice]")).toHaveCount(1);
    await expect(page.getByTestId("create-disabled-note")).toHaveCount(0);
    await expect(page.getByTestId("nav-create")).toBeDisabled();
    await expect(page.getByTestId("nav-create")).toHaveAttribute("aria-describedby", "page-notice");
    await shot(page, "notice-paused");
    await context.setOffline(true);
    await expect(page.getByTestId("banner-offline")).toBeVisible();
    await expect(page.getByTestId("banner-paused")).toHaveCount(0);
    await expect(page.locator("[data-page-notice]")).toHaveCount(1);
    await context.setOffline(false);
    await expect(page.getByTestId("banner-paused")).toBeVisible();
  });

  test("logged out + paused: the notice is inside the login card, above the form", async ({ page }) => {
    await mockRpc(page, { paused: true });
    await page.goto("/"); await ready(page);
    const card = page.getByTestId("login-form");
    await expect(card.getByTestId("banner-paused")).toBeVisible();
    const n = (await card.getByTestId("banner-paused").boundingBox())!;
    const email = (await page.getByTestId("email-input").boundingBox())!;
    expect(n.y).toBeLessThan(email.y);
    await expect(page.locator("[data-page-notice]")).toHaveCount(1);
    await shot(page, "login-paused");
  });

  test("not found: an EmptyState with one way home", async ({ page }) => {
    await signedIn(page); await mockRpc(page); await mockRegistry(page, { lookup: { username: "alice" } });
    await page.goto("/no-such-page"); await ready(page);
    await expect(page.getByTestId("not-found")).toHaveAttribute("data-kit", "EmptyState");
    await expect(page.getByTestId("not-found")).toContainText("Page not found");
    await shot(page, "not-found");
    await page.getByTestId("not-found-home").click();
    await expect(page.getByTestId("home")).toBeVisible();
  });

  // DOCS1: About's sections now live in the Docs: "What Praetorial is" + the lifecycle diagram (replaces the 3 step cards, spec: "a
  // one-diagram lifecycle") open on /docs with how / fees / know collapsed; models / verify collapsed on /docs/verification.
  test("Docs (was About): 'What Praetorial is' + the lifecycle open; every About section collapsed with a summary; #verify opens Verify", async ({ page }) => {
    await signedIn(page); await mockRpc(page); await mockRegistry(page, { lookup: { username: "alice" } });
    await page.goto("/about"); await ready(page);
    await expect(page).toHaveURL(/\/docs$/);
    await expect(page.getByTestId("docs-what")).toBeVisible();
    await expect(page.getByTestId("docs-lifecycle").locator("li.docs-flow__step")).toHaveCount(6);
    for (const id of ["how", "fees", "know"]) {
      await expect(page.getByTestId(`about-${id}`)).not.toHaveAttribute("open", "");
      await expect(page.getByTestId(`about-${id}-summary`)).not.toBeEmpty();
    }
    await expect(page.getByTestId("about-fees-summary")).toHaveText("1% per side, only when someone wins");
    await shot(page, "about");
    await page.getByTestId("about-fees").locator("summary").click();
    await expect(page.getByTestId("about-fee-USDC")).toBeVisible();
    await page.goto("/docs/verification"); await ready(page);
    for (const id of ["models", "verify"]) {
      await expect(page.getByTestId(`about-${id}`)).not.toHaveAttribute("open", "");
      await expect(page.getByTestId(`about-${id}-summary`)).not.toBeEmpty();
    }
    await page.goto("/about#verify"); await ready(page);
    await expect(page).toHaveURL(/\/docs\/verification#verify$/);
    await expect(page.getByTestId("about-verify")).toHaveAttribute("open", "");
    await expect(page.getByTestId("about-dev-command")).toBeVisible();
  });

  test("375px: login, Docs (was About) and the username sheet fit with no horizontal scroll", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await signedIn(page); await mockRpc(page); await mockRegistry(page, { lookup: 404 });
    await page.goto("/docs"); await ready(page);
    await expect(page.locator("dialog[open]").getByTestId("username-step")).toBeVisible();
    expect(await noHScroll(page)).toBe(true);
    await shot(page, "username-sheet");
    await page.keyboard.press("Escape");
    expect(await noHScroll(page)).toBe(true);
    await shot(page, "about");
    await page.goto("/bet/7"); await ready(page);
    await page.keyboard.press("Escape");
    expect(await noHScroll(page)).toBe(true);
  });
});
