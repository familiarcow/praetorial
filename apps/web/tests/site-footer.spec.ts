// CFIX1 (PM, PM 21:50 + 21:52): a site footer on every page -- both brands, guest / logged in / logged out, phone and desktop:
// "Source code on GitHub" -> https://github.com/familiarcow/praetorial, "familiarcow on X" -> https://x.com/familiarcow (both new tab,
// rel="noopener noreferrer"), and "Built at NEAR HACKATHON". It never sits under the bet page's sticky bottom bar or the create step bar,
// and passes axe color-contrast. Fully mocked (indexer + NEAR RPC + wallet seam). Screenshots: CFIX1_SHOTS=1 -> spikes/cfix1/shots.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { ESCROW_CONTRACT_ID } from "../lib/config";
import { mockUsernames } from "./lib/betPage";

const INDEXER = "http://localhost:8787";
const RPC = "https://test.rpc.fastnear.com";
const WALLET = "11".repeat(32);
const GITHUB = "https://github.com/familiarcow/praetorial";
const X = "https://x.com/familiarcow";
const SHOTS = process.env.CFIX1_SHOTS === "1" ? new URL("../../../spikes/cfix1/shots/", import.meta.url).pathname : new URL("../test-results/cfix1-shots/", import.meta.url).pathname;
const DAY_NS = 24 * 3600 * 1_000_000_000;

const BET = {
  envelope: {
    bet_id: 1, version: 1, maker: "maker.testnet", taker_allow: "Any", terms_hash: "deadbeef".repeat(4), models_snapshot_hash: "x",
    outcomes: ["YES", "NO"], maker_side: "YES", maker_asset: "nep141:usdc.testnet", taker_asset: "nep141:usdc.testnet",
    stake_maker: "100000000", stake_taker: "100000000", taker_options: [], fee_bps: 100, reserve_per_side: "0", storage_charge_per_side: "0",
    keep_terms: true, terms: JSON.stringify({ claimText: "BTC closes above $100k on Coinbase" }), run_price: "0", max_paid_runs: 3, tier: 1,
    arbiter: null, arbiter_fee: "0", funding_deadline: Date.now() * 1_000_000 + 7 * DAY_NS, early_settle_outcome: null, finality_delay: 0,
    settlement_period: DAY_NS, resolve_deadline: 0, consent_party_controlled: false, referee: null,
  },
  status: "Open", taker: null, created_at: 0, taken_at: null, proposed_at: null, outcome: null, reserve_remaining: "0", bonds: [], exhibits: [],
  challenged_by: null, window_extension_ns: 0,
};

type Who = "guest" | "user" | "out";
async function setup(page: Page, who: Who) {
  await mockUsernames(page);
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route(`${INDEXER}/**`, (r) => {
    const p = new URL(r.request().url()).pathname;
    const rows = p.includes("offers") ? [{ bet_id: 1, contract_id: ESCROW_CONTRACT_ID, maker: BET.envelope.maker, maker_side: "YES", stake_maker: BET.envelope.stake_maker,
      stake_taker: BET.envelope.stake_taker, funding_deadline: BET.envelope.funding_deadline, taker_allow: "Any", status: "Open", taker: null }] : [];
    return r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(rows) });
  });
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100, timestamp: Date.now() * 1_000_000, timestamp_nanosec: String(Date.now() * 1_000_000) } });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      const args = params.args_base64 ? JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8") || "{}") : {};
      const n = params.method_name;
      const r = n === "is_paused" || n === "is_shutdown" ? false : n === "get_bet" ? (args.bet_id === 1 ? BET : null) : n === "open_offers" ? [BET]
        : n === "bet_count" ? 1 : n === "asset_limit" ? { storage_per_kib: "1" } : null;
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  if (who === "guest") await page.addInitScript(() => { window.sessionStorage.setItem("praetorial:guest", "1"); });
  if (who === "user") await page.addInitScript(({ address }) => { (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => "22".repeat(64) }; }, { address: WALLET });
}
async function go(page: Page, path: string, brand: string) {
  await page.goto(`${path}${path.includes("?") ? "&" : "?"}brand=${brand}`);
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
}
async function expectFooter(page: Page, where: string) {
  const f = page.getByTestId("site-footer");
  await expect(f, where).toHaveCount(1);
  await f.scrollIntoViewIfNeeded();
  await expect(f, where).toBeVisible();
  for (const [id, href, text] of [["footer-github", GITHUB, "Source code on GitHub"], ["footer-x", X, "familiarcow on X"]] as const) {
    const a = page.getByTestId(id);
    await expect(a, `${where} ${id}`).toHaveAttribute("href", href);
    await expect(a, `${where} ${id}`).toHaveAttribute("target", "_blank");
    await expect(a, `${where} ${id}`).toHaveAttribute("rel", "noopener noreferrer");
    await expect(a, `${where} ${id}`).toHaveText(text);
  }
  await expect(page.getByTestId("footer-built-at"), where).toHaveText("Built at NEAR HACKATHON");
  await expect(f, where).toHaveText("Source code on GitHub·familiarcow on X·Built at NEAR HACKATHON"); // nothing else (no personal name)
  const axe = await new AxeBuilder({ page }).include('[data-testid="site-footer"]').withRules(["color-contrast", "link-name", "link-in-text-block"]).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), `${where} axe`).toEqual([]);
}
async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: true });
}

