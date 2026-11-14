// DOCS1 (familiarcow via b0nd 11-12), mocked: Docs replaced About. Every Docs page renders logged out at its own URL; the app nav shows
// Docs and not About; /about (and its old deep links) redirect to the Docs instead of a 404; every link inside the Docs resolves;
// the Trust page is in the Docs nav and every command block on it has a CLAIMS.md entry.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { readFileSync } from "node:fs";
import { DOCS_PAGES, docsPath } from "../lib/docs";

const ME = "11".repeat(32);
const SIG = "22".repeat(64);
const RPC = "https://test.rpc.fastnear.com";
// DOCS2 took the Docs over: a command's claim entry may be in DOCS1's or DOCS2's CLAIMS.md.
const CLAIMS = ["docs1", "docs2"].map((d) => readFileSync(new URL(`../../../spikes/${d}/CLAIMS.md`, import.meta.url), "utf8")).join("\n");
/** lib/docsPublic.json is the one list (lib/docsFacts.ts EXTERNAL_ORIGINS reads it too). */
const EXTERNAL_ORIGINS: string[] = JSON.parse(readFileSync(new URL("../lib/docsPublic.json", import.meta.url), "utf8")).externalOrigins;

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

test.describe("DOCS1 Docs (replaced About)", () => {
  for (const p of DOCS_PAGES) {
    test(`logged out: ${docsPath(p.id)} renders "${p.title}" with the Docs nav, no login form and no app nav`, async ({ page }) => {
      await mock(page);
      await page.goto(docsPath(p.id)); await ready(page);
      await expect(page).toHaveURL(new RegExp(`${docsPath(p.id).replace(/\//g, "\\/")}$`));
      await expect(page.getByTestId(`docs-${p.id}`)).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(p.title);
      await expect(page.getByTestId("docs-nav")).toBeVisible();
      for (const q of DOCS_PAGES) await expect(page.getByTestId(`docs-nav-${q.id}`)).toHaveText(q.title);
      await expect(page.getByTestId(`docs-nav-${p.id}`)).toHaveAttribute("aria-current", "page");
      await expect(page.getByTestId("docs-login")).toBeVisible();
      await expect(page.getByTestId("login-gate")).toHaveCount(0);
      await expect(page.getByTestId("email-input")).toHaveCount(0);
      for (const id of ["nav-home", "nav-docs", "nav-account", "not-found"]) await expect(page.getByTestId(id), id).toHaveCount(0);
      await expect(page).toHaveTitle(`${p.title} · Praetorial docs`);
    });
  }

  test("logged out: /about redirects to /docs (never a 404); /about#verify, /judges and #judge-models land on the right section", async ({ page }) => {
    await mock(page);
    await page.goto("/about"); await ready(page);
    await expect(page).toHaveURL(/\/docs$/);
    await expect(page.getByTestId("docs-what")).toBeVisible();
    await expect(page.getByTestId("not-found")).toHaveCount(0);
    await page.goto("/about#verify"); await ready(page);
    await expect(page).toHaveURL(/\/docs\/verification#verify$/);
    await expect(page.getByTestId("about-verify")).toHaveAttribute("open", "");
    await expect(page.getByTestId("about-dev-command")).toBeVisible();
    await page.goto("/judges"); await ready(page);
    await expect(page).toHaveURL(/\/docs\/verification#models$/);
    await expect(page.getByTestId("about-models")).toHaveAttribute("open", "");
    await page.goto("/#judge-models"); await ready(page);
    await expect(page).toHaveURL(/\/docs\/verification#models$/);
  });

  test("logged in: the nav shows Docs and not About; Docs opens /docs in place; /about redirects there too", async ({ page }) => {
    await signIn(page); await mock(page);
    await page.goto("/"); await ready(page);
    await expect(page.getByTestId("nav-docs")).toHaveText("Docs");
    await expect(page.getByTestId("nav-about")).toHaveCount(0);
    await expect(page.locator("nav").first().getByText("About", { exact: true })).toHaveCount(0);
    await page.evaluate(() => { (window as any).__noReload = true; });
    await page.getByTestId("nav-docs").click();
    await expect(page).toHaveURL(/\/docs$/);
    await expect(page.getByTestId("docs-what")).toBeVisible();
    await expect(page.getByTestId("nav-docs")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("docs-public-head")).toHaveCount(0); // logged in: the app nav, not the public header
    await page.getByTestId("docs-nav-trust").click();
    await expect(page).toHaveURL(/\/docs\/trust$/);
    await expect(page.getByTestId("docs-trust")).toBeVisible();
    expect(await page.evaluate(() => (window as any).__noReload)).toBe(true); // routed in place, no reload
    await page.goto("/about"); await ready(page);
    await expect(page).toHaveURL(/\/docs$/);
    await expect(page.getByTestId("docs-what")).toBeVisible();
    await expect(page.getByTestId("nav-docs")).toHaveAttribute("aria-current", "page");
  });

  test("every link inside the Docs resolves: internal pages render (no not-found), #anchors exist, external links are the listed public sites", async ({ page, request }) => {
    await mock(page);
    const internal = new Set<string>();
    for (const p of DOCS_PAGES) {
      await page.goto(docsPath(p.id)); await ready(page);
      const hrefs = await page.locator('[data-testid="docs-page"] a[href], [data-testid="docs-public-head"] a[href]').evaluateAll((as) => as.map((a) => a.getAttribute("href")!));
      expect(hrefs.length, p.id).toBeGreaterThan(5);
      for (const h of hrefs) {
        if (h.startsWith("/")) { internal.add(h); continue; }
        expect(EXTERNAL_ORIGINS, `${p.id}: ${h}`).toContain(new URL(h).origin);
      }
    }
    for (const h of internal) {
      const [path, hash] = h.split("#");
      if (/\.(mjs|json)$/.test(path!)) { // a file this site serves (verify-bet.mjs)
        const r = await request.get(path!);
        expect(r.status(), h).toBe(200);
        expect(await r.text(), h).toContain("verify-bet.mjs");
        continue;
      }
      await page.goto(h); await ready(page);
      await expect(page.getByTestId("not-found"), h).toHaveCount(0);
      if (path!.startsWith("/docs")) await expect(page.getByTestId("docs-page"), h).toBeVisible();
      else if (path === "/guide/custom-bet") await expect(page.getByTestId("guide-page"), h).toBeVisible();
      else await expect(page.getByTestId("email-input").or(page.getByTestId("docs-page")), h).toBeVisible(); // "/" logged out = the login page
      if (hash) await expect(page.locator(`[id="${hash}"]`), h).toHaveCount(1);
    }
    expect([...internal]).toEqual(expect.arrayContaining(["/docs", "/docs/verification", "/docs/near-intents", "/docs/trust", "/docs/hackathon", "/guide/custom-bet"]));
  });

  test("Trust page: in the Docs nav, renders logged out, and every command block on it has a CLAIMS.md entry", async ({ page }) => {
    await mock(page);
    await page.goto("/docs"); await ready(page);
    await page.getByTestId("docs-nav-trust").click();
    await expect(page).toHaveURL(/\/docs\/trust$/);
    await expect(page.getByTestId("docs-trust")).toBeVisible();
    await expect(page.getByTestId("trust-table").locator("tbody tr")).toHaveCount(8);
    await expect(page.getByTestId("trust-steps").locator(":scope > li")).toHaveCount(12);
    const ids = await page.locator("[data-cmd]").evaluateAll((els) => els.map((e) => e.getAttribute("data-cmd")!));
    expect(ids.length).toBeGreaterThanOrEqual(14);
    for (const id of ids) expect(CLAIMS, `CLAIMS.md entry for cmd:${id}`).toContain(`cmd:${id}`);
    await page.goto("/docs/hackathon"); await ready(page);
    for (const id of await page.locator("[data-cmd]").evaluateAll((els) => els.map((e) => e.getAttribute("data-cmd")!))) {
      expect(CLAIMS, `CLAIMS.md entry for cmd:${id}`).toContain(`cmd:${id}`);
    }
  });

  test("375 px: the Docs pages don't scroll sideways, and the lifecycle and trust table stack", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await mock(page);
    for (const p of DOCS_PAGES) {
      await page.goto(docsPath(p.id)); await ready(page);
      const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      expect(w[0], `${p.id} scrollWidth`).toBeLessThanOrEqual(w[1]!);
    }
    await page.goto("/docs"); await ready(page);
    const boxes = await page.locator('[data-testid^="flow-"]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
    expect(boxes.length).toBe(6);
    for (let i = 1; i < 4; i++) expect(boxes[i]!).toBeGreaterThan(boxes[i - 1]!); // top to bottom on a phone
  });
});
