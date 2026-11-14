// FE4b (D-FE4b): referee picker uses the registry's exact username lookup for the FULL account id (implicit ids allowed),
// searchStrict errors are shown (not "no results"), and the tip checkbox appears only after a referee is picked.
// Fully mocked (NEAR RPC, registry, source check, relayer via page.route; wallet via window.__e2eTestWallet). No real Privy login.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const WALLET = "11".repeat(32);
const IVY = "ab".repeat(28) + "12345678"; // implicit 64-hex account; search only exposes the tail "12345678"
const RPC = "https://test.rpc.fastnear.com";
const REG = "http://registry.e2e.test";
const RELAYER = "http://localhost:8788";
const WASM = JSON.parse(readFileSync(new URL("../lib/release.json", import.meta.url), "utf8")).resolver_wasm_hash;

interface World { search: "ok" | "500" | "abort"; lookup: "ok" | "404" | "500"; relayBodies: string[]; lookups: string[] }
const world = (o: Partial<World> = {}): World => ({ search: "ok", lookup: "ok", relayBodies: [], lookups: [], ...o });

async function setup(page: Page, w: World) {
  await page.addInitScript(({ address, reg }) => { (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => "22".repeat(64) }; (window as any).__e2eRegistryUrl = reg; (window as any).__e2eConfirm = { delayMs: 50, attempts: 2 }; }, { address: WALLET, reg: REG });
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      const name = params.method_name;
      const r = name === "is_paused" || name === "is_shutdown" ? false : name === "open_offers" ? [] : name === "asset_limit" ? { storage_per_kib: "1" } : name === "resolver_keys" ? ["a", "b", WASM] : name === "mt_balance_of" ? "1" + "0".repeat(30) : name === "bet_count" ? 5 : null;
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  await page.route(`${REG}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const cors = { "access-control-allow-origin": "*" };
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST" } });
    if (url.pathname.startsWith("/lookup/account/")) return json(200, { username: url.pathname.endsWith(IVY) ? "ivy" : "me_myself" });
    if (url.pathname.startsWith("/lookup/username/")) {
      w.lookups.push(decodeURIComponent(url.pathname.split("/").pop()!));
      if (w.lookup === "404") return json(404, { error: "not_found" });
      if (w.lookup === "500") return json(500, { error: "boom" });
      return json(200, { username: "ivy", account_id: IVY });
    }
    if (url.pathname === "/search") {
      if (w.search === "abort") return route.abort();
      if (w.search === "500") return json(500, { error: "boom" });
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return json(200, [{ username: "ivy", account_tail: "12345678" }, { username: "alice", account_tail: "alice.testnet" }].filter((u) => u.username.includes(q)));
    }
    return json(404, {});
  });
  await page.route("http://localhost:8790/sourcecheck", async (route) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: true, spec_hash: createHash("sha256").update(JSON.parse(route.request().postData() ?? "{}").terms ?? "").digest("hex"), checked_at: String(Date.now() * 1_000_000), unreachable: [], signing: { signature_hex: "33".repeat(64) } }) }));
  await page.route(`${RELAYER}/relay`, (r) => { w.relayBodies.push(r.request().postData() ?? ""); return r.fulfill({ status: 500, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: false, error: "relayer down" }) }); });
  await page.route("**/ticker**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ venue: "x", price: 100000 }) }));
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto("/new");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
  await expect(page.getByTestId("create-offer-form")).toBeVisible();
}
async function toResolver(page: Page, w: World) {
  await setup(page, w);
  await page.getByTestId("bet-type-card-nws_daily_high").click();
  await page.getByTestId("guided-station").selectOption("KNYC");
  await page.getByTestId("guided-date").fill("2027-12-08");
  await page.getByTestId("guided-op").selectOption(">=");
  await page.getByTestId("guided-x_f").fill("72");
  await page.getByTestId("fill-next").click();
  await expect(page.getByTestId("step-resolver")).toBeVisible();
  await page.getByTestId("decider-person").check();
}
const search = (page: Page, q: string) => page.getByTestId("referee-search").fill(q);

test.describe("FE4b referee picker (D-FE4b)", () => {
  test("implicit account: pick looks up the full id; selected row and review show username + tail; the signed envelope carries the full id", async ({ page }) => {
    const w = world();
    await toResolver(page, w);
    await search(page, "iv");
    await expect(page.getByTestId("referee-result-0")).toContainText("@ivy");
    await expect(page.getByTestId("referee-result-0")).toContainText("12345678");
    await page.getByTestId("referee-result-0").click();
    await expect(page.getByTestId("referee-selected")).toContainText("@ivy");
    await expect(page.getByTestId("referee-selected")).toContainText("12345678");
    await expect(page.getByTestId("referee-pick-error")).toHaveCount(0);
    expect(w.lookups).toEqual(["ivy"]);
    await page.getByTestId("maker-amount").fill("10");
    await page.getByTestId("review-offer").click();
    await expect(page.getByTestId("review-card")).toBeVisible();
    // C1 (PEOPLE RULE): the referee is "@ivy" on the review -- no account id, no tail
    await expect(page.getByTestId("review-decider")).toHaveText("@ivy, a person (no AI)");
    await expect(page.getByTestId("review-card")).not.toContainText(IVY);
    await expect(page.getByTestId("review-card")).not.toContainText("12345678");
    await expect(page.getByTestId("open-offer-btn")).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId("open-offer-btn").click();
    await expect.poll(() => w.relayBodies.length, { timeout: 20_000 }).toBeGreaterThan(0);
    // the relay body carries the borsh-encoded signed delegate (base64); the Open msg inside is plain JSON text
    const sd = JSON.parse(w.relayBodies[0]).signedDelegate as string;
    const decoded = Buffer.from(sd, "base64").toString("latin1");
    const msgJson = decoded;
    expect(msgJson).toContain(`\\"referee\\":{\\"account\\":\\"${IVY}\\",\\"mode\\":\\"Human\\"}`);
    expect(msgJson).not.toContain(`\\"account\\":\\"12345678\\"`);
  });

  for (const mode of ["404", "500"] as const) {
    test(`lookup ${mode}: clear error, referee NOT set, no fallback to the tail`, async ({ page }) => {
      const w = world({ lookup: mode });
      await toResolver(page, w);
      await search(page, "iv");
      await page.getByTestId("referee-result-0").click();
      await expect(page.getByTestId("referee-pick-error")).toHaveText("We couldn't look that person up. Try again, pick someone else, or pick the AI.");
      await expect(page.getByTestId("referee-selected")).toHaveCount(0);
      await expect(page.getByTestId("tip-maker-checkbox")).toHaveCount(0);
      await expect(page.getByTestId("referee-block-hint")).toBeVisible();
      await page.getByTestId("review-offer").click();
      await expect(page.getByTestId("review-card")).toHaveCount(0); // nothing to review: no referee was set
    });
  }

  for (const mode of ["500", "abort"] as const) {
    test(`search ${mode}: shows "We can't search right now" (not "no results"), AI still pickable`, async ({ page }) => {
      const w = world({ search: mode });
      await toResolver(page, w);
      await search(page, "iv");
      await expect(page.getByTestId("referee-search-error")).toHaveText("We can't search right now. Try again, or pick the AI.");
      await expect(page.getByTestId("referee-no-results")).toHaveCount(0);
      await expect(page.getByTestId("referee-invite-text")).toHaveCount(0);
      await expect(page.getByTestId("referee-results")).toHaveCount(0);
      // recovers on the next successful search
      w.search = "ok";
      await search(page, "ivy");
      await expect(page.getByTestId("referee-result-0")).toContainText("@ivy");
      await expect(page.getByTestId("referee-search-error")).toHaveCount(0);
      await page.getByTestId("decider-ai").check();
      await expect(page.getByTestId("referee-search")).toHaveCount(0);
    });
  }

  test("tip checkbox appears only after a referee is picked (D-FE4b); the tip stays unflagged (D-REFUI4)", async ({ page }) => {
    const w = world();
    await toResolver(page, w);
    await expect(page.getByTestId("referee-search")).toBeVisible();
    await expect(page.getByTestId("tip-maker-checkbox")).toHaveCount(0);
    await search(page, "alice");
    await expect(page.getByTestId("tip-maker-checkbox")).toHaveCount(0);
    await page.getByTestId("referee-result-0").click();
    await expect(page.getByTestId("referee-selected")).toBeVisible();
    await expect(page.getByTestId("tip-maker-checkbox")).toBeVisible();
    await expect(page.getByTestId("tip-maker-checkbox")).not.toBeChecked();
    await page.getByTestId("tip-maker-checkbox").check();
    await expect(page.getByTestId("referee-cost-line")).toContainText("out of your");
    await expect(page.getByTestId("review-offer")).toBeEnabled(); // no "tip" flag / warning blocks
    await page.getByTestId("referee-change").click();
    await expect(page.getByTestId("tip-maker-checkbox")).toHaveCount(0);
  });
});