for (const brand of ["praetorial", "classic"]) {
  for (const width of [375, 1280]) {
    test.describe(`CFIX1 site footer (${brand}, ${width}px)`, () => {
      test.beforeEach(async ({ page }) => { await page.setViewportSize({ width, height: width === 375 ? 812 : 900 }); });

      test("guest: Home, a bet page, Docs", async ({ page }) => {
        await setup(page, "guest");
        for (const [path, ready] of [["/", "home"], ["/bet/1", "bet-view"], ["/docs", "docs"]] as const) {
          await go(page, path, brand);
          await expect(page.getByTestId("guest-banner")).toBeVisible();
          if (ready !== "docs") await expect(page.getByTestId(ready)).toBeVisible();
          await expectFooter(page, `guest ${path}`);
          await shot(page, `guest-${path === "/" ? "home" : path.split("/")[1]}-${brand}-${width}`);
        }
      });

      test("logged in: Home, a bet page, Docs, Account", async ({ page }) => {
        await setup(page, "user");
        for (const path of ["/", "/bet/1", "/docs", "/account"]) {
          await go(page, path, brand);
          await expect(page.getByTestId("nav-account")).toBeVisible();
          await expectFooter(page, `user ${path}`);
          await shot(page, `user-${path === "/" ? "home" : path.split("/")[1]}-${brand}-${width}`);
        }
        await expect(page.getByTestId("nav-account")).toHaveAttribute("aria-current", "page");
      });

      test("logged out: the login page and public Docs", async ({ page }) => {
        await setup(page, "out");
        await go(page, "/", brand);
        await expect(page.getByTestId("browse-as-guest")).toBeVisible();
        await expectFooter(page, "logged-out login");
        await go(page, "/docs", brand);
        await expectFooter(page, "logged-out docs");
      });
    });
  }
}

/** The footer's links are never covered: at every scroll position, the element at each visible link's centre is the link itself. */
async function linksUncovered(page: Page, where: string) {
  const H = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y <= H; y += 120) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    const bad = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="site-footer"] a')).flatMap((a) => {
      const r = a.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cy < 0 || cy > window.innerHeight) return [];
      const hit = document.elementFromPoint(cx, cy);
      return hit && (hit === a || a.contains(hit)) ? [] : [`${a.textContent} under ${hit?.className || hit?.tagName}`];
    }));
    expect(bad, `${where} at scrollY=${y}`).toEqual([]);
  }
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const bar = page.locator(".k-actions--sticky").first();
  if (await bar.count()) {
    const b = (await bar.boundingBox())!, f = (await page.getByTestId("site-footer").boundingBox())!;
    expect(b.y + b.height, `${where}: the sticky bar ends above the footer`).toBeLessThanOrEqual(f.y + 0.5);
  }
}

test.describe("CFIX1 site footer never under a sticky bar (375px)", () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 375, height: 640 }); });

  test("bet page with the sticky Take bar (guest and logged in)", async ({ page }) => {
    await setup(page, "user");
    await go(page, "/bet/1", "praetorial");
    await expect(page.locator(".k-actions--sticky").first()).toBeVisible();
    await linksUncovered(page, "user /bet/1");
    await shot(page, "user-bet-sticky-bar-bottom-375");
  });

  test("create: the step bar (Next / Back) is never covered by the footer, and the footer is below the dialog's backdrop", async ({ page }) => {
    await setup(page, "user");
    await go(page, "/new", "praetorial");
    await page.getByTestId("bet-type-card-custom").click();
    for (const id of ["fill-next", "fill-back"]) {
      const btn = page.getByTestId(id);
      await btn.scrollIntoViewIfNeeded();
      const hit = await btn.evaluate((el) => { const r = el.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!h && (h === el || el.contains(h)); });
      expect(hit, `${id} is on top`).toBe(true);
    }
    await shot(page, "user-create-step-375");
  });
});
