// FUND2 (mocked): a user funded only through a deposit address has a betting balance on intents but NO NEAR account on chain
// (no access key). Before FUND2 the Open crashed reading the nonce ("Cannot convert undefined to a BigInt") and said "couldn't be
// sent" on every retry (live probe: spikes/fund2/NOTES.md). Now the app asks the relayer to create the account, then opens.
// Harness copied from fund-publish.spec.ts. Never a real Privy login; never a testnet write.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const SC = "http://localhost:8790/sourcecheck";
const RELAYER = "http://localhost:8788";
const WASM = JSON.parse(readFileSync(new URL("../lib/release.json", import.meta.url), "utf8")).resolver_wasm_hash;

interface World {
  relayCalls: number;
  count: number;          // bet_count the mock reports
  hash: string;           // terms hash of the bet the app is opening
  status: string;         // get_bet status for the new bet
  txLogs: string[] | "unavailable";
  openOnRelay: boolean;   // the first relay call creates bet #6
  onSecondRelay: "Cancelled" | "Taken" | null;
  relayFail: boolean;
  activated: boolean;   // FUND2: the implicit account exists on chain
  activateCalls: number;
  activateRefuse: string | null;
}
const FUNDING_NS = Date.UTC(2027, 0, 2, 3, 4) * 1_000_000;

function betJson(w: World) {
  return {
    envelope: { bet_id: 6, version: 1, maker: WALLET, taker_allow: "Any", terms_hash: w.hash, maker_asset: "nep141:wrap.testnet", taker_asset: "nep141:wrap.testnet", stake_maker: "10", stake_taker: "10", taker_options: [], funding_deadline: FUNDING_NS, referee: null, outcomes: ["YES", "NO"], maker_side: "YES" },
    status: w.status, taker: null, created_at: 0, taken_at: null, proposed_at: null, outcome: null, reserve_remaining: "0", bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0,
  };
}

async function setup(page: Page, w: World, opts: { decline?: boolean } = {}) {
  await page.addInitScript(({ address, decline }) => {
    (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => { if (decline) throw new Error("User rejected the request"); return "22".repeat(64); } };
    (window as any).__e2eConfirm = { delayMs: 50, attempts: 4 };
  }, { address: WALLET, decline: !!opts.decline });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const reply = (obj: object) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", ...obj }) });
    const ok = (result: unknown) => reply({ result });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (body.method === "tx" || body.method === "EXPERIMENTAL_tx_status") {
      if (w.txLogs === "unavailable") return reply({ error: { name: "UNKNOWN_TRANSACTION", cause: { name: "UNKNOWN_TRANSACTION" } } });
      return ok({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { logs: w.txLogs } }] });
    }
    // FUND2: a deposit-only user: no NEAR account (so no key) until the relayer activates it. Real RPC shape for a missing key.
    if (params.request_type === "view_access_key") return w.activated ? ok({ nonce: 277000000000000 }) : ok({ error: `access key ed25519:x does not exist while viewing`, logs: [], block_height: 100 });
    if (params.request_type === "view_account") return w.activated ? ok({ amount: "2000000000000000000000" }) : reply({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, message: `account ${WALLET} does not exist while viewing` } });
    if (params.request_type === "call_function") {
      let r: unknown = null;
      const args = JSON.parse(Buffer.from(params.args_base64 ?? "e30=", "base64").toString("utf8") || "{}");
      switch (params.method_name) {
        case "is_paused": case "is_shutdown": r = false; break;
        case "open_offers": r = []; break;
        case "asset_limit": r = { storage_per_kib: "1" }; break;
        case "resolver_keys": r = ["a", "b", WASM]; break;
        case "mt_balance_of": r = "1" + "0".repeat(30); break; // the betting balance a deposit address credited
        case "bet_count": r = w.count; break;
        case "get_bet": r = args.bet_id === 6 && w.count >= 6 ? betJson(w) : null; break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  await page.route(SC, async (route) => {
    const { terms } = JSON.parse(route.request().postData() ?? "{}");
    w.hash = createHash("sha256").update(terms).digest("hex"); // C1: the terms the app checked (= what the Open signs); the review no longer prints the hash
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: true, spec_hash: createHash("sha256").update(terms).digest("hex"), checked_at: String(Date.now() * 1_000_000), unreachable: [], signing: { signature_hex: "33".repeat(64) } }) });
  });
  await page.route(`${RELAYER}/activate`, (r) => {
    w.activateCalls++;
    expect(JSON.parse(r.request().postData() ?? "{}")).toEqual({ accountId: WALLET });
    if (w.activateRefuse) return r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: w.activateRefuse }) });
    w.activated = true;
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, activated: true, txHash: "ACT1" }) });
  });
  await page.route(`${RELAYER}/relay`, (r) => {
    if (!w.activated) return r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "internal relayer error" }) });
    w.relayCalls++;
    if (w.relayFail) return r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "relayer down" }) });
    if (w.relayCalls === 1 && w.openOnRelay) { w.count = 6; w.status = "Open"; }
    if (w.relayCalls === 2 && w.onSecondRelay) w.status = w.onSecondRelay;
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: `TX${w.relayCalls}` }) });
  });
  await page.route("**/ticker**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ venue: "x", price: 1 }) }));
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto("/new");
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
}

