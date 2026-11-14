// FE11 (S13): AI ruling card + challenge rounds + finalize. Fully mocked: NEAR RPC views, relayer POST /relay, wallet seam. No real Privy login; no testnet write.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { mockUsernames } from "./lib/betPage";
import { SCHEMA } from "@near-js/transactions";
import * as borsh from "borsh";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const RELAYER = "http://localhost:8788";
const USDC = "nep141:usdc.testnet";
const DAY = 86_400_000_000_000;
const TERMS = JSON.stringify({ claim: "BTC closes above 100k", sources_allowed: [{ id: "S_CB", publisher: "Coinbase BTC-USD", url: "https://coinbase.example/btc" }] });
const RAW = JSON.stringify({ judge: { run_diagnostics: [{ model: "m1", content_head: JSON.stringify({ answer: "met", quote: "BTC-USD close 101250.10", source_id: "S_CB", reason: "above" }) }] } });

interface World { me: "maker" | "taker"; status: string; outcome: string | null; bonds: number; ageNs: number; balance: string; relays: number; getBets: number }
const world = (o: Partial<World> = {}): World => ({ me: "taker", status: "Proposed", outcome: "YES", bonds: 0, ageNs: 60_000_000_000, balance: "1" + "0".repeat(20), relays: 0, getBets: 0, ...o });
const betJson = (w: World) => ({
  envelope: { bet_id: 7, version: 1, maker: w.me === "maker" ? WALLET : "maker.testnet", taker_allow: "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "cd".repeat(32), terms: TERMS, outcomes: ["YES", "NO"], maker_side: "YES",
    maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: "10000000", taker_options: [], fee_bps: 100, funding_deadline: Date.UTC(2037, 0, 2) * 1e6, resolve_deadline: Date.UTC(2037, 0, 5) * 1e6, settlement_period: DAY, referee: null },
  status: w.status, taker: w.me === "taker" ? WALLET : "taker.testnet", created_at: 0, taken_at: null, proposed_at: Date.now() * 1_000_000 - w.ageNs, outcome: w.outcome, reserve_remaining: "0",
  bonds: Array.from({ length: w.bonds }, (_, i) => ({ holder: "x", amount: "1", round: i + 1, pre_challenge_outcome: "YES", asset: USDC })), exhibits: [], challenged_by: null, window_extension_ns: 0, fee_min_taker: "500000", last_resolution_raw: RAW,
});
const BOND = ["4000000", "8000000"];

