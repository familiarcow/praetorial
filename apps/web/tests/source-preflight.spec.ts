// FE6 (S6): source preflight step. Fully mocked: NEAR RPC, the source-check endpoint, relayer, wallet seam. Never a real Privy login.
// C1 (UIR1 §3.4, familiarcow UX-37 #5): the check runs BY ITSELF when Review opens -- at most one automatic paid check per reviewed offer
// (counted by the mocked endpoint, `c.n`) -- and shows as one status line ("Checking sources…" / "Checking sources… ✓") with at
// most ONE button. REVIEW1's binding (an approval only opens the offer it checked) and no-loop rules are unchanged.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { readFileSync } from "node:fs";
import { screenPath } from "./lib/screens";
import { createHash } from "node:crypto";
import { SCHEMA } from "@near-js/transactions";
import * as borsh from "borsh";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const SC = "http://localhost:8790/sourcecheck";
const WASM = JSON.parse(readFileSync(new URL("../lib/release.json", import.meta.url), "utf8")).resolver_wasm_hash;

type Mode = "pass" | "fail" | "rate" | "rate30" | "rateglobal" | "hang" | "down" | "old" | "lint422";
const LINT_REASON = "term sheet failed lint: need >= 2 independent, non-party-controlled origins (publisher strings that share an origin count once)";
// REVIEW1: `deviceSkewMs` moves the BROWSER's clock (Date.now) away from real time; the mocked chain (block timestamp) and the
// source-check service keep real time. `relayed` collects what the Open signed.
async function setup(page: Page, mode: Mode, counter: { n: number }, o: { deviceSkewMs?: number; relayed?: any[] } = {}) {
  await page.addInitScript(({ address, skew }) => {
    (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => "22".repeat(64) };
    (window as any).__e2eSourceCheckTimeoutMs = 1500;
    (window as any).__e2eConfirm = { delayMs: 20, attempts: 1 };
    if (skew) { const real = Date.now.bind(Date); Date.now = () => real() + skew; }
  }, { address: WALLET, skew: o.deviceSkewMs ?? 0 });
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100, timestamp_nanosec: String(BigInt(Date.now()) * 1_000_000n) } });
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
    const cors = { "access-control-allow-origin": "*" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-headers": "*" } });
    counter.n++; // paid check runs only (a CORS preflight is not one)
    const { terms } = JSON.parse(route.request().postData() ?? "{}");
    const spec_hash = createHash("sha256").update(terms).digest("hex");
    if (mode === "hang") return; // never answers -> the app's own timeout
    if (mode === "down") return route.abort();
    if (mode === "lint422") return route.fulfill({ status: 422, contentType: "application/json", headers: cors, body: JSON.stringify({ ok: false, reason: LINT_REASON, problems: ["x"], unreachable: [] }) });
    // NOTE: the real Worker (core.ts) does not yet send access-control-expose-headers: retry-after, so a cross-origin browser cannot read it (Worker follow-up); these mocks model the Worker once it does.
    if (mode === "rate30") return route.fulfill({ status: 429, contentType: "application/json", headers: { ...cors, "access-control-expose-headers": "retry-after", "retry-after": "1800" }, body: JSON.stringify({ ok: false, scope: "ip", reason: "rate limit", unreachable: [] }) });
    if (mode === "rateglobal") return route.fulfill({ status: 429, contentType: "application/json", headers: { ...cors, "access-control-expose-headers": "retry-after", "retry-after": "40000" }, body: JSON.stringify({ ok: false, scope: "global", reason: "global daily cap", unreachable: [] }) });
    if (mode === "rate") return route.fulfill({ status: 429, contentType: "application/json", headers: cors, body: JSON.stringify({ ok: false }) });
    if (mode === "fail") return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ ok: false, spec_hash, checked_at: String(Date.now() * 1_000_000), unreachable: [{ id: "nws", reason: "HTTP 403 (non-2xx)" }] }) });
    const ageMs = mode === "old" ? 3_600_000 - 18_000 : 0; // 3s of freshness left (the app stops 15 s short of the contract's 1 h)
    return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ ok: true, spec_hash, checked_at: String((Date.now() - ageMs) * 1_000_000), unreachable: [], signing: { signature_hex: "33".repeat(64) } }) });
  });
  await page.route("http://localhost:8788/relay", async (r) => {
    const sd: any = borsh.deserialize(SCHEMA.SignedDelegate as any, Buffer.from(JSON.parse(r.request().postData() ?? "{}").signedDelegate, "base64"));
    const fc = sd.delegateAction.actions[0].functionCall;
    o.relayed?.push({ method: fc.methodName as string, args: JSON.parse(Buffer.from(fc.args).toString("utf8")) });
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: "TX1" }) });
  });
  await page.route("**/ticker**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ venue: "x", price: 1 }) }));
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto("/new");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
}
async function toReview(page: Page, human: boolean) {
  await page.getByTestId("bet-type-card-nws_daily_high").click();
  await page.getByTestId("guided-station").selectOption("KNYC");
  await page.getByTestId("guided-date").fill("2027-12-08");
  await page.getByTestId("guided-op").selectOption(">=");
  await page.getByTestId("guided-x_f").fill("72");
  await page.getByTestId("fill-next").click();
  if (human) {
    await page.getByTestId("decider-person").check();
    await page.getByTestId("referee-search").fill("alic");
    await page.getByTestId("referee-result-0").click();
  }
  await page.getByTestId("maker-amount").fill("10");
  await page.getByTestId("review-offer").click();
  await expect(page.getByTestId("review-card")).toBeVisible();
}

