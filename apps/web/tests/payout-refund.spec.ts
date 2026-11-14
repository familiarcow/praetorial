// FE13 (S15): one mocked spec per ending in the money table, plus payout progress and retry. Fully mocked: NEAR RPC views (get_bet, pending_payouts),
// relayer POST /relay, wallet seam. No real Privy login; no testnet write.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { mockUsernames, openMoreActions, E2E_REGISTRY } from "./lib/betPage";
import { SCHEMA } from "@near-js/transactions";
import * as borsh from "borsh";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const RELAYER = "http://localhost:8788";
const USDC = "nep141:usdc.testnet";
const HOUR = 3_600_000;
const RESOLVE_MS = Date.UTC(2037, 0, 5);

interface Line { id: number; bet_id: number; token_id: string; receiver: string; amount: string; reason: string; attempts: number; done: boolean; in_flight: boolean }
interface World { me: "maker" | "taker" | "other"; status: string; outcome: string | null; referee: boolean; tipMaker: string; tipTaker: string; proposedAt: number | null; keepTerms: boolean; hasTaker: boolean; pending: Line[]; relays: number }
const world = (o: Partial<World> = {}): World => ({ me: "maker", status: "Settled", outcome: "YES", referee: false, tipMaker: "0", tipTaker: "0", proposedAt: 1, keepTerms: false, hasTaker: true, pending: [], relays: 0, ...o });
const betJson = (w: World) => ({
  envelope: { bet_id: 7, version: 1, maker: w.me === "maker" ? WALLET : "maker.testnet", taker_allow: "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "cd".repeat(32), terms: JSON.stringify({ claim: "Team A wins" }), outcomes: ["YES", "NO"], maker_side: "YES",
    maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: "10000000", taker_options: [], fee_bps: 100, keep_terms: w.keepTerms, funding_deadline: (Date.now() - 48 * HOUR) * 1e6, resolve_deadline: RESOLVE_MS * 1e6, settlement_period: 0,
    referee: w.referee ? { account: "ref.testnet", mode: "Human" } : null, tip_maker: false },
  status: w.status, taker: w.hasTaker ? (w.me === "taker" ? WALLET : "taker.testnet") : null, created_at: 0, taken_at: null, proposed_at: w.proposedAt, outcome: w.outcome, reserve_remaining: "0",
  bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0, fee_min_maker: "500000", fee_min_taker: "500000", tip_maker: w.tipMaker, tip_taker: w.tipTaker, storage_maker: "20000", storage_taker: w.hasTaker ? "20000" : "0", last_resolution_raw: null,
});
// B1: the winner's line goes to the maker's real account (WALLET when "me" is the maker, as in every pending-payout test here).
const line = (o: Partial<Line> = {}): Line => ({ id: 1, bet_id: 7, token_id: USDC, receiver: WALLET, amount: "19000000", reason: "payout_winner", attempts: 1, done: false, in_flight: false, ...o });

