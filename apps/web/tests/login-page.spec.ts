// LOGIN1 (UX-29): logged out, the app is ONLY a full-page, two-step email login on every route. Mocked: Privy's
// passwordless endpoints via page.route (never a real OTP); "logged in" via the window.__e2eTestWallet seam.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";

const TEST_WALLET_ADDRESS = "11".repeat(32);
const TEST_SIGNATURE_HEX = "22".repeat(64);

async function mockRpc(page: Page) {
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("https://test.rpc.fastnear.com", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (params.request_type === "call_function") {
      const r = params.method_name === "is_paused" || params.method_name === "is_shutdown" ? false : params.method_name === "open_offers" ? [] : null;
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
}
async function ready(page: Page) {
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
}
/** Privy's headless email OTP: /passwordless/init sends the code, /passwordless/authenticate checks it. */
async function mockPrivyOtp(page: Page, opts: { init?: number; auth?: { status: number; body: unknown } } = {}) {
  const sent: string[] = [];
  await page.route("https://auth.privy.io/api/v1/passwordless/init", async (r) => {
    sent.push(JSON.parse(r.request().postData() ?? "{}").email);
    const status = opts.init ?? 200;
    await r.fulfill({ status, contentType: "application/json", body: JSON.stringify(status === 200 ? { success: true } : { error: "upstream_failure" }) });
  });
  await page.route("https://auth.privy.io/api/v1/passwordless/authenticate", (r) =>
    r.fulfill({ status: opts.auth?.status ?? 401, contentType: "application/json", body: JSON.stringify(opts.auth?.body ?? { error: "Invalid email and code combination", code: "invalid_credentials" }) }));
  return sent;
}

async function expectOnlyLoginPage(page: Page) {
  await expect(page.getByTestId("login-gate")).toBeVisible();
  await expect(page.locator("nav")).toHaveCount(0);
  for (const id of ["nav-home", "nav-about", "nav-docs", "nav-account", "home", "add-money", "browse-list", "bet-view", "bet-readonly", "my-bets", "status"]) { // NAV1: the new shell ids are behind the login too
    await expect(page.getByTestId(id), id).toHaveCount(0);
  }
  await expect(page.locator('[role="dialog"]')).toHaveCount(0); // a page, not a modal/overlay
}

test.describe("LOGIN1 full-page two-step login (mocked)", () => {
  // DOCS1: /judges (old About) now redirects to the public Docs, so it is not a login-only path any more (tested below).
  for (const path of ["/", "/browse", "/new", "/my-bets", "/settings", "/add-money", "/bet/7", "/nope"]) {
    test(`logged out ${path}: only the login page, email step, no code field`, async ({ page }) => {
      await mockRpc(page);
      await page.goto(path);
      await ready(page);
      await expectOnlyLoginPage(page);
      await expect(page.getByTestId("login-brand")).toHaveText("Praetorial");
      await expect(page.getByTestId("email-input")).toBeVisible();
      await expect(page.getByTestId("send-code")).toHaveText("Send code");
      await expect(page.getByTestId("otp-input")).toHaveCount(0);
      await expect(page.getByTestId("submit-code")).toHaveCount(0);
      await expect(page.getByTestId("code-sent")).toHaveCount(0);
      // NAV1 + F3: pages folded into Home / About / Account redirect first (the login then returns to the new address).
      const moved: Record<string, string> = { "/browse": "/", "/my-bets": "/", "/add-money": "/account", "/settings": "/account" };
      expect(new URL(page.url()).pathname).toBe(moved[path] ?? path);
    });
  }

  // DOCS1: About became the public Docs; its old paths land there logged out (no login page, no app nav).
  for (const path of ["/judges", "/about"]) {
    test(`logged out ${path}: redirects to the public Docs, not the login page`, async ({ page }) => {
      await mockRpc(page);
      await page.goto(path);
      await ready(page);
      await expect(page).toHaveURL(path === "/about" ? /\/docs$/ : /\/docs\/verification#models$/);
      await expect(page.getByTestId("docs-page")).toBeVisible();
      await expect(page.getByTestId("login-gate")).toHaveCount(0);
      for (const id of ["nav-home", "nav-docs", "nav-account", "home", "my-bets", "status"]) await expect(page.getByTestId(id), id).toHaveCount(0);
    });
  }

  test("step 1: a bad email shows a plain inline error and no code field", async ({ page }) => {
    await mockRpc(page);
    const sent = await mockPrivyOtp(page);
    await page.goto("/");
    await ready(page);
    await page.getByTestId("email-input").fill("not-an-email");
    await page.getByTestId("send-code").click();
    await expect(page.getByTestId("login-error")).toHaveText("Enter a valid email address.");
    await expect(page.getByTestId("otp-input")).toHaveCount(0);
    expect(sent).toEqual([]);
  });

  test("step 1: a failed send stays on the email step with a plain message (Enter submits)", async ({ page }) => {
    await mockRpc(page);
    await mockPrivyOtp(page, { init: 400 }); // 4xx: Privy's client retries 5xx with backoff, so a 4xx is the deterministic failure
    await page.goto("/");
    await ready(page);
    await page.getByTestId("email-input").fill("a@b.co");
    await page.getByTestId("email-input").press("Enter");
    await expect(page.getByTestId("login-error")).toBeVisible();
    await expect(page.getByTestId("login-error")).not.toContainText(/upstream|400|Error/);
    await expect(page.getByTestId("send-code")).toBeEnabled();
    await expect(page.getByTestId("otp-input")).toHaveCount(0);
  });

  test("step 2 after a successful send: sent-to line, code field, wrong code inline, resend countdown, use a different email", async ({ page }) => {
    await mockRpc(page);
    const sent = await mockPrivyOtp(page);
    await page.goto("/");
    await ready(page);
    await page.getByTestId("email-input").fill("familiarcow@example.com");
    await page.getByTestId("send-code").click();
    await expect(page.getByTestId("code-sent")).toHaveText("We sent a code to familiarcow@example.com.");
    expect(sent).toEqual(["familiarcow@example.com"]);
    await expect(page.getByTestId("email-input")).toHaveCount(0);
    await expect(page.getByTestId("otp-input")).toBeVisible();
    await expect(page.getByTestId("resend-code")).toBeDisabled();
    await expect(page.getByTestId("resend-code")).toContainText(/Resend code \(\d+s\)/);
    await expectOnlyLoginPage(page);

    await page.getByTestId("submit-code").click();
    await expect(page.getByTestId("login-error")).toHaveText("Enter the 6-digit code from your email.");
    await page.getByTestId("otp-input").fill("123456");
    await page.getByTestId("submit-code").click();
    await expect(page.getByTestId("login-error")).toHaveText("That code didn't work. Try again or send a new one.");
    await expect(page.getByTestId("otp-input")).toBeVisible();

    await page.getByTestId("change-email").click();
    await expect(page.getByTestId("otp-input")).toHaveCount(0);
    await expect(page.getByTestId("email-input")).toHaveValue("familiarcow@example.com");
    await expect(page.getByTestId("login-error")).toHaveCount(0);
  });

  test("Resend code re-sends to the same email once the countdown ends", async ({ page }) => {
    await page.clock.install();
    await mockRpc(page);
    const sent = await mockPrivyOtp(page);
    await page.goto("/");
    await ready(page);
    await page.getByTestId("email-input").fill("a@b.co");
    await page.getByTestId("send-code").click();
    await expect(page.getByTestId("otp-input")).toBeVisible();
    for (let i = 0; i < 31; i++) await page.clock.runFor(1000);
    await expect(page.getByTestId("resend-code")).toBeEnabled();
    await expect(page.getByTestId("resend-code")).toHaveText("Resend code");
    await page.getByTestId("resend-code").click();
    await expect(page.getByTestId("resend-code")).toBeDisabled();
    expect(sent).toEqual(["a@b.co", "a@b.co"]);
    await expect(page.getByTestId("code-sent")).toHaveText("We sent a code to a@b.co.");
  });

  test("deep link /bet/7: login page names the bet; once signed in the same URL shows the app", async ({ page }) => {
    await mockRpc(page);
    await page.goto("/bet/7");
    await ready(page);
    await expect(page.getByTestId("login-line")).toHaveText("Log in to see bet #7. You will go straight to it.");
    await page.evaluate(({ address, sig }) => {
      (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => sig };
      window.dispatchEvent(new Event("e2e-wallet-changed"));
    }, { address: TEST_WALLET_ADDRESS, sig: TEST_SIGNATURE_HEX });
    await expect(page.getByTestId("bet-view")).toBeVisible();
    await expect(page.getByTestId("login-gate")).toHaveCount(0);
    await expect(page.getByTestId("nav-home")).toBeVisible();
    await expect(page).toHaveURL(/\/bet\/7$/);
  });

  // A1 (UIR1 §3.1 suspected bug): Privy's client retries a 5xx / unanswered send with backoff, so the button sat on "Sending…"
  // (disabled) with no error. A send that has not answered after SEND_TIMEOUT_MS gives up with a plain error and a usable button.
  for (const mode of ["never answers", "keeps failing 5xx"] as const) {
    test(`step 1: a send that ${mode} stops 'Sending…' with a plain error (never hangs)`, async ({ page }) => {
      test.setTimeout(60_000);
      await mockRpc(page);
      await page.route("https://auth.privy.io/api/v1/passwordless/init", async (r) => {
        if (mode === "keeps failing 5xx") return r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "upstream_failure" }) });
        // never answered
      });
      await page.goto("/");
      await ready(page);
      await page.getByTestId("email-input").fill("a@b.co");
      await page.getByTestId("send-code").click();
      await expect(page.getByTestId("send-code")).toHaveText("Sending…");
      await expect(page.getByTestId("login-error")).toHaveText("We couldn't send the code. Try again.", { timeout: 25_000 });
      await expect(page.getByTestId("send-code")).toHaveText("Send code");
      await expect(page.getByTestId("send-code")).toBeEnabled();
      await expect(page.getByTestId("otp-input")).toHaveCount(0);
    });
  }

  test("375px: both steps fit with no horizontal scroll", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await mockRpc(page);
    await mockPrivyOtp(page);
    await page.goto("/");
    await ready(page);
    const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await noHScroll()).toBe(true);
    await page.getByTestId("email-input").fill("someone.with.a.long.address@example.com");
    await page.getByTestId("send-code").click();
    await expect(page.getByTestId("otp-input")).toBeVisible();
    expect(await noHScroll()).toBe(true);
    const box = (await page.getByTestId("submit-code").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
  });
});
