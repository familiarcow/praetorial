// DR3W1 (DR3 F1): mocked e2e. An nws_daily_high bet on a climate day that already started: the signed funding_deadline must leave
// a taker real time after review + the (slow) sourcecheck. Before the fix it was review time + 60 s, so the offer expired first.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const SC = "http://localhost:8790/sourcecheck";
const RELAYER = "http://localhost:8788";
const WASM = JSON.parse(readFileSync(new URL("../lib/release.json", import.meta.url), "utf8")).resolver_wasm_hash;
const SOURCECHECK_DELAY_MS = 8_000; // stands in for the real 30-60 s; the assertion is about the signed deadline vs the real clock

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
    await new Promise((r) => setTimeout(r, SOURCECHECK_DELAY_MS));
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: true, spec_hash: createHash("sha256").update(terms).digest("hex"), checked_at: String(Date.now() * 1_000_000), unreachable: [], signing: { signature_hex: "33".repeat(64) } }) });
  });
  await page.route("**/ticker**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ venue: "x", price: 1 }) }));
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto("/new");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
}
async function toReview(page: Page, date: string) {
  await setup(page);
  await page.getByTestId("bet-type-card-nws_daily_high").click();
  await page.getByTestId("guided-station").selectOption("KNYC");
  await page.getByTestId("guided-date").fill(date);
  await page.getByTestId("guided-op").selectOption(">=");
  await page.getByTestId("guided-x_f").fill("60");
  await page.getByTestId("fill-next").click();
  await page.getByTestId("maker-amount").fill("10");
  await page.getByTestId("review-offer").click();
}

test.describe("DR3W1 climate-day funding deadline", () => {
  test("a started climate day: the signed funding_deadline leaves a taker window after a slow sourcecheck", async ({ page }) => {
    // KNYC is UTC-5 (no DST modelling in the template): the local climate day containing 'now'.
    const date = new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);
    let fundingNs: bigint | null = null; let landedMs = 0;
    await page.route(`${RELAYER}/relay`, (r) => {
      const { signedDelegate } = JSON.parse(r.request().postData() ?? "{}");
      const m = Buffer.from(signedDelegate, "base64").toString("latin1").match(/funding_deadline[\\"]*:[\\"\s]*(\d+)/);
      if (m) { fundingNs = BigInt(m[1]); landedMs = Date.now(); }
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: "open-tx" }) });
    });
    await toReview(page, date);
    await expect(page.getByTestId("review-card")).toBeVisible();
    await expect(page.getByTestId("source-check-status")).toContainText("Checking sources… ✓", { timeout: 30_000 }); // C1: automatic
    await page.getByTestId("open-offer-btn").click();
    // RED before the fix: the app itself refuses ("closing time has already passed") because the floor was review + 60 s.
    await expect(page.getByText("closing time has already passed")).toHaveCount(0);
    await expect.poll(() => fundingNs !== null, { timeout: 15_000 }).toBe(true);
    const leftMs = Number(fundingNs! / 1_000_000n) - landedMs;
    // The taker needs at least 10 minutes after the offer lands (RED before the fix: ~60 s minus the sourcecheck, i.e. expired).
    expect(leftMs).toBeGreaterThanOrEqual(10 * 60_000);
  });
});