async function setup(page: Page, w: World, onRelay?: (w: World, d: { receiver: string; method: string; args: any }) => void) {
  await mockUsernames(page); // B1: people are @usernames on the bet page
  await page.addInitScript((address) => {
    (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => { (window as any).__signs = ((window as any).__signs ?? 0) + 1; return "22".repeat(64); } };
    (window as any).__e2eConfirm = { delayMs: 50, attempts: 4 };
  }, WALLET);
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const reply = (obj: object) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", ...obj }) });
    const ok = (result: unknown) => reply({ result });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      let r: unknown = null;
      switch (params.method_name) {
        case "is_paused": r = false; break;
        case "is_shutdown": r = w.status === "Voided" && w.outcome === null; break;
        case "open_offers": r = []; break;
        case "asset_limit": r = { storage_per_kib: "457" }; break;
        case "mt_balance_of": r = "0"; break;
        case "required_challenge_bond": r = null; break;
        case "get_bet": r = betJson(w); break;
        case "pending_payouts": r = w.pending; break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  const relayed: any[] = [];
  await page.route(`${RELAYER}/relay`, (r) => {
    w.relays++;
    const d = decodeRelayed(JSON.parse(r.request().postData() ?? "{}"));
    relayed.push(d);
    onRelay?.(w, d);
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: `TX${w.relays}` }) });
  });
  return relayed;
}
function decodeRelayed(body: any) {
  const sd: any = borsh.deserialize(SCHEMA.SignedDelegate as any, Buffer.from(body.signedDelegate, "base64"));
  const fc = sd.delegateAction.actions[0].functionCall;
  return { receiver: sd.delegateAction.receiverId as string, method: fc.methodName as string, args: JSON.parse(Buffer.from(fc.args).toString("utf8")) };
}
const open = async (page: Page) => { await page.goto("/bet/7"); await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 }); };
// C1: payout lines name people by @username, which lands after the bet: read them with expect.poll (the resolved state), never once.
const lines = (page: Page) => page.getByTestId("payout-lines").locator("li").allTextContents();