async function toChecked(page: Page, w: World) {
  await page.getByTestId("bet-type-card-nws_daily_high").click();
  await page.getByTestId("guided-station").selectOption("KNYC");
  await page.getByTestId("guided-date").fill("2027-12-08");
  await page.getByTestId("guided-op").selectOption(">=");
  await page.getByTestId("guided-x_f").fill("72");
  await page.getByTestId("fill-next").click();
  await page.getByTestId("maker-amount").fill("10");
  await page.getByTestId("review-offer").click();
  await expect(page.getByTestId("review-card")).toBeVisible();
  await expect(page.getByTestId("source-check-status")).toContainText("Checking sources… ✓"); // C1: automatic on entering Review
}

const world = (over: Partial<World> = {}): World => ({ relayCalls: 0, count: 5, hash: "", status: "Open", txLogs: [], openOnRelay: true, onSecondRelay: null, relayFail: false, activated: false, activateCalls: 0, activateRefuse: null, ...over });

test.describe("FUND2 deposit-only user (no NEAR account yet)", () => {
  test("opens a bet: the relayer creates the account once, then the one signature is relayed and the share screen shows", async ({ page }) => {
    const w = world();
    await setup(page, w);
    await toChecked(page, w);
    await page.getByTestId("open-offer-btn").click();
    await expect(page.getByTestId("share-screen")).toBeVisible({ timeout: 20_000 });
    expect(w.activateCalls).toBe(1);
    expect(w.relayCalls).toBe(1);
  });

  test("relayer refuses to set the account up: plain message with its reason, nothing relayed, can try again", async ({ page }) => {
    const w = world({ activateRefuse: "this account has no betting balance yet; add money first, then try again" });
    await setup(page, w);
    await toChecked(page, w);
    await page.getByTestId("open-offer-btn").click();
    await expect(page.getByTestId("open-result")).toContainText("We couldn't set up your account on NEAR yet, so nothing was sent.", { timeout: 20_000 });
    await expect(page.getByTestId("open-result")).toContainText("no betting balance yet");
    await expect(page.getByTestId("open-result")).not.toContainText("BigInt");
    expect(w.relayCalls).toBe(0);
    await expect(page.getByTestId("share-screen")).toHaveCount(0);
  });

  test("account already exists (wallet NEAR user): no activation call", async ({ page }) => {
    const w = world({ activated: true });
    await setup(page, w);
    await toChecked(page, w);
    await page.getByTestId("open-offer-btn").click();
    await expect(page.getByTestId("share-screen")).toBeVisible({ timeout: 20_000 });
    expect(w.activateCalls).toBe(0);
  });
});