test.describe("FE6 source preflight step", () => {
  test("pass: the check runs by itself on entering Review: 'Checking sources… ✓', minutes left, Open enabled, no button", async ({ page }) => {
    const c = { n: 0 };
    await setup(page, "pass", c);
    await toReview(page, false);
    await expect(page.getByTestId("preflight-step")).toBeVisible();
    await expect(page.getByTestId("source-check-status")).toHaveText(/^Checking sources… ✓ Good to open for 5\d min\.$/);
    await expect(page.getByTestId("open-offer-btn")).toBeEnabled();
    await expect(page.getByTestId("open-offer-btn")).toHaveText("Open the bet · 10 NEAR");
    await expect(page.getByTestId("check-sources-btn")).toHaveCount(0);
    expect(c.n).toBe(1);
  });
  test("progress view is shown while the check is running", async ({ page }) => {
    const c = { n: 0 };
    await setup(page, "hang", c);
    await toReview(page, false);
    await expect(page.getByTestId("source-check-status")).toHaveText("Checking sources…");
    await expect(page.getByTestId("check-sources-btn")).toHaveCount(0);
    await expect(page.getByTestId("preflight-progress")).toContainText("Reaching the sources");
    await expect(page.getByTestId("preflight-progress")).toContainText("Reading the pages");
    await expect(page.getByTestId("preflight-progress")).toContainText("Checking the answer can be found");
  });
  test("fail: plain-English reason per source, no codes, Open disabled, Fix / Use a person buttons", async ({ page }) => {
    const c = { n: 0 };
    await setup(page, "fail", c);
    await toReview(page, false);
    const err = page.getByTestId("source-check-error");
    await expect(err).toContainText("The AI can't settle this as written:");
    await expect(err).toContainText("Change the page or the wording, or pick a person to decide.");
    await expect(page.getByTestId("preflight-failure-line-0")).toContainText("nws");
    await expect(page.getByTestId("preflight-failure-line-0")).not.toContainText(/HTTP|403|non-2xx/);
    await expect(page.getByTestId("open-offer-btn")).toBeDisabled();
    await expect(page.getByTestId("preflight-fix")).toBeVisible();
    await page.getByTestId("preflight-use-person").click();
    await expect(page.getByTestId("step-resolver")).toBeVisible(); // "let a person decide instead" -> the resolver step
  });
  test("fail: 'Fix the bet' goes back to the fill step", async ({ page }) => {
    const c = { n: 0 };
    await setup(page, "fail", c);
    await toReview(page, false);
    await page.getByTestId("preflight-fix").click();
    await expect(page.getByTestId("guided-x_f")).toBeVisible();
  });
  test("timeout: 'The check is taking too long. Retry.' and Retry runs the check again", async ({ page }) => {
    const c = { n: 0 };
    await setup(page, "hang", c);
    await toReview(page, false);
    await expect(page.getByTestId("source-check-error")).toContainText("The check is taking too long. Retry.", { timeout: 10_000 });
    await expect(page.getByTestId("open-offer-btn")).toBeDisabled();
    await expect(page.getByTestId("review-step").getByRole("button", { name: "Retry" })).toHaveCount(1); // C1: one Retry, never "Retry Retry"
    await page.getByTestId("check-sources-btn").click();
    await expect.poll(() => c.n).toBe(2);
  });
  test("rate limit: 'Too many checks. Try again in a minute.'", async ({ page }) => {
    const c = { n: 0 };
    await setup(page, "rate", c);
    await toReview(page, false);
    await expect(page.getByTestId("source-check-error")).toContainText("Too many checks. Try again in a minute.");
  });
  test("rate limit (ip, retry-after 1800): 'Too many checks right now. Try again in 30 minutes.', Retry disabled until then", async ({ page }) => {
    const c = { n: 0 };
    await setup(page, "rate30", c);
    await toReview(page, false);
    const err = page.getByTestId("source-check-error");
    await expect(err).toContainText("Too many checks right now. Try again in 30 minutes.");
    await expect(err).not.toContainText("taking too long");
    await expect(page.getByTestId("review-step").getByRole("button", { name: "Retry" })).toHaveCount(1);
    await expect(page.getByTestId("check-sources-btn")).toBeDisabled();
    expect(c.n).toBe(1);
  });
  test("rate limit (global): 'Too many checks right now. Try again tomorrow.'", async ({ page }) => {
    const c = { n: 0 };
    await setup(page, "rateglobal", c);
    await toReview(page, false);
    const err = page.getByTestId("source-check-error");
    await expect(err).toContainText("Too many checks right now. Try again tomorrow.");
    await expect(err).not.toContainText("taking too long");
  });
  test("service down: steers to a person referee", async ({ page }) => {
    const c = { n: 0 };
    await setup(page, "down", c);
    await toReview(page, false);
    await expect(page.getByTestId("source-check-error")).toContainText("Checking sources is unavailable. You can still make a bet with a person as referee.");
  });
  test("freshness: when the attestation runs out, Open is disabled and a re-check needs a press (AI mode never re-checks by itself)", async ({ page }) => {
    const c = { n: 0 };
    await setup(page, "old", c);
    await toReview(page, false);
    await expect(page.getByTestId("source-check-status")).toContainText("Checking sources… ✓");
    await expect(page.getByTestId("preflight-expired")).toContainText("This check has run out. Check the sources again to open the bet.", { timeout: 15_000 });
    await expect(page.getByTestId("open-offer-btn")).toBeDisabled();
    await expect(page.getByTestId("check-sources-btn")).toHaveText("Check again");
    await expect(page.getByTestId("check-sources-btn")).toBeEnabled();
    await page.waitForTimeout(2000);
    expect(c.n).toBe(1); // no automatic paid re-check
    await page.getByTestId("check-sources-btn").click();
    await expect.poll(() => c.n).toBe(2);
  });
  // D-FE6B1 (ruling change, not a loosened check): the contract still needs a fresh resolver-signed source-check attestation on EVERY
  // Open, so human mode gets it silently. The old rule "ZERO requests" became "no AI/preflight UI and no model call".
  test("human mode: no AI/preflight UI, no model call; Open enabled after exactly one silent sourcecheck request (D-FE6B1)", async ({ page }) => {
    const c = { n: 0 };
    const model: string[] = [];
    page.on("request", (r) => { if (/near\.ai|openai|anthropic|\/v1\/(chat|completions|messages)/i.test(r.url())) model.push(r.url()); });
    await setup(page, "pass", c);
    await toReview(page, true);
    await expect(page.getByTestId("preflight-step")).toHaveCount(0);
    await expect(page.getByTestId("check-sources-btn")).toHaveCount(0);
    await expect(page.getByTestId("preflight-progress")).toHaveCount(0);
    await expect(page.getByTestId("source-check-status")).toHaveCount(0);
    await expect(page.getByTestId("preflight-time-left")).toHaveCount(0);
    await expect(page.getByTestId("human-no-preflight")).toContainText("No AI is used, so there is nothing to check.");
    await expect(page.getByTestId("human-open-pending")).toHaveCount(0);
    await expect(page.getByTestId("open-offer-btn")).toBeEnabled();
    await page.waitForTimeout(1500);
    expect(c.n).toBe(1);
    expect(model).toEqual([]);
  });
  test("human mode: an attestation older than 1 h is re-requested before Open", async ({ page }) => {
    const c = { n: 0 };
    await setup(page, "old", c); // each answer has ~3 s of freshness left
    await toReview(page, true);
    await expect(page.getByTestId("open-offer-btn")).toBeEnabled();
    expect(c.n).toBe(1);
    await expect.poll(() => c.n, { timeout: 15_000 }).toBeGreaterThanOrEqual(2); // silently re-requested, no UI
    await expect(page.getByTestId("preflight-step")).toHaveCount(0);
    await expect(page.getByTestId("preflight-expired")).toHaveCount(0);
  });
  test("human mode: if the silent check fails, Open stays disabled with a plain message and a retry", async ({ page }) => {
    const c = { n: 0 };
    await setup(page, "down", c);
    await toReview(page, true);
    await expect(page.getByTestId("human-attest-error")).toBeVisible();
    await expect(page.getByTestId("open-offer-btn")).toBeDisabled();
    await expect(page.getByTestId("preflight-step")).toHaveCount(0);
  });
  test("SRCREF1 human mode: a Worker refusal (422 lint) shows the Worker's actual reason, not a generic error", async ({ page }) => {
    const c = { n: 0 };
    await setup(page, "lint422", c);
    await toReview(page, true);
    await expect(page.getByTestId("human-attest-error")).toBeVisible();
    await expect(page.getByTestId("human-attest-reason")).toContainText(LINT_REASON);
    await expect(page.getByTestId("open-offer-btn")).toBeDisabled();
  });
  test("SRCREF1 AI mode: a Worker refusal (422 lint) shows the Worker's actual reason", async ({ page }) => {
    const c = { n: 0 };
    await setup(page, "lint422", c);
    await toReview(page, false);
    await expect(page.getByTestId("source-check-error")).toBeVisible();
    await expect(page.getByTestId("preflight-failure-detail")).toContainText(LINT_REASON);
  });
});

