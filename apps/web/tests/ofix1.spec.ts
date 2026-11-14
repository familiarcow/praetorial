// OFIX1 (familiarcow, live mainnet 11-13 17:55): "Hits a price" bet, deadline set, ~6 min later the check came back red with
// "<terms>: We couldn't read this source the way the AI needs to." Fully mocked (NEAR RPC, source-check endpoint, wallet seam).
// The mocked source check behaves like the pinned resolver: it judges open_utc against ITS clock (chain/real time) and refuses
// a sheet more than 300 s off with a "<terms>" OPEN_UTC_SKEW row. "Asleep" = the machine slept: the wall clock and the chain moved,
// the browser's performance.now() did not (macOS pauses it while asleep), which is what left the old chain clock stale.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { createHash } from "node:crypto";
import { openBetType } from "./betTypeNav";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const SC = "http://localhost:8790/sourcecheck";
const SKEW_S = 300;

type Mode = "resolver" | "skew-once" | "skew-always" | "deadline-past";
interface World { sleptMs: number; n: number; openUtcs: string[] }

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const minute = (ms: number) => iso(Math.floor(ms / 60_000) * 60_000);

async function setup(page: Page, mode: Mode, w: World) {
  await page.addInitScript(({ address }) => {
    (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => "22".repeat(64) };
    (window as any).__e2eSourceCheckTimeoutMs = 3000;
    (window as any).__slept = 0;
    const real = Date.now.bind(Date);
    Date.now = () => real() + (window as any).__slept; // performance.now() is left alone: it "missed" the sleep
  }, { address: WALLET });
  const chainNow = () => Date.now() + w.sleptMs;
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100, timestamp_nanosec: String(BigInt(chainNow()) * 1_000_000n) } });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      const name = params.method_name;
      const r = name === "is_paused" || name === "is_shutdown" ? false : name === "open_offers" ? [] : name === "asset_limit" ? { storage_per_kib: "1" } : name === "mt_balance_of" ? "1" + "0".repeat(30) : null;
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  await page.route(SC, async (route) => {
    const cors = { "access-control-allow-origin": "*" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-headers": "*" } });
    w.n++;
    const { terms } = JSON.parse(route.request().postData() ?? "{}");
    const open = JSON.parse(terms)?.fields?.open_utc as string;
    w.openUtcs.push(open);
    const now = chainNow();
    const spec_hash = createHash("sha256").update(terms).digest("hex");
    // the Worker relays a resolver refusal as a 502 carrying the "<terms>" rows and its generic reason
    const refuse = (reason: string) => route.fulfill({ status: 502, contentType: "application/json", headers: cors,
      body: JSON.stringify({ ok: false, reason: "one or more sources were unreachable or the check failed", spec_hash, checked_at: String(now * 1_000_000), unreachable: [{ id: "<terms>", reason }] }) });
    const skew = () => refuse(`OPEN_UTC_SKEW: open_utc ${open} is more than ${SKEW_S}s from the open clock ${iso(now)}`);
    if (mode === "skew-always" || (mode === "skew-once" && w.n === 1)) return skew();
    if (mode === "deadline-past") return refuse(`OPEN_DEADLINE_NOT_AFTER_OPEN: deadline_utc 2026-01-01T00:00:00Z is not after open (${iso(now)})`);
    if (Math.abs(Date.parse(open) - now) / 1000 > SKEW_S) return skew();
    return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ ok: true, spec_hash, checked_at: String(now * 1_000_000), unreachable: [], signing: { signature_hex: "33".repeat(64) } }) });
  });
  await page.route("**/ticker**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ venue: "x", price: 68000 }) }));
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto("/new");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
}

async function fillTouch(page: Page) {
  await openBetType(page, "btc_touch");
  await page.getByTestId("guided-direction").selectOption("at_or_above");
  await page.getByTestId("guided-x_usd").fill("68550");
  await page.getByTestId("guided-deadline_utc").fill("2027-12-07T12:00");
  await page.getByTestId("fill-next").click();
  await page.getByTestId("maker-amount").fill("10");
}
async function sleep(page: Page, w: World, ms: number) {
  w.sleptMs += ms;
  await page.evaluate((s) => { (window as any).__slept = s; }, w.sleptMs);
}
const COPY_BAD = /couldn't read this source|can't read one of the sources|<terms>|OPEN_|unreachable or the check failed/;

