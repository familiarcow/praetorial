// WEBE2E1 (D-WEBE2E1): one mocked journey per ENDING, each driven from the live bet page (/bet/7) through the action / ruling screen to the
// payout screen, the mocked chain advancing between steps (state changes only when the relayed call lands, as in the contract). Fully mocked:
// NEAR RPC views, relayer POST /relay, wallet seam. No live chain, no NEAR AI. The ids/titles are pinned by fixtures/endings.ts and
// endings-matrix.unit.test.ts. Payout money lines are computed from the mocked get_bet + side_fee (lib.rs), never hard-coded per test.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { mockUsernames, openMoreActions } from "./lib/betPage";
import { SCHEMA } from "@near-js/transactions";
import * as borsh from "borsh";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const RELAYER = "http://localhost:8788";
const USDC = "nep141:usdc.testnet";
const HOUR = 3_600_000;
const DAY_NS = 86_400_000_000_000;
const TERMS = JSON.stringify({ claim: "BTC closes above 100k", sources_allowed: [{ id: "S_CB", publisher: "Coinbase BTC-USD", url: "https://coinbase.example/btc" }] });
const RAW = JSON.stringify({ judge: { run_diagnostics: [{ model: "m1", content_head: JSON.stringify({ answer: "met", quote: "BTC-USD close 101250.10", source_id: "S_CB", reason: "above" }) }] } });
const STAKE = 10_000_000n, FEE_BPS = 100n, FEE_MIN = 500_000n, STORAGE = 20_000n;
const BOND = ["4000000", "8000000"];

interface Line { id: number; bet_id: number; token_id: string; receiver: string; amount: string; reason: string; attempts: number; done: boolean; in_flight: boolean }
interface World {
  me: "maker" | "taker" | "referee"; status: string; outcome: string | null; referee: boolean; ruled: boolean; ageNs: number; bonds: number; down: boolean;
  resolveMs: number; pending: Line[]; relays: number; rawRuling: boolean;
}
const world = (o: Partial<World> = {}): World => ({ me: "maker", status: "Taken", outcome: null, referee: false, ruled: false, ageNs: 60_000_000_000, bonds: 0, down: false, resolveMs: Date.UTC(2037, 0, 5), pending: [], relays: 0, rawRuling: false, ...o });
const betJson = (w: World) => ({
  envelope: { bet_id: 7, version: 1, maker: w.me === "maker" ? WALLET : "maker.testnet", taker_allow: "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "cd".repeat(32), terms: w.referee ? JSON.stringify({ claim: "Team A wins" }) : TERMS, outcomes: ["YES", "NO"], maker_side: "YES",
    maker_asset: USDC, taker_asset: USDC, stake_maker: String(STAKE), stake_taker: String(STAKE), taker_options: [], fee_bps: Number(FEE_BPS), keep_terms: false, funding_deadline: Date.now() * 1e6 - 48 * HOUR * 1e6, resolve_deadline: w.resolveMs * 1e6, settlement_period: w.referee ? 0 : DAY_NS,
    referee: w.referee ? { account: w.me === "referee" ? WALLET : "ref.testnet", mode: "Human" } : null, tip_maker: false },
  status: w.status, taker: w.me === "taker" ? WALLET : "taker.testnet", referee_proposal: { maker_value: null, taker_value: null }, created_at: 0, taken_at: null, proposed_at: w.ruled ? Date.now() * 1e6 - w.ageNs : null, outcome: w.outcome, reserve_remaining: "0",
  bonds: Array.from({ length: w.bonds }, (_, i) => ({ holder: "x", amount: "1", round: i + 1, pre_challenge_outcome: "YES", asset: USDC })), exhibits: [], challenged_by: null, window_extension_ns: 0,
  fee_min_maker: String(FEE_MIN), fee_min_taker: String(FEE_MIN), tip_maker: "0", tip_taker: "0", storage_maker: String(STORAGE), storage_taker: String(STORAGE), last_resolution_raw: w.rawRuling ? RAW : null,
});
const line = (o: Partial<Line> = {}): Line => ({ id: 1, bet_id: 7, token_id: USDC, receiver: "maker.testnet", amount: "19000000", reason: "payout_winner", attempts: 1, done: false, in_flight: false, ...o });