async function setup(page: Page, w: World, onRelay?: (w: World, d: { receiver: string; method: string; args: any }) => void) {
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
        case "is_shutdown": r = false; break;
        case "open_offers": r = []; break;
        case "asset_limit": r = { storage_per_kib: "457" }; break;
        case "mt_balance_of": r = w.balance; break;
        case "required_challenge_bond": r = w.bonds >= 2 ? null : { amount: BOND[w.bonds], asset: USDC }; break;
        case "get_bet": w.getBets++; r = betJson(w); break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  const relayed: any[] = [];
  await page.route(`${RELAYER}/relay`, (r) => {
    w.relays++;
    const body = JSON.parse(r.request().postData() ?? "{}");
    const d = decodeRelayed(body);
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
const open = async (page: Page) => { await mockUsernames(page); await page.goto("/bet/7"); await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 }); };
const signs = (page: Page) => page.evaluate(() => (window as any).__signs ?? 0);

test.describe("FE11 AI ruling and challenge", () => {
  test("ruling card shows the ruling, the quote with its source, and when it becomes final", async ({ page }) => {
    await setup(page, world({ me: "maker" }));
    await open(page);
    await expect(page.getByTestId("ruling-headline")).toContainText("Ruling: YES");
    // B1 (familiarcow UX-37 #6): dates are relative on screen, the exact time stays on the <time> (local + UTC on tap).
    await expect(page.getByTestId("ruling-final")).toHaveText(/^Becomes final in \d+ h unless someone challenges\.$/);
    await expect(page.getByTestId("ruling-final").locator("time")).toHaveAttribute("datetime", /^\d{4}-\d\d-\d\dT\d\d:\d\d/);
    await expect(page.getByTestId("ruling-quote-0")).toContainText("BTC-USD close 101250.10");
    await expect(page.getByTestId("ruling-source-0")).toContainText("Coinbase BTC-USD");
    await expect(page.getByTestId("ruling-source-0")).toHaveAttribute("href", "https://coinbase.example/btc");
    await expect(page.getByTestId("challenge-btn")).toHaveCount(0); // the maker's side won
  });

  test("YES ruling -> challenge (bond from the contract view, one signature) -> round 2 -> no more appeals -> finalize", async ({ page }) => {
    const w = world();
    const relayed = await setup(page, w, (x, d) => {
      if (d.method === "mt_transfer_call") x.bonds++, (x.status = "Challenged");
      if (d.method === "finalize") x.status = "Finalized";
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
    expect(relayed[0].args.token_id).toBe(USDC);
    expect(JSON.parse(relayed[0].args.msg)).toEqual({ kind: "Bond", bet_id: 7, round: 1 });
    // The AI re-rules for the other side; the maker (who now lost) uses the final appeal.
    // LFIX1: the re-judge lands as a new ruling (Proposed, bonds kept); "Evidence" is the state BEFORE it, where a bond is SM1 CON-5.
    w.status = "Proposed"; w.outcome = "NO"; w.me = "maker"; w.ageNs = 60_000_000_000;
    await open(page);
    await expect(page.getByTestId("challenge-round")).toHaveText("Last challenge: there is no appeal after this one"); // B1: plain words (UX-37)
    await expect(page.getByTestId("challenge-bond-line")).toContainText("8 USDC");
    await page.getByTestId("challenge-btn").click();
    await page.getByTestId("challenge-confirm").click(); // MODAL1c3: the bond is shown in a modal first
    await expect(page.getByTestId("challenge-result")).toContainText("Your challenge is in");
    expect(JSON.parse(relayed[1].args.msg)).toEqual({ kind: "Bond", bet_id: 7, round: 2 });
    // After round 2 no further challenge; once the window closes anyone can finalize.
    w.status = "Proposed"; w.outcome = "YES"; w.me = "taker"; w.ageNs = 2 * DAY;
    await open(page);
    await expect(page.getByTestId("no-more-appeals")).toHaveText("There are no more challenges left on this bet."); // B1: plain words (UX-37)
    await expect(page.getByTestId("challenge-btn")).toHaveCount(0);
    await page.getByTestId("finalize-btn").click();
    // B1: the old one-line "settled, X is being paid" is the payout card now (who was paid, by @username)
    await expect(page.getByTestId("payout-screen")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("payout-lines")).toContainText("@maker was paid.");
    expect(relayed[2].method).toBe("finalize");
    expect(relayed[2].args).toEqual({ bet_id: 7 });
  });

  test("LFIX1 CON-5: evidence filed on round 1 (Evidence, not re-judged yet): no second bond is offered to either side", async ({ page }) => {
    for (const me of ["taker", "maker"] as const) {
      await setup(page, world({ me, status: "Evidence", outcome: "VOID", bonds: 1 })); // VOID: either side could otherwise challenge
      await open(page);
      await expect(page.getByTestId("bet-sentence")).toContainText("The AI looks again");
      await expect(page.getByTestId("challenge-btn")).toHaveCount(0);
      await expect(page.getByTestId("challenge-section")).toHaveCount(0);
    }
  });

  test("VOID ruling: plain copy, no winner implied, either side can challenge", async ({ page }) => {
    await setup(page, world({ outcome: "VOID:source_conflict" }));
    await open(page);
    await expect(page.getByTestId("ruling-headline")).toContainText("Ruling: VOID");
    await expect(page.getByTestId("ruling-body")).toHaveText("The AI couldn't settle this fairly. You'll both get your money back.");
    await expect(page.getByTestId("ruling-card")).not.toContainText(/\b(win|wins|won|winner|lost|loser)\b/i);
    await expect(page.getByTestId("challenge-btn")).toBeVisible();
  });

  test("bond too low: balance below the quoted bond is refused before anything is signed or sent", async ({ page }) => {
    const w = world({ balance: "3999999" });
    await setup(page, w);
    await open(page);
    await page.getByTestId("challenge-btn").click();
    await page.getByTestId("challenge-confirm").click(); // MODAL1c3: the bond is shown in a modal first
    // M1 (SM2 B1-9): the shortfall is gate("challenge", {short}): exact missing amount + Add money, confirm off, sheet stays open.
    await expect(page.getByTestId("challenge-gate")).toHaveAttribute("data-gate", "short");
    await expect(page.getByTestId("challenge-gate")).toContainText("You need < 0.01 USDC more in your betting balance to do this.");
    await expect(page.getByTestId("challenge-confirm")).toBeDisabled();
    expect(await signs(page)).toBe(0);
    expect(w.relays).toBe(0);
  });

  test("a challenge the contract did not accept is reported honestly, not as success", async ({ page }) => {
    const w = world();
    await setup(page, w, (x) => { x.status = "Finalized"; });
    await open(page);
    await page.getByTestId("challenge-btn").click();
    await page.getByTestId("challenge-confirm").click(); // MODAL1c3: the bond is shown in a modal first
    await expect(page.getByTestId("challenge-refusal")).toContainText("didn't go through");
    await expect(page.getByTestId("challenge-result")).toHaveCount(0);
  });

  test("closed window: no challenge button, says so", async ({ page }) => {
    await setup(page, world({ ageNs: 2 * DAY }));
    await open(page);
    await expect(page.getByTestId("challenge-closed")).toHaveText("The challenge window has closed."); // B1: plain words (UX-37)
    await expect(page.getByTestId("challenge-btn")).toHaveCount(0);
  });
});
