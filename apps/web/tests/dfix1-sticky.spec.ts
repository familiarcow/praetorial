// DFIX1 (familiarcow 11-13, desktop, praetorial brand), mocked: scrolled /docs, the Docs sidebar sat on top of the sticky app nav, covering
// the logo. The sidebar must stick BELOW the app nav (top from the nav's measured height, --app-nav-h) and never paint over it; the
// app nav stays above all page content. Both brands; 1280 (sticky sidebar) and 375 (sidebar scrolls with the page).
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";

const ME = "11".repeat(32);
const SIG = "22".repeat(64);
const RPC = "https://test.rpc.fastnear.com";

async function mock(page: Page) {
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("http://localhost:8787/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const p = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (p.request_type === "view_account") return ok({ amount: "0" });
    if (p.request_type === "call_function") {
      let r: unknown = null;
      if (p.method_name === "is_paused" || p.method_name === "is_shutdown") r = false;
      else if (p.method_name === "open_offers" || p.method_name === "pending_payouts") r = [];
      else if (p.method_name === "mt_balance_of" || p.method_name === "ft_balance_of") r = "0";
      else if (p.method_name === "judge_chain") r = [{ model_a: "deepseek-ai/DeepSeek-V4.1-Flash-1017", model_b: "z-ai/glm-5.3-flash" }];
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
}
const signIn = (page: Page) => page.addInitScript(({ a, s }) => { (window as any).__e2eTestWallet = { nearAddress: a, signRawHash: async () => s }; }, { a: ME, s: SIG });
const ready = (page: Page) => page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });

/** Every point along the app nav's bottom row (and the logo's centre) hit-tests to the app nav, not to page content. */
async function navOnTop(page: Page) {
  return page.evaluate(() => {
    const nav = document.querySelector(".app-nav") as HTMLElement;
    const r = nav.getBoundingClientRect();
    const logo = (document.querySelector('[data-testid="nav-brand"]') as HTMLElement).getBoundingClientRect();
    const pts: [number, number][] = [[logo.left + logo.width / 2, logo.top + logo.height / 2]];
    for (let x = r.left + 4; x < r.right; x += 40) pts.push([x, r.bottom - 3], [x, r.top + r.height / 2]);
    const bad = pts.map(([x, y]) => ({ x, y, el: document.elementFromPoint(x, y) }))
      .filter((p) => !p.el || !nav.contains(p.el))
      .map((p) => `${Math.round(p.x)},${Math.round(p.y)} -> ${p.el?.tagName}.${(p.el as HTMLElement | null)?.className ?? ""}`);
    return { navTop: r.top, navBottom: r.bottom, bad };
  });
}

for (const brand of ["praetorial", "classic"] as const) {
  test.describe(`DFIX1 sticky app nav vs Docs sidebar (${brand})`, () => {
    test(`1280: scrolled /docs, the sidebar sticks below the app nav and never covers it`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await signIn(page); await mock(page);
      await page.goto(`/docs/trust?brand=${brand}`); await ready(page);
      await expect(page.getByTestId("docs-trust")).toBeVisible();
      await expect(page.locator(".app-nav")).toBeVisible();
      for (const y of [400, 1200, 99999]) {
        await page.evaluate((y) => window.scrollTo(0, y), y);
        await page.waitForFunction(() => window.scrollY > 0);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        const { navTop, navBottom, bad } = await navOnTop(page);
        expect(navTop, "the app nav stays pinned").toBeLessThanOrEqual(0.5);
        const side = (await page.getByTestId("docs-nav").boundingBox())!;
        expect(side.y, `sidebar top (${side.y}) >= nav bottom (${navBottom}) at scrollY ${y}`).toBeGreaterThanOrEqual(navBottom - 0.5);
        expect(bad, "page content painted over the app nav").toEqual([]);
      }
      // the gap comes from the nav's measured height, not a magic number
      const v = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--app-nav-h").trim());
      const h = await page.evaluate(() => (document.querySelector(".app-nav") as HTMLElement).getBoundingClientRect().height);
      expect(parseFloat(v)).toBeCloseTo(h, 0);
    });

    test(`375: scrolled /docs, nothing paints over the app nav`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 740 });
      await signIn(page); await mock(page);
      await page.goto(`/docs/trust?brand=${brand}`); await ready(page);
      await expect(page.getByTestId("docs-trust")).toBeVisible();
      for (const y of [300, 1500]) {
        await page.evaluate((y) => window.scrollTo(0, y), y);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        const { bad } = await navOnTop(page);
        expect(bad, "page content painted over the app nav").toEqual([]);
      }
    });
  });
}