test.describe("OFIX1 stale open_utc", () => {
  test("deadline set, machine asleep 6 min, then the check: the request carries a fresh open_utc and passes", async ({ page }) => {
    const w: World = { sleptMs: 0, n: 0, openUtcs: [] };
    await setup(page, "resolver", w);
    await fillTouch(page);
    await sleep(page, w, 6 * 60_000);
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("source-check-status")).toHaveText(/^Checking sources… ✓/);
    expect(w.n).toBe(1);
    // the check minute in chain time (the mock's clock), not the minute the deadline was set
    const wanted = minute(Date.now() + w.sleptMs);
    expect([wanted, minute(Date.now() + w.sleptMs - 60_000)]).toContain(w.openUtcs[0]);
    await expect(page.getByTestId("open-offer-btn")).toBeEnabled();
  });

  test("Retry after a sleep re-stamps too (a failed first check, then 6 min asleep, then Retry)", async ({ page }) => {
    const w: World = { sleptMs: 0, n: 0, openUtcs: [] };
    await setup(page, "deadline-past", w);
    await fillTouch(page);
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("source-check-error")).toBeVisible();
    const first = w.openUtcs[0];
    await page.unroute(SC);
    await setup2Resolver(page, w);
    await sleep(page, w, 6 * 60_000);
    await page.getByTestId("check-sources-btn").click();
    await expect(page.getByTestId("source-check-status")).toHaveText(/^Checking sources… ✓/);
    const last = w.openUtcs[w.openUtcs.length - 1];
    expect(Date.parse(last) - Date.parse(first)).toBeGreaterThanOrEqual(5 * 60_000);
  });

  test("a <terms> OPEN_UTC_SKEW reply is re-stamped and retried once by itself, then passes (2 requests)", async ({ page }) => {
    const w: World = { sleptMs: 0, n: 0, openUtcs: [] };
    await setup(page, "skew-once", w);
    await fillTouch(page);
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("source-check-status")).toHaveText(/^Checking sources… ✓/);
    expect(w.n).toBe(2);
    await expect(page.getByTestId("source-check-error")).toHaveCount(0);
  });

  test("OPEN_UTC_SKEW twice: 'The start time went stale. Tap Check again.' with a 'Check again' button; no loop", async ({ page }) => {
    const w: World = { sleptMs: 0, n: 0, openUtcs: [] };
    await setup(page, "skew-always", w);
    await fillTouch(page);
    await page.getByTestId("review-offer").click();
    const err = page.getByTestId("source-check-error");
    await expect(err).toContainText("The start time went stale. Tap Check again.");
    await expect(err).not.toContainText(COPY_BAD);
    await expect(page.getByTestId("check-sources-btn")).toHaveText("Check again");
    await page.waitForTimeout(1000);
    expect(w.n).toBe(2); // one automatic retry, never a paid loop
    await page.getByTestId("check-sources-btn").click();
    await expect.poll(() => w.n).toBe(4); // the press, plus its own one retry
  });

  test("a <terms> OPEN_DEADLINE_NOT_AFTER_OPEN reply shows the mapped copy, never 'couldn't read this source'", async ({ page }) => {
    const w: World = { sleptMs: 0, n: 0, openUtcs: [] };
    await setup(page, "deadline-past", w);
    await fillTouch(page);
    await page.getByTestId("review-offer").click();
    const err = page.getByTestId("source-check-error");
    await expect(err).toContainText("The deadline has already passed. Pick a later deadline.");
    await expect(err).not.toContainText(COPY_BAD);
    await expect(page.getByTestId("open-offer-btn")).toBeDisabled();
    expect(w.n).toBe(1); // not a skew: no automatic retry
  });
});

/** Swap the source-check mock to "resolver" behaviour on the same page (Retry test). */
async function setup2Resolver(page: Page, w: World) {
  await page.route(SC, async (route) => {
    const cors = { "access-control-allow-origin": "*" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-headers": "*" } });
    w.n++;
    const { terms } = JSON.parse(route.request().postData() ?? "{}");
    const open = JSON.parse(terms)?.fields?.open_utc as string;
    w.openUtcs.push(open);
    const now = Date.now() + w.sleptMs;
    const spec_hash = createHash("sha256").update(terms).digest("hex");
    if (Math.abs(Date.parse(open) - now) / 1000 > SKEW_S)
      return route.fulfill({ status: 502, contentType: "application/json", headers: cors, body: JSON.stringify({ ok: false, reason: "one or more sources were unreachable or the check failed", unreachable: [{ id: "<terms>", reason: `OPEN_UTC_SKEW: open_utc ${open} is more than 300s from the open clock ${iso(now)}` }] }) });
    return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ ok: true, spec_hash, checked_at: String(now * 1_000_000), unreachable: [], signing: { signature_hex: "33".repeat(64) } }) });
  });
}
