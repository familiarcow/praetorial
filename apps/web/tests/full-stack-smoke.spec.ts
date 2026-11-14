// FE16 (S18): one mocked smoke across the whole stack: login -> create -> fund -> take -> rule -> payout, once with the AI
// and once with a human referee. Fully mocked (NEAR RPC views, source check, relayer POST /relay, username registry, wallet seam):
// no real Privy login, no testnet write, $0. One stateful world; each relayed call moves it the way the contract would.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { SCHEMA } from "@near-js/transactions";
import * as borsh from "borsh";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const SC = "http://localhost:8790/sourcecheck";
const RELAYER = "http://localhost:8788";
const REG = "http://registry.e2e.test";
const USDC = "nep141:usdc.testnet";
const WASM = JSON.parse(readFileSync(new URL("../lib/release.json", import.meta.url), "utf8")).resolver_wasm_hash;
const DAY = 86_400_000_000_000;
const FUNDING_NS = Date.UTC(2027, 0, 2, 3, 4) * 1_000_000;

interface Line { id: number; bet_id: number; token_id: string; receiver: string; amount: string; reason: string; attempts: number; done: boolean; in_flight: boolean }
interface World { me: "maker" | "taker" | "referee"; created: boolean; status: string; taker: boolean; outcome: string | null; referee: string | null; hash: string; env: any; proposedAt: number | null; pending: Line[]; calls: string[]; fundingNs: number }
const world = (): World => ({ me: "maker", created: false, status: "Open", taker: false, outcome: null, referee: null, hash: "", env: {}, proposedAt: null, pending: [], calls: [], fundingNs: FUNDING_NS });
const payLine = (): Line => ({ id: 1, bet_id: 6, token_id: USDC, receiver: WALLET, amount: "19000000", reason: "payout_winner", attempts: 1, done: false, in_flight: false });

function betJson(w: World) {
  const refAccount = w.referee === null ? null : w.me === "referee" ? WALLET : w.referee;
  return {
    envelope: { ...w.env, bet_id: 6, version: 1, maker: w.me === "maker" ? WALLET : "maker.testnet", taker_allow: "Any", terms_hash: w.hash, models_snapshot_hash: "cd".repeat(32),
      maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: "10000000", taker_options: [], fee_bps: 100, funding_deadline: w.fundingNs,
      resolve_deadline: Date.UTC(2037, 0, 5) * 1e6, settlement_period: DAY, outcomes: ["YES", "NO"], maker_side: "YES",
      referee: refAccount ? { account: refAccount, mode: "Human" } : null, tip_maker: false },
    status: w.status, taker: w.taker ? (w.me === "taker" ? WALLET : "taker.testnet") : null, created_at: 0, taken_at: null, proposed_at: w.proposedAt, outcome: w.outcome, reserve_remaining: "0",
    bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0, fee_min_maker: "500000", fee_min_taker: "500000", tip_maker: "0", tip_taker: "0", storage_maker: "20000", storage_taker: w.taker ? "20000" : "0", last_resolution_raw: null,
  };
}
function decodeRelayed(body: any) {
  const sd: any = borsh.deserialize(SCHEMA.SignedDelegate as any, Buffer.from(body.signedDelegate, "base64"));
  const fc = sd.delegateAction.actions[0].functionCall;
  return { method: fc.methodName as string, args: JSON.parse(Buffer.from(fc.args).toString("utf8")), deposit: String(fc.deposit) };
}

async function setup(page: Page, w: World, opts: { registry?: boolean } = {}) {
  await page.addInitScript((reg) => { (window as any).__e2eConfirm = { delayMs: 50, attempts: 4 }; if (reg) (window as any).__e2eRegistryUrl = reg; }, opts.registry ? REG : null);
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const reply = (obj: object) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", ...obj }) });
    const ok = (result: unknown) => reply({ result });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (body.method === "tx" || body.method === "EXPERIMENTAL_tx_status") return ok({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { logs: [] } }] });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      let r: unknown = null;
      const args = JSON.parse(Buffer.from(params.args_base64 ?? "e30=", "base64").toString("utf8") || "{}");
      switch (params.method_name) {
        case "is_paused": case "is_shutdown": r = false; break;
        case "open_offers": r = []; break;
        case "asset_limit": r = { storage_per_kib: "1" }; break;
        case "resolver_keys": r = ["a", "b", WASM]; break;
        case "mt_balance_of": r = "1" + "0".repeat(30); break;
        case "bet_count": r = w.created ? 6 : 5; break;
        case "required_challenge_bond": r = null; break;
        case "pending_payouts": r = w.pending; break;
        case "get_bet": r = args.bet_id === 6 && w.created ? betJson(w) : null; break;
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
  await page.route(`${RELAYER}/relay`, (r) => {
    const d = decodeRelayed(JSON.parse(r.request().postData() ?? "{}"));
    w.calls.push(d.method);
    // INTENTS1: real intents.near mt_transfer_call needs exactly 1 yocto (assert_one_yocto)
    if (d.method === "mt_transfer_call") expect(d.deposit).toBe("1");
    if (d.method === "mt_transfer_call") {
      const msg = JSON.parse(d.args.msg);
      if (!w.created) { w.created = true; w.status = "Open"; w.env = msg.envelope ?? msg.Open?.envelope ?? {}; }
      else { w.status = "Taken"; w.taker = true; }
    }
    if (d.method === "referee_rule") { w.status = "Settled"; w.outcome = d.args.outcome; w.proposedAt = 1; }
    if (d.method === "finalize") { w.status = "Finalized"; w.pending = [payLine()]; }
    if (d.method === "drain_payouts") { w.status = "Settled"; w.pending = []; }
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: `TX${w.calls.length}` }) });
  });
  await page.route("**/ticker**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ venue: "x", price: 1 }) }));
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  if (opts.registry) {
    await page.route(`${REG}/**`, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const json = (status: number, b: unknown) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(b) });
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST" } });
      if (url.pathname.startsWith("/lookup/account/")) return json(200, { username: "me_myself" });
      if (url.pathname.startsWith("/lookup/username/")) return decodeURIComponent(url.pathname.split("/").pop()!) === "alice" ? json(200, { username: "alice", account_id: "alice.testnet" }) : json(404, { error: "not_found" });
      if (url.pathname === "/search") return json(200, [{ username: "alice", account_tail: "alice.testnet" }]);
      return json(404, {});
    });
  }
}
const ready = (page: Page) => page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
const goBet = async (page: Page) => { await page.goto("/bet/6"); await ready(page); };