// Money lines derived from the mocked bet exactly as lib.rs side_fee / payoutScreen: fee per side = max(stake*bps/10000, floor), pot = both stakes.
const sideFee = (s: bigint) => { const p = (s * FEE_BPS) / 10_000n; const f = p > FEE_MIN ? p : FEE_MIN; return f < s ? f : s; };
// NAV1 (UX-31): USDC amounts are token units ("19.00 USDC"), never dollars.
const usd = (u: bigint) => `${u / 1_000_000n}.${((u % 1_000_000n) / 10_000n).toString().padStart(2, "0")} USDC`;
const POT = STAKE * 2n, FEE = sideFee(STAKE) * 2n, NET = POT - FEE;
const WIN_LINES = [`Pot ${usd(POT)} − fee ${usd(FEE)} = ${usd(NET)}`, `The network storage charge (${usd(STORAGE * 2n)}) went with the fee.`];
const REFUND = `Refunded: ${usd(STAKE)} stake + ${usd(STORAGE)} storage charge = ${usd(STAKE + STORAGE)}.`;

async function setup(page: Page, w: World, onRelay: (w: World, d: { receiver: string; method: string; args: any }) => void) {
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
        case "is_shutdown": r = w.down; break;
        case "open_offers": r = []; break;
        case "asset_limit": r = { storage_per_kib: "457" }; break;
        case "mt_balance_of": r = "1" + "0".repeat(20); break;
        case "required_challenge_bond": r = w.bonds >= 2 ? null : { amount: BOND[w.bonds], asset: USDC }; break;
        case "get_bet": r = betJson(w); break;
        case "pending_payouts": r = w.pending; break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  const relayed: { receiver: string; method: string; args: any }[] = [];
  await page.route(`${RELAYER}/relay`, (r) => {
    w.relays++;
    const sd: any = borsh.deserialize(SCHEMA.SignedDelegate as any, Buffer.from(JSON.parse(r.request().postData() ?? "{}").signedDelegate, "base64"));
    const fc = sd.delegateAction.actions[0].functionCall;
    const d = { receiver: sd.delegateAction.receiverId as string, method: fc.methodName as string, args: JSON.parse(Buffer.from(fc.args).toString("utf8")) };
    relayed.push(d);
    onRelay(w, d);
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: `TX${w.relays}` }) });
  });
  return relayed;
}
const open = async (page: Page) => { await page.goto("/bet/7"); await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 }); };
const lines = (page: Page) => page.getByTestId("payout-lines").locator("li").allTextContents();
const signs = (page: Page) => page.evaluate(() => (window as any).__signs ?? 0);

// The chain's own transition for finalize (the AI's ruling becomes final once the window has passed).
const settleOnFinalize = (x: World, d: { method: string }) => { if (d.method === "finalize") { x.status = "Settled"; } };

