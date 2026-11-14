// CFIX1 (PM, live mainnet 11-13 19:55 ET): New bet -> Anything else -> Deadline 25 Nov 12:59 PM ET showed "Counts from (UTC)"
// = 11/25/2026 05:59 PM, the deadline. Fully mocked (NEAR RPC, source-check endpoint, wallet seam). Checks:
//  - picking the deadline (typed key by key, like a person) sets Counts from to NOW (UTC, minute floor), never the deadline;
//  - a Counts from typed by hand survives a new deadline pick; one at/after the deadline shows an inline error and blocks Next;
//  - "Check the sources" re-stamps an untouched Counts from to the check minute (OFIX1 rule), never a typed one.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { createHash } from "node:crypto";
import { openMoreOptions } from "./betDetailsHelpers";
import { utcToLocalInput } from "../lib/betDetails";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const SC = "http://localhost:8790/sourcecheck";
const minuteUtc = (ms: number) => new Date(Math.floor(ms / 60_000) * 60_000).toISOString().slice(0, 16);

interface World { sleptMs: number; windowStarts: string[] }
async function setup(page: Page, w: World = { sleptMs: 0, windowStarts: [] }) {
  await page.addInitScript(({ address }) => {
    (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => "22".repeat(64) };
    (window as any).__e2eSourceCheckTimeoutMs = 3000;
    (window as any).__slept = 0;
    const real = Date.now.bind(Date);
    Date.now = () => real() + (window as any).__slept;
  }, { address: WALLET });
  const chainNow = () => Date.now() + w.sleptMs;
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100, timestamp_nanosec: String(BigInt(chainNow()) * 1_000_000n) } });
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
    const { terms } = JSON.parse(route.request().postData() ?? "{}");
    w.windowStarts.push(JSON.parse(terms)?.time?.window_start);
    const spec_hash = createHash("sha256").update(terms).digest("hex");
    return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ ok: true, spec_hash, checked_at: String(chainNow() * 1_000_000), unreachable: [], signing: { signature_hex: "33".repeat(64) } }) });
  });
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto("/new");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
  await page.getByTestId("bet-type-card-custom").click();
  return w;
}
async function sleep(page: Page, w: World, ms: number) {
  w.sleptMs += ms;
  await page.evaluate((s) => { (window as any).__slept = s; }, w.sleptMs);
}
/** Type the deadline key by key into Chrome's datetime-local (month, day, year, hour, minute, AM/PM), the way a person does. */
async function typeDeadline(page: Page, digits: string[]) {
  await page.getByTestId("cb-deadline").focus();
  for (const k of digits) await page.keyboard.press(k);
}
async function fillRest(page: Page) {
  await page.getByTestId("cb-claim").fill("Apple makes a foldable iPhone available to buy in the US during 2027.");
  await page.getByTestId("cb-source-url-0").fill("https://www.apple.com/newsroom/");
  await page.getByTestId("cb-source-url-1").fill("https://www.reuters.com/technology/");
}
const DEADLINE_KEYS = ["1", "1", "2", "5", "2", "0", "2", "7", "Tab", "1", "2", "5", "9", "P"]; // 11/25/2027 12:59 PM, local
const DEADLINE_LOCAL = "2027-11-25T12:59";