test.describe("FE13 payout and refund screens (S15)", () => {
  test("You won: pot, fee with the $0.50 floor, net, Paid", async ({ page }) => {
    await setup(page, world({ me: "maker", outcome: "YES" }));
    await open(page);
    await expect(page.getByTestId("payout-screen")).toHaveAttribute("data-ending", "won");
    await expect(page.getByTestId("payout-headline")).toHaveText("You won 19.00 USDC.");
    await expect.poll(() => lines(page)).toEqual(["Pot 20.00 USDC − fee 1.00 USDC = 19.00 USDC", "The network storage charge (0.04 USDC) went with the fee."]);
    await expect(page.getByTestId("payout-progress")).toHaveAttribute("data-state", "paid");
    await expect(page.getByTestId("payout-progress-message")).toHaveText("Paid.");
    await expect(page.getByTestId("payout-retry-btn")).toHaveCount(0);
    await expect(page.getByTestId("payout-new-bet")).toHaveAttribute("href", "/new");
    await expect(page.getByTestId("payout-my-bets")).toHaveAttribute("href", "/my-bets");
  });

  test("You won with a referee tip: pot − fee − tip", async ({ page }) => {
    await setup(page, world({ me: "taker", outcome: "NO", referee: true, tipMaker: "500000", tipTaker: "500000", proposedAt: 5 }));
    await open(page);
    await expect(page.getByTestId("payout-headline")).toHaveText("You won 18.00 USDC.");
    await expect.poll(async () => (await lines(page))[0]).toBe("Pot 20.00 USDC − fee 1.00 USDC − tip 1.00 USDC = 18.00 USDC");
  });

  test("You lost: your stake, who was paid, your tip", async ({ page }) => {
    await setup(page, world({ me: "taker", outcome: "YES", referee: true, tipTaker: "500000", proposedAt: 5 }));
    await open(page);
    await expect(page.getByTestId("payout-screen")).toHaveAttribute("data-ending", "lost");
    await expect(page.getByTestId("payout-headline")).toHaveText("You lost 10.00 USDC.");
    await expect.poll(() => lines(page)).toEqual(["@maker was paid.", "Your tip of 0.50 USDC to @ref came out of your stake."]); // B1: people as @usernames
  });

  test("C1: while a @username is still loading the line shows '…', never 'Unnamed account' for a named person", async ({ page }) => {
    await setup(page, world({ me: "taker", outcome: "YES", referee: true, tipTaker: "500000", proposedAt: 5 }));
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    // later routes win: hold the referee's lookup until released, then let mockUsernames answer it
    await page.route(`${E2E_REGISTRY}/lookup/account/ref.testnet`, async (route) => { await held; await route.fallback(); });
    await open(page);
    await expect.poll(() => lines(page)).toEqual(["@maker was paid.", "Your tip of 0.50 USDC to … came out of your stake."]);
    await expect(page.getByTestId("payout-screen")).not.toContainText("Unnamed account");
    release();
    await expect.poll(() => lines(page)).toEqual(["@maker was paid.", "Your tip of 0.50 USDC to @ref came out of your stake."]);
  });

  test("VOID by the AI: stake back, no fee", async ({ page }) => {
    await setup(page, world({ outcome: "VOID" }));
    await open(page);
    await expect(page.getByTestId("payout-screen")).toHaveAttribute("data-ending", "void-ai");
    await expect(page.getByTestId("payout-headline")).toHaveText("This bet was voided. You got your stake back.");
    await expect.poll(() => lines(page)).toEqual(["No fee was charged.", "Refunded: 10.00 USDC stake + 0.02 USDC storage charge = 10.02 USDC."]);
  });

  test("VOID by the referee: no platform fee, tip paid", async ({ page }) => {
    await setup(page, world({ outcome: "VOID", referee: true, tipMaker: "500000", proposedAt: 5 }));
    await open(page);
    await expect(page.getByTestId("payout-screen")).toHaveAttribute("data-ending", "void-referee");
    await expect(page.getByTestId("payout-headline")).toHaveText("@ref voided this bet."); // B1: people as @usernames
    await expect.poll(() => lines(page)).toEqual(["No platform fee was charged.", "Refunded: 9.50 USDC stake after your 0.50 USDC tip + 0.02 USDC storage charge = 9.52 USDC.", "Your tip of 0.50 USDC was paid to @ref."]); // B1: people as @usernames
  });

  test("Referee never ruled: both refunded by the deadline", async ({ page }) => {
    await setup(page, world({ status: "Voided", outcome: "VOID", referee: true, tipMaker: "500000", proposedAt: null }));
    await open(page);
    await expect(page.getByTestId("payout-screen")).toHaveAttribute("data-ending", "deadline");
    await expect(page.getByTestId("payout-headline")).toHaveText("@ref didn't decide in time. Both sides were refunded."); // B1: @username; the exact deadline is under Details -> Money & deadlines
    await expect.poll(() => lines(page)).toEqual(["Refunded: 9.50 USDC stake after your 0.50 USDC tip + 0.02 USDC storage charge = 9.52 USDC.", "Your tip of 0.50 USDC was paid to @ref."]); // B1: people as @usernames
  });

  test("You conceded: the other side was paid, same fee", async ({ page }) => {
    await setup(page, world({ me: "taker", outcome: "YES", proposedAt: null }));
    await open(page);
    await expect(page.getByTestId("payout-screen")).toHaveAttribute("data-ending", "conceded-by-me");
    await expect(page.getByTestId("payout-headline")).toHaveText("You conceded. @maker was paid."); // B1: people as @usernames
    await expect.poll(async () => (await lines(page))[0]).toBe("Same fee as a normal ending: pot 20.00 USDC − fee 1.00 USDC = 19.00 USDC paid.");
  });

  test("The other side conceded: you won", async ({ page }) => {
    await setup(page, world({ me: "maker", outcome: "YES", proposedAt: null }));
    await open(page);
    await expect(page.getByTestId("payout-screen")).toHaveAttribute("data-ending", "conceded-by-other");
    await expect(page.getByTestId("payout-headline")).toHaveText("@taker conceded. You won 19.00 USDC."); // B1: people as @usernames
  });

  for (const status of ["Cancelled", "Expired"]) {
    test(`${status}: nobody took it, refunded in full with the storage charge`, async ({ page }) => {
      await setup(page, world({ status, outcome: null, proposedAt: null, hasTaker: false }));
      await open(page);
      await expect(page.getByTestId("payout-screen")).toHaveAttribute("data-ending", status.toLowerCase());
      // B1: a Cancelled bet was cancelled by its maker (the contract's cancel_offer); Expired = nobody took it in time.
      await expect(page.getByTestId("payout-headline")).toHaveText(status === "Cancelled" ? "You cancelled this bet. Your stake was refunded." : "Nobody took this bet. You were refunded in full.");
      await expect.poll(() => lines(page)).toEqual(["Refunded: 10.00 USDC stake + 0.02 USDC storage charge = 10.02 USDC."]);
    });
  }

  test("Emergency refund: your own deposits back, no fee", async ({ page }) => {
    await setup(page, world({ status: "Voided", outcome: null, proposedAt: null }));
    await open(page);
    await expect(page.getByTestId("payout-screen")).toHaveAttribute("data-ending", "emergency");
    await expect(page.getByTestId("payout-headline")).toHaveText("The app was shut down. You got your own deposits back.");
    await expect.poll(() => lines(page)).toEqual(["No fee was charged.", "Refunded: 10.00 USDC stake + 0.02 USDC storage charge = 10.02 USDC."]);
  });

  test("no payout screen while the bet is still live", async ({ page }) => {
    await setup(page, world({ status: "Taken", outcome: null, proposedAt: null }));
    await open(page);
    await expect(page.getByTestId("bet-status")).toHaveText("Taken");
    await expect(page.getByTestId("payout-screen")).toHaveCount(0);
  });

  test("pending payout: progress with exact line amounts, never 'Paid'; retry sends drain_payouts and ends at Paid", async ({ page }) => {
    const w = world({ status: "Finalized", pending: [line({ attempts: 1, in_flight: true }), line({ id: 2, receiver: "fee.testnet", amount: "1040000", reason: "fee_and_storage", attempts: 2, in_flight: false })] });
    const relayed = await setup(page, w, (x, d) => { if (d.method === "drain_payouts") { x.pending = []; x.status = "Settled"; } });
    await open(page);
    await expect(page.getByTestId("payout-headline")).toHaveText("You won 19.00 USDC.");
    await expect(page.getByTestId("payout-progress")).toHaveAttribute("data-state", "slow");
    await expect(page.getByTestId("payout-progress-message")).toHaveText("Payout is taking longer than usual. Your money is safe in escrow. Retry.");
    await expect(page.getByTestId("payout-progress-lines").locator("li")).toHaveText(["Sending 19.00 USDC to you", "Sending 1.04 USDC to the Praetorial fee account"]); // B1: people, not account ids
    await expect(page.getByTestId("payout-paid")).toHaveCount(0);
    await page.getByTestId("payout-retry-btn").click();
    await expect(page.getByTestId("payout-progress")).toHaveAttribute("data-state", "paid");
    await expect(page.getByTestId("payout-progress-message")).toHaveText("Paid.");
    expect(relayed).toHaveLength(1);
    expect(relayed[0].method).toBe("drain_payouts");
    expect(relayed[0].args).toEqual({ bet_id: 7, limit: 10 });
  });

  test("a retry the contract did not take is reported honestly, not as Paid", async ({ page }) => {
    const w = world({ status: "Finalized", pending: [line({ attempts: 2 })] });
    await setup(page, w); // relay returns ok but the ledger never changes
    await open(page);
    await page.getByTestId("payout-retry-btn").click();
    await expect(page.getByTestId("payout-retry-result")).toContainText("can't see the payout finish yet");
    await expect(page.getByTestId("payout-progress")).not.toHaveAttribute("data-state", "paid");
  });

  test("Cancelled bet whose refund has not been sent yet: in progress with retry", async ({ page }) => {
    const w = world({ status: "Cancelled", outcome: null, proposedAt: null, hasTaker: false, pending: [line({ receiver: "maker.testnet", amount: "10020000", reason: "cancel_expire_refund", attempts: 0 })] });
    await setup(page, w);
    await open(page);
    await expect(page.getByTestId("payout-progress")).toHaveAttribute("data-state", "paying");
    await expect(page.getByTestId("payout-progress-message")).toHaveText("Payout in progress…");
    await expect(page.getByTestId("payout-retry-btn")).toBeVisible();
  });
});
