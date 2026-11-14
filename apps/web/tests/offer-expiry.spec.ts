// FE5b (S5): the offer-expiry choice reaches the envelope, the review shows "This offer closes <date>", and the human review
// shows the resolve deadline, not a Settlement period. Fully mocked: NEAR RPC, source check, relayer POST /relay, wallet seam.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const SC = "http://localhost:8790/sourcecheck";
const RELAYER = "http://localhost:8788";
const WASM = JSON.parse(readFileSync(new URL("../lib/release.json", import.meta.url), "utf8")).resolver_wasm_hash;
const DAY = 86400_000;

async function setup(page: Page) {
  await page.addInitScript(({ address }) => { (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => "22".repeat(64) }; }, { address: WALLET });
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      let r: unknown = null;
      switch (params.method_name) {
        case "is_paused": case "is_shutdown": r = false; break;
        case "open_offers": r = []; break;
        case "asset_limit": r = { storage_per_kib: "1" }; break;
        case "resolver_keys": r = ["a", "b", WASM]; break;
        case "mt_balance_of": r = "1" + "0".repeat(30); break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  await page.route(SC, async (route) => {
    const { terms } = JSON.parse(route.request().postData() ?? "{}");
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: true, spec_hash: createHash("sha256").update(terms).digest("hex"), checked_at: String(Date.now() * 1_000_000), unreachable: [], signing: { signature_hex: "33".repeat(64) } }) });
  });
  await page.route("**/ticker**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ venue: "x", price: 1 }) }));
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto("/new");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
}
async function toReview(page: Page, expiry: string, date: string, human = false) {
  await setup(page);
  await page.getByTestId("bet-type-card-nws_daily_high").click();
  await page.getByTestId("guided-station").selectOption("KNYC");
  await page.getByTestId("guided-date").fill(date);
  await page.getByTestId("guided-op").selectOption(">=");
  await page.getByTestId("guided-x_f").fill("72");
  await page.getByTestId("fill-next").click();
  if (human) {
    await page.getByTestId("decider-person").check();
    await page.getByTestId("referee-search").fill("alic");
    await page.getByTestId("referee-result-0").click();
  }
  await page.getByTestId("maker-amount").fill("10");
  if (expiry !== "7d") {
    await page.getByTestId("more-options-toggle").click(); // BET1c: More options is collapsed by default
    await page.getByTestId("offer-expiry").selectOption(expiry);
  } else await expect(page.getByTestId("more-options-summary")).toContainText("Closes in 7 days"); // BET1c: 7 days is the default
  await page.getByTestId("review-offer").click();
  await expect(page.getByTestId("review-card")).toBeVisible();
}

test.describe("FE5b offer expiry and human review lines", () => {
  test("choose 1d: review shows the close date and the built envelope's funding_deadline matches", async ({ page }) => {
    let fundingNs: bigint | null = null;
    await page.route(`${RELAYER}/relay`, (r) => {
      const { signedDelegate } = JSON.parse(r.request().postData() ?? "{}");
      const m = Buffer.from(signedDelegate, "base64").toString("latin1").match(/funding_deadline[\\"]*:[\\"\s]*(\d+)/);
      if (m) fundingNs = BigInt(m[1]);
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: "open-tx" }) });
    });
    const before = Date.now();
    await toReview(page, "1d", "2027-12-08");
    // C1 (UX-37 #6): the review says "Closes in 1 day"; the exact time it shows on tap is the <time datetime> of that line
    await expect(page.getByTestId("review-closes")).toHaveText(/^Closes in (1 day|23 h|24 h)$/);
    const iso = (await page.getByTestId("review-closes").locator("time").getAttribute("datetime"))!;
    const shown = Date.parse(iso);
    expect(Number.isFinite(shown), iso).toBe(true);
    expect(shown).toBeGreaterThan(before + DAY - 120_000);
    expect(shown).toBeLessThan(Date.now() + DAY + 120_000);
    await expect(page.getByTestId("source-check-status")).toContainText("Checking sources… ✓"); // C1: automatic on entering Review
    await page.getByTestId("open-offer-btn").click();
    await expect.poll(() => fundingNs !== null).toBe(true);
    const fundingMs = Number(fundingNs! / 1_000_000n);
    expect(Math.abs(fundingMs - shown)).toBeLessThan(120_000);
    expect(fundingMs).toBeLessThan(Date.now() + DAY + 60_000);
  });
  test("an expiry past the event close is clamped, with a plain note", async ({ page }) => {
    const d = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
    await toReview(page, "30d", d);
    await expect(page.getByTestId("review-closes")).toHaveText(/^Closes in \d+ (days?|h)$/);
    await expect(page.getByTestId("review-term-offer-closes")).toContainText("the event starts then");
  });
  test("human mode: no challenge window; the referee's rule-by date is shown (with the Sources line kept)", async ({ page }) => {
    await toReview(page, "7d", "2027-12-08", true);
    await expect(page.getByTestId("review-full-terms").locator("dt", { hasText: "Challenges" })).toHaveCount(0);
    await expect(page.getByTestId("review-term-window")).toContainText(/can rule any time until [89] Dec 2028/);
    await expect(page.getByTestId("review-term-sources")).not.toBeEmpty();
  });
  test("AI mode keeps the challenge window line", async ({ page }) => {
    await toReview(page, "7d", "2027-12-08");
    await expect(page.getByTestId("review-term-window")).toHaveText("24h to challenge a ruling, 2 rounds.");
    await expect(page.getByTestId("review-term-window")).not.toContainText("can rule");
  });
});