test.describe("CFIX1 Counts from", () => {
  test("Live repro: typing the deadline sets Counts from to now (UTC minute), not the deadline", async ({ page }) => {
    await setup(page);
    await openMoreOptions(page);
    await expect(page.getByTestId("cb-windowStart")).toHaveValue("");
    const before = Date.now();
    await typeDeadline(page, DEADLINE_KEYS);
    await expect(page.getByTestId("cb-deadline")).toHaveValue(DEADLINE_LOCAL);
    const ws = await page.getByTestId("cb-windowStart").inputValue();
    expect([minuteUtc(before), minuteUtc(Date.now())]).toContain(ws);
    const deadlineUtc = (await page.getByTestId("cb-deadline-utc").textContent())?.match(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/);
    expect(deadlineUtc).not.toBeNull();
    expect(ws).not.toBe(`${deadlineUtc![1]}T${deadlineUtc![2]}`);
    await expect(page.getByTestId("cb-windowStart-error")).toHaveCount(0);
  });

  test("a later deadline pick re-stamps an untouched Counts from to that moment; a typed one is kept", async ({ page }) => {
    const w = await setup(page);
    await openMoreOptions(page);
    await page.getByTestId("cb-deadline").fill("2027-11-20T09:00");
    await sleep(page, w, 7 * 60_000);
    await page.getByTestId("cb-deadline").fill(DEADLINE_LOCAL);
    const ws = await page.getByTestId("cb-windowStart").inputValue();
    expect([minuteUtc(Date.now() + w.sleptMs - 60_000), minuteUtc(Date.now() + w.sleptMs)]).toContain(ws);
    // typed by hand: kept through another deadline pick
    await page.getByTestId("cb-windowStart").fill("2027-01-02T03:04");
    await page.getByTestId("cb-deadline").fill("2027-12-31T12:00");
    await expect(page.getByTestId("cb-windowStart")).toHaveValue("2027-01-02T03:04");
  });

  test("Counts from at or after the deadline: inline error, Next blocked; fixing it unblocks", async ({ page }) => {
    await setup(page);
    await fillRest(page);
    await page.getByTestId("cb-deadline").fill(utcToLocalInput("2027-11-25T17:59"));
    await openMoreOptions(page);
    for (const bad of ["2027-11-25T17:59", "2027-11-26T00:00"]) {
      await page.getByTestId("cb-windowStart").fill(bad);
      await expect(page.getByTestId("cb-windowStart-error")).toBeVisible();
      await expect(page.getByTestId("cb-windowStart-error")).toContainText("before the deadline");
      await expect(page.getByTestId("fill-next")).toHaveAttribute("aria-disabled", "true");
      await page.getByTestId("fill-next").click({ force: true });
      await expect(page.getByTestId("fill-step")).toBeVisible();
      await expect(page.getByTestId("step-resolver")).toHaveCount(0);
      await expect(page.locator('[data-field="windowStart"]')).toHaveAttribute("data-flagged", "true");
      await expect(page.getByTestId("fill-error")).toContainText("Counts from");
    }
    await page.getByTestId("cb-windowStart").fill("2027-11-25T17:58");
    await expect(page.getByTestId("cb-windowStart-error")).toHaveCount(0);
    await expect(page.getByTestId("fill-next")).toBeEnabled();
    await page.getByTestId("fill-next").click();
    await expect(page.getByTestId("step-resolver")).toBeVisible();
  });

  test("Check the sources re-stamps an untouched Counts from to the check minute", async ({ page }) => {
    const w = await setup(page);
    await fillRest(page);
    await page.getByTestId("cb-deadline").fill(DEADLINE_LOCAL);
    await sleep(page, w, 6 * 60_000);
    await page.getByTestId("fill-next").click();
    await page.getByTestId("maker-amount").fill("10");
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("source-check-status")).toHaveText(/^Checking sources… ✓/);
    const now = Date.now() + w.sleptMs;
    expect([`${minuteUtc(now)}:00Z`, `${minuteUtc(now - 60_000)}:00Z`]).toContain(w.windowStarts[0]);
  });

  test("Check the sources keeps a Counts from typed by hand", async ({ page }) => {
    const w = await setup(page);
    await fillRest(page);
    await page.getByTestId("cb-deadline").fill(DEADLINE_LOCAL);
    await openMoreOptions(page);
    await page.getByTestId("cb-windowStart").fill("2026-11-01T08:00");
    await sleep(page, w, 6 * 60_000);
    await page.getByTestId("fill-next").click();
    await page.getByTestId("maker-amount").fill("10");
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("source-check-status")).toHaveText(/^Checking sources… ✓/);
    expect(w.windowStarts[0]).toBe("2026-11-01T08:00:00Z");
  });
});