test.describe("WEBE2E1 endings journeys: bet page -> action/ruling -> payout", () => {
  test("journey: AI rules YES -> finalize -> payout (maker wins)", async ({ page }) => {
    const w = world({ me: "maker", status: "Proposed", outcome: "YES", ruled: true, rawRuling: true });
    const relayed = await setup(page, w, settleOnFinalize);
    await open(page);
    await expect(page.getByTestId("bet-status")).toHaveText("Proposed");
    await expect(page.getByTestId("ruling-headline")).toContainText("Ruling: YES");
    // B1 (familiarcow UX-37 #6): dates are relative on screen, the exact time stays on the <time> (local + UTC on tap).
    await expect(page.getByTestId("ruling-final")).toHaveText(/^Becomes final in \d+ h unless someone challenges\.$/);
    await expect(page.getByTestId("ruling-final").locator("time")).toHaveAttribute("datetime", /^\d{4}-\d\d-\d\dT\d\d:\d\d/);
    await expect(page.getByTestId("payout-screen")).toHaveCount(0);
    w.ageNs = 2 * DAY_NS; // the challenge window elapses
    await open(page);
    await page.getByTestId("finalize-btn").click();
    await expect(page.getByTestId("payout-screen")).toHaveAttribute("data-ending", "won", { timeout: 20_000 });
    expect(relayed.map((r) => r.method)).toEqual(["finalize"]);
    expect(relayed[0].args).toEqual({ bet_id: 7 });
    await expect(page.getByTestId("payout-headline")).toHaveText(`You won ${usd(NET)}.`);
    expect(await lines(page)).toEqual(WIN_LINES);
    await expect(page.getByTestId("payout-progress")).toHaveAttribute("data-state", "paid");
    await expect(page.getByTestId("payout-progress-message")).toHaveText("Paid.");
  });

  test("journey: AI rules NO -> finalize -> payout (maker lost)", async ({ page }) => {
    const w = world({ me: "maker", status: "Proposed", outcome: "NO", ruled: true, rawRuling: true, ageNs: 2 * DAY_NS });
    const relayed = await setup(page, w, settleOnFinalize);
    await open(page);
    await expect(page.getByTestId("ruling-headline")).toContainText("Ruling: NO");
    await page.getByTestId("finalize-btn").click();
    await expect(page.getByTestId("payout-screen")).toHaveAttribute("data-ending", "lost", { timeout: 20_000 });
    expect(relayed.map((r) => r.method)).toEqual(["finalize"]);
    await expect(page.getByTestId("payout-headline")).toHaveText(`You lost ${usd(STAKE)}.`);
    expect(await lines(page)).toEqual(["@taker was paid."]); // B1: people as @usernames
    await expect(page.getByTestId("payout-progress-message")).toHaveText("Paid.");
  });

  test("journey: AI VOID (unavailability) -> finalize -> refund payout, no fee", async ({ page }) => {
    const w = world({ me: "taker", status: "Proposed", outcome: "VOID:source_unavailable", ruled: true, rawRuling: true, ageNs: 2 * DAY_NS });
    const relayed = await setup(page, w, (x, d) => { if (d.method === "finalize") { x.status = "Settled"; x.outcome = "VOID"; } });
    await open(page);
    await expect(page.getByTestId("ruling-headline")).toContainText("Ruling: VOID");
    await expect(page.getByTestId("ruling-body")).toHaveText("The AI couldn't settle this fairly. You'll both get your money back.");
    await page.getByTestId("finalize-btn").click();
    await expect(page.getByTestId("payout-screen")).toHaveAttribute("data-ending", "void-ai", { timeout: 20_000 });
    expect(relayed.map((r) => r.method)).toEqual(["finalize"]);
    await expect(page.getByTestId("payout-headline")).toHaveText("This bet was voided. You got your stake back.");
    expect(await lines(page)).toEqual(["No fee was charged.", REFUND]);
    await expect(page.getByTestId("payout-progress-message")).toHaveText("Paid.");
  });

  test("journey: AI ruling challenged (one round) -> re-ruled -> finalize -> payout", async ({ page }) => {
    // The AI rules YES (the maker's side); the taker challenges with the contract-quoted bond; the AI re-rules NO; the window passes; finalize.
    const w = world({ me: "taker", status: "Proposed", outcome: "YES", ruled: true, rawRuling: true });
    const relayed = await setup(page, w, (x, d) => {
      if (d.method === "mt_transfer_call") { x.bonds++; x.status = "Challenged"; }
      if (d.method === "finalize") { x.status = "Settled"; }
    });
    await open(page);
    await expect(page.getByTestId("challenge-round")).toHaveText("First challenge"); // B1: plain words (UX-37)
    await expect(page.getByTestId("challenge-bond-line")).toHaveText("Challenging costs a bond of 4 USDC. You get it back if you win the challenge.");
    await page.getByTestId("challenge-btn").click();
    await page.getByTestId("challenge-confirm").click(); // MODAL1c3: the bond is shown in a modal first
    await expect(page.getByTestId("challenge-result")).toContainText("Your challenge is in");
    expect(await signs(page)).toBe(1);
    expect(relayed[0].method).toBe("mt_transfer_call");
    expect(relayed[0].args.amount).toBe("4000000");
    expect(JSON.parse(relayed[0].args.msg)).toEqual({ kind: "Bond", bet_id: 7, round: 1 });
    // The chain moves on: the AI's second run flips the ruling, a fresh window opens, then it elapses.
    w.status = "Proposed"; w.outcome = "NO"; w.ageNs = 60_000_000_000;
    await open(page);
    await expect(page.getByTestId("ruling-headline")).toContainText("Ruling: NO");
    await expect(page.getByTestId("payout-screen")).toHaveCount(0);
    w.ageNs = 2 * DAY_NS;
    await open(page);
    await page.getByTestId("finalize-btn").click();
    await expect(page.getByTestId("payout-screen")).toHaveAttribute("data-ending", "won", { timeout: 20_000 });
    expect(relayed.map((r) => r.method)).toEqual(["mt_transfer_call", "finalize"]);
    await expect(page.getByTestId("payout-headline")).toHaveText(`You won ${usd(NET)}.`);
    expect(await lines(page)).toEqual(WIN_LINES);
    await expect(page.getByTestId("payout-progress-message")).toHaveText("Paid.");
  });

  test("journey: concede -> payout in progress -> retry -> Paid", async ({ page }) => {
    const w = world({ me: "taker", status: "Taken" });
    const relayed = await setup(page, w, (x, d) => {
      if (d.method === "concede") {
        x.status = "Finalized"; x.outcome = "YES"; // the maker's side wins; concede never sets proposed_at
        x.pending = [line({ attempts: 0 }), line({ id: 2, receiver: "fee.testnet", amount: String(FEE + STORAGE * 2n), reason: "fee_and_storage", attempts: 0 })];
      }
      if (d.method === "drain_payouts") { x.pending = []; x.status = "Settled"; }
    });
    await open(page);
    await expect(page.getByTestId("payout-screen")).toHaveCount(0);
    await openMoreActions(page); // B1 (UX-37 #4): Concede is under the collapsed More actions
    await page.getByTestId("concede-btn").click();
    // MODAL1c3: the confirm text moved from window.confirm into the modal (same words)
    await expect(page.getByTestId("concede-terms")).toContainText("cannot be undone");
    await expect(page.getByTestId("concede-terms")).toContainText("@maker is paid"); // M1 (PEOPLE RULE): never the raw id
    await expect(page.getByTestId("concede-terms")).not.toContainText("maker.testnet");
    await page.getByTestId("concede-confirm").click();
    await page.getByTestId("flow-done").click();
    await expect(page.getByTestId("payout-screen")).toHaveAttribute("data-ending", "conceded-by-me", { timeout: 20_000 });
    expect(await signs(page)).toBe(1);
    await expect(page.getByTestId("payout-headline")).toHaveText("You conceded. @maker was paid."); // B1: people as @usernames
    expect((await lines(page))[0]).toBe(`Same fee as a normal ending: pot ${usd(POT)} − fee ${usd(FEE)} = ${usd(NET)} paid.`);
    await expect(page.getByTestId("payout-progress")).not.toHaveAttribute("data-state", "paid");
    await expect(page.getByTestId("payout-progress-lines").locator("li")).toHaveText([`Sending ${usd(NET)} to @maker`, `Sending ${usd(FEE + STORAGE * 2n)} to the Praetorial fee account`]); // B1: people, not account ids
    await page.getByTestId("payout-retry-btn").click();
    await expect(page.getByTestId("payout-progress")).toHaveAttribute("data-state", "paid");
    await expect(page.getByTestId("payout-progress-message")).toHaveText("Paid.");
    expect(relayed.map((r) => r.method)).toEqual(["concede", "drain_payouts"]);
    expect(relayed[1].args).toEqual({ bet_id: 7, limit: 10 });
  });

  test("journey: human referee rules YES -> payout", async ({ page }) => {
    const w = world({ me: "referee", referee: true, status: "Taken", resolveMs: Date.now() + 48 * HOUR });
    const relayed = await setup(page, w, (x, d) => { if (d.method === "referee_rule") { x.status = "Settled"; x.outcome = d.args.outcome; x.ruled = true; } });
    await open(page);
    await expect(page.getByTestId("referee-banner")).toContainText("You're the referee for this bet");
    await page.getByTestId("referee-btn-YES").click();
    // M1: the sentence names the winner as @username; the "can't be undone" part is the sheet's risk line.
    await expect(page.getByTestId("referee-confirm-text")).toHaveText(`You're ruling YES: @maker wins ${NET / 1_000_000n} USDC.`);
    await expect(page.getByTestId("referee-terms-risk")).toHaveText("This pays out immediately and can't be changed or challenged.");
    expect(await signs(page)).toBe(0);
    await page.getByTestId("referee-confirm-btn").click();
    await expect(page.getByTestId("referee-result")).toContainText("Done. @maker has been paid.");
    expect(relayed).toHaveLength(1);
    expect(relayed[0].method).toBe("referee_rule");
    expect(relayed[0].args).toEqual({ bet_id: 7, outcome: "YES" });
    // The winner opens the bet: the payout screen with the same money as every normal ending.
    w.me = "maker";
    await open(page);
    await expect(page.getByTestId("payout-screen")).toHaveAttribute("data-ending", "won");
    await expect(page.getByTestId("payout-headline")).toHaveText(`You won ${usd(NET)}.`);
    expect(await lines(page)).toEqual(WIN_LINES);
    await expect(page.getByTestId("payout-progress-message")).toHaveText("Paid.");
  });

  test("journey: human referee silent -> deadline refund payout", async ({ page }) => {
    const resolveMs = Math.floor((Date.now() - HOUR) / 60_000) * 60_000;
    const w = world({ me: "referee", referee: true, status: "Taken", resolveMs });
    await setup(page, w, () => { throw new Error("the referee never acts: no relayed call expected"); });
    await open(page);
    await expect(page.getByTestId("referee-state")).toHaveAttribute("data-state", "closed");
    await expect(page.getByTestId("referee-state")).toHaveText("The ruling window closed with no ruling. Both bettors get their stakes back; the refund is sent automatically.");
    await expect(page.getByTestId("referee-btn-YES")).toHaveCount(0);
    // Nobody ruled by the deadline: the chain refunds both (void_after_deadline), outcome VOID with no proposal.
    w.status = "Voided"; w.outcome = "VOID"; w.me = "maker";
    await open(page);
    await expect(page.getByTestId("payout-screen")).toHaveAttribute("data-ending", "deadline");
    await expect(page.getByTestId("payout-headline")).toHaveText("@ref didn't decide in time. Both sides were refunded."); // B1: @username, relative; the exact deadline is under Details
    expect(await lines(page)).toEqual([REFUND]);
    await expect(page.getByTestId("payout-progress-message")).toHaveText("Paid.");
  });

  test("journey: emergency shutdown -> emergency_refund -> refund payout", async ({ page }) => {
    const w = world({ me: "taker", status: "Challenged", down: true, ruled: true, outcome: "YES", bonds: 1 });
    const relayed = await setup(page, w, (x, d) => { if (d.method === "emergency_refund") { x.status = "Voided"; x.outcome = null; x.ruled = false; } });
    await open(page);
    await expect(page.getByTestId("payout-screen")).toHaveCount(0);
    await expect(page.getByTestId("emergency-refund-btn")).toBeEnabled();
    await page.getByTestId("emergency-refund-btn").click();
    await expect(page.getByTestId("payout-screen")).toHaveAttribute("data-ending", "emergency", { timeout: 20_000 });
    expect(relayed.map((r) => r.method)).toEqual(["emergency_refund"]);
    expect(relayed[0].args).toEqual({ bet_id: 7 });
    await expect(page.getByTestId("payout-headline")).toHaveText("The app was shut down. You got your own deposits back.");
    expect(await lines(page)).toEqual(["No fee was charged.", REFUND]);
    await expect(page.getByTestId("payout-progress-message")).toHaveText("Paid.");
  });
});