// login -> create -> fund. Ends on the share screen of bet #6.
async function loginCreateFund(page: Page, w: World, human: boolean) {
  await page.goto("/new");
  await ready(page);
  await expect(page.getByTestId("login-gate")).toBeVisible(); // logged out: the gate, no form
  await page.addInitScript((address) => { (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => "22".repeat(64) }; }, WALLET);
  await page.evaluate((address) => { (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => "22".repeat(64) }; window.dispatchEvent(new Event("e2e-wallet-changed")); }, WALLET);
  await expect(page.getByTestId("create-offer-form")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("bet-type-card-nws_daily_high").click();
  await page.getByTestId("guided-station").selectOption("KNYC");
  await page.getByTestId("guided-date").fill("2027-12-08");
  await page.getByTestId("guided-op").selectOption(">=");
  await page.getByTestId("guided-x_f").fill("72");
  await page.getByTestId("fill-next").click();
  if (human) {
    await page.getByTestId("decider-person").check();
    await page.getByTestId("referee-search").fill("ali");
    await page.getByTestId("referee-result-0").click();
    w.referee = "alice.testnet";
  }
  await page.getByTestId("maker-amount").fill("10");
  await page.getByTestId("review-offer").click();
  await expect(page.getByTestId("review-card")).toBeVisible();
  if (!human) {
    await expect(page.getByTestId("source-check-status")).toContainText("Checking sources… ✓"); // C1: automatic on entering Review
  }
  await expect(page.getByTestId("open-offer-btn")).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId("open-offer-btn").click();
  await expect(page.getByTestId("share-screen")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("share-title")).toHaveText("Your bet is open. Share the link so the other person can take it.");
  expect(w.calls).toEqual(["mt_transfer_call"]);
}

async function take(page: Page, w: World) {
  w.me = "taker";
  await goBet(page);
  await expect(page.getByTestId("take-open")).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId("take-open").click();
  await page.getByTestId("take-confirm").click(); // M1: one confirm step
  await expect(page.getByTestId("take-result")).toHaveAttribute("data-kind", "taken", { timeout: 20_000 });
  expect(w.calls).toEqual(["mt_transfer_call", "mt_transfer_call"]);
}

test.describe("FE16 whole-stack smoke (mocked)", () => {
  test("AI referee: login -> create -> fund -> take -> AI rules -> finalize -> payout", async ({ page }) => {
    const w = world();
    await setup(page, w);
    await loginCreateFund(page, w, false);
    await take(page, w);
    // The keeper has the AI rule (off-chain, not part of the web app); the challenge window then closes.
    w.status = "Proposed"; w.outcome = "YES"; w.proposedAt = Date.now() * 1_000_000 - 2 * DAY; w.me = "maker";
    await goBet(page);
    await expect(page.getByTestId("ruling-headline")).toContainText("Ruling: YES");
    await expect(page.getByTestId("finalize-btn")).toBeEnabled();
    await page.getByTestId("finalize-btn").click();
    await expect(page.getByTestId("payout-screen")).toHaveAttribute("data-ending", "won", { timeout: 20_000 });
    await expect(page.getByTestId("payout-headline")).toHaveText(/^You won \d+\.\d\d USDC\.$/); // NAV1: token units
    await page.getByTestId("payout-retry-btn").click();
    await expect(page.getByTestId("payout-progress-message")).toHaveText("Paid.");
    expect(w.calls).toEqual(["mt_transfer_call", "mt_transfer_call", "finalize", "drain_payouts"]);
  });

  test("human referee: login -> create (person) -> fund -> take -> the referee rules -> payout", async ({ page }) => {
    const w = world();
    await setup(page, w, { registry: true });
    await loginCreateFund(page, w, true);
    await take(page, w);
    w.status = "Taken"; w.me = "referee"; w.fundingNs = (Date.now() - 3_600_000) * 1e6; // the referee may rule from the funding deadline on
    await goBet(page);
    await expect(page.getByTestId("referee-banner")).toContainText("You're the referee for this bet");
    await page.getByTestId("referee-btn-YES").click();
    await page.getByTestId("referee-confirm-btn").click();
    await expect(page.getByTestId("referee-result")).toContainText("Done.", { timeout: 20_000 });
    expect(w.calls).toEqual(["mt_transfer_call", "mt_transfer_call", "referee_rule"]);
    w.me = "maker";
    await goBet(page);
    await expect(page.getByTestId("payout-screen")).toHaveAttribute("data-ending", "won");
    await expect(page.getByTestId("payout-headline")).toHaveText(/^You won \d+\.\d\d USDC\.$/); // NAV1: token units
    await expect(page.getByTestId("payout-progress")).toHaveAttribute("data-state", "paid");
  });
});