// REVIEW1: freeze what the user reviewed (SM1 CRT-1, CRT-4).
test.describe("REVIEW1 source check bound to the reviewed offer", () => {
  test("#2 CRT-1: edit after the AI check -> Open needs a new check, and the Open signs the EDITED terms (what the review card shows)", async ({ page }) => {
    const c = { n: 0 };
    const relayed: any[] = [];
    await setup(page, "pass", c, { relayed });
    await toReview(page, false);
    await expect(page.getByTestId("open-offer-btn")).toBeEnabled();
    expect(c.n).toBe(1);
    // Edit: change the threshold 72 -> 80, review again.
    await page.getByTestId("back-to-create").click();
    await page.getByTestId("resolver-back").click();
    await page.getByTestId("guided-x_f").fill("80");
    await page.getByTestId("fill-next").click();
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("review-card")).toContainText("80");
    // C1: the old check does not cover the edited bet; the edited bet gets its own ONE automatic check (a new paid run)
    await expect.poll(() => c.n).toBe(2);
    await expect(page.getByTestId("open-offer-btn")).toBeEnabled();
    await page.waitForTimeout(1000);
    expect(c.n).toBe(2);
    await page.getByTestId("open-offer-btn").click();
    await expect.poll(() => relayed.length, { timeout: 15_000 }).toBe(1);
    const msg = JSON.parse(relayed[0].args.msg);
    const sheet = JSON.parse(msg.envelope.terms);
    expect(sheet.fields.x_f).toBe(80);
    expect(msg.envelope.terms_hash).toBe(createHash("sha256").update(msg.envelope.terms).digest("hex"));
  });

  test("#2 CRT-1: going back and reviewing the SAME bet keeps the check (no second paid run)", async ({ page }) => {
    const c = { n: 0 };
    await setup(page, "pass", c);
    await toReview(page, false);
    await expect(page.getByTestId("open-offer-btn")).toBeEnabled();
    await page.getByTestId("back-to-create").click();
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("open-offer-btn")).toBeEnabled();
    expect(c.n).toBe(1);
  });

  test("#10 CRT-4: a device clock 10 minutes behind does not expire a fresh check (age comes from chain time)", async ({ page }) => {
    const c = { n: 0 };
    await setup(page, "pass", c, { deviceSkewMs: -10 * 60_000 });
    await toReview(page, false);
    await expect(page.getByTestId("source-check-status")).toContainText("Checking sources… ✓");
    await page.waitForTimeout(1500);
    await expect(page.getByTestId("preflight-expired")).toHaveCount(0);
    await expect(page.getByTestId("preflight-time-left")).toHaveText("Good to open for 59 min.");
    await expect(page.getByTestId("open-offer-btn")).toBeEnabled();
  });

  test("#10 CRT-4: a device clock 10 minutes AHEAD does not either, and person-decides opens with exactly one check", async ({ page }) => {
    const c = { n: 0 };
    await setup(page, "pass", c, { deviceSkewMs: 10 * 60_000 });
    await toReview(page, true);
    await expect(page.getByTestId("open-offer-btn")).toBeEnabled();
    await page.waitForTimeout(1500);
    expect(c.n).toBe(1);
  });

  test("#10: person-decides: an approval that runs out is re-checked once by itself, then a 'Check again' button (no paid loop)", async ({ page }) => {
    const c = { n: 0 };
    await setup(page, "old", c); // every answer has ~3 s of usable life
    await toReview(page, true);
    await expect.poll(() => c.n, { timeout: 15_000 }).toBe(2); // one automatic re-check
    await expect(page.getByTestId("human-attest-recheck")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("open-offer-btn")).toBeDisabled();
    await page.waitForTimeout(4000);
    expect(c.n).toBe(2); // no third automatic run
    await page.getByTestId("human-attest-recheck-btn").click();
    await expect.poll(() => c.n).toBe(3);
  });
});

// C1 (UIR1 §3.4, familiarcow UX-37 #5 #6 #7, PEOPLE RULE): the review is five lines + a collapsed "Full terms", the source check is automatic
// (at most one automatic paid check per reviewed offer) and nothing raw (status word, hash, asset id, long decimals, account id) shows.
const RAW = /\b[0-9a-f]{64}\b|nep141:|sha256|fingerprint|\d\.\d{9,}|\b(ready|idle|blocked|building|signing|relaying)\b|\d{4}-\d\d-\d\dT\d\d/;
test.describe("C1 create review", () => {
  test("one automatic check per reviewed offer: a failure is never retried by itself; back to the SAME bet asks for a press", async ({ page }) => {
    const c = { n: 0 };
    await setup(page, "fail", c);
    await toReview(page, false);
    await expect(page.getByTestId("source-check-error")).toBeVisible();
    await page.waitForTimeout(2000);
    expect(c.n).toBe(1);
    await page.getByTestId("back-to-create").click();
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("review-card")).toBeVisible();
    await expect(page.getByTestId("check-sources-btn")).toHaveText("Check the sources");
    await page.waitForTimeout(1500);
    expect(c.n).toBe(1); // the same offer already had its automatic check
    await page.getByTestId("check-sources-btn").click();
    await expect.poll(() => c.n).toBe(2);
  });

  for (const [name, size] of [["1280", { width: 1280, height: 900 }], ["375", { width: 375, height: 800 }]] as const) {
    test(`${name}px: five lines, Full terms collapsed, one primary 'Open the bet · <you pay now>', nothing raw, no sideways scroll`, async ({ page }) => {
      await page.setViewportSize(size);
      const c = { n: 0 };
      await setup(page, "pass", c);
      await toReview(page, false);
      const card = page.getByTestId("review-card");
      await expect(card.getByTestId("review-summary").locator("dt")).toHaveText(["Bet", "Deadline", "Stakes", "Who decides", "Offer"]);
      await expect(card.getByTestId("review-claim")).toContainText("72");
      await expect(card.getByTestId("review-deadline")).toHaveText(/^Ends in \d+ (months?|days?|year)/);
      await expect(card.getByTestId("review-stakes")).toHaveText("You put in 10 NEAR · they put in 10 NEAR");
      await expect(card.getByTestId("review-decider")).toHaveText(/^The AI judge, from /);
      await expect(card.getByTestId("review-closes")).toHaveText(/^Closes in \d+ days?$/);
      const terms = page.getByTestId("review-full-terms");
      await expect(terms).toHaveJSProperty("open", false);
      await expect(page.getByTestId("source-check-status")).toContainText("Checking sources… ✓");
      await expect(page.getByTestId("open-offer-btn")).toHaveText("Open the bet · 10 NEAR");
      await expect(page.getByTestId("open-status")).toHaveCount(0);
      await expect(page.getByTestId("review-open-gate")).toHaveCount(0);
      // exact times are one tap away
      await card.getByTestId("review-closes").getByRole("button").click();
      await expect(page.getByTestId("time-exact")).toContainText("UTC");
      await page.screenshot({ path: screenPath(`c1/review-${name}.png`), fullPage: true });
      // nothing raw in what is on screen (Full terms, collapsed, is where the exact values live -- UX-37 #7)
      const text = await page.getByTestId("review-step").innerText();
      expect(text).not.toMatch(RAW);
      expect(text).not.toContain(WALLET);
      await terms.locator("summary").click();
      await expect(terms).toHaveJSProperty("open", true);
      await expect(page.getByTestId("review-term-pay-now")).toHaveText(/^10 NEAR \(exactly 10\.\d+ NEAR\)$/);
      await page.screenshot({ path: screenPath(`c1/review-full-terms-${name}.png`), fullPage: true });
      const all = await page.getByTestId("review-step").innerText();
      expect(all.replace(/\(exactly [^)]*\)/g, "")).not.toMatch(RAW); // only the "(exactly …)" values carry long decimals
      expect(all).not.toContain(WALLET);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    });
  }

  test("person decides: the referee is their @username (no id, no tail), the silent check makes no button", async ({ page }) => {
    const c = { n: 0 };
    await setup(page, "pass", c);
    await toReview(page, true);
    await expect(page.getByTestId("review-decider")).toHaveText("@alice, a person (no AI)");
    await page.getByTestId("review-full-terms").locator("summary").click();
    await expect(page.getByTestId("review-term-window")).toHaveText(/^@alice can rule any time until .+ If they don't, you're both refunded\.$/);
    const text = await page.getByTestId("review-step").innerText();
    expect(text.replace(/\(exactly [^)]*\)/g, "")).not.toMatch(RAW);
    expect(text).not.toMatch(/alice\.(testnet|near)|·\s*[0-9a-f]{8}\b/);
    await page.screenshot({ path: screenPath("c1/review-person-1280.png"), fullPage: true });
  });

  test("failure screenshot: one Retry, Fix the bet, Let a person decide", async ({ page }) => {
    const c = { n: 0 };
    await setup(page, "hang", c);
    await toReview(page, false);
    await expect(page.getByTestId("source-check-error")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("review-step").getByRole("button", { name: "Retry" })).toHaveCount(1);
    await expect(page.getByTestId("preflight-fix")).toBeVisible();
    await expect(page.getByTestId("preflight-use-person")).toBeVisible();
    await page.screenshot({ path: screenPath("c1/review-failed-1280.png"), fullPage: true });
  });
});
