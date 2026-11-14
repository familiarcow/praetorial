// FE12 (S14): the human referee screen. Fully mocked: NEAR RPC views, relayer POST /relay, wallet seam. No real Privy login; no testnet write.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { mockUsernames } from "./lib/betPage";
import { SCHEMA } from "@near-js/transactions";
import * as borsh from "borsh";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const RELAYER = "http://localhost:8788";
const USDC = "nep141:usdc.testnet";
const HOUR = 3_600_000;

interface World { me: "referee" | "maker" | "taker" | "stranger"; status: string; outcome: string | null; fundMs: number; resolveMs: number; relays: number }
const world = (o: Partial<World> = {}): World => ({ me: "referee", status: "Taken", outcome: null, fundMs: Date.now() - HOUR, resolveMs: Date.now() + 48 * HOUR, relays: 0, ...o });
const betJson = (w: World) => ({
  envelope: { bet_id: 7, version: 1, maker: w.me === "maker" ? WALLET : "maker.testnet", taker_allow: "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "cd".repeat(32), terms: JSON.stringify({ claim: "Team A wins" }), outcomes: ["YES", "NO"], maker_side: "YES",
    maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: "10000000", taker_options: [], fee_bps: 100, funding_deadline: w.fundMs * 1e6, resolve_deadline: w.resolveMs * 1e6, settlement_period: 0,
    referee: { account: w.me === "referee" ? WALLET : "ref.testnet", mode: "Human" }, tip_maker: false },
  status: w.status, taker: w.me === "taker" ? WALLET : "taker.testnet", created_at: 0, taken_at: null, proposed_at: null, outcome: w.outcome, reserve_remaining: "0",
  bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0, fee_min_maker: "500000", fee_min_taker: "500000", tip_maker: "0", tip_taker: "0", last_resolution_raw: null,
});

async function setup(page: Page, w: World, onRelay?: (w: World, d: { receiver: string; method: string; args: any }) => void, relayReply?: (n: number) => object) {
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
        case "mt_balance_of": r = "0"; break;
        case "required_challenge_bond": r = null; break;
        case "get_bet": r = betJson(w); break;
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
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(relayReply ? relayReply(w.relays) : { ok: true, txHash: `TX${w.relays}` }) });
  });
  return relayed;
}
function decodeRelayed(body: any) {
  const sd: any = borsh.deserialize(SCHEMA.SignedDelegate as any, Buffer.from(body.signedDelegate, "base64"));
  const fc = sd.delegateAction.actions[0].functionCall;
  return { receiver: sd.delegateAction.receiverId as string, gasTgas: Number(BigInt(fc.gas) / 1_000_000_000_000n), method: fc.methodName as string, args: JSON.parse(Buffer.from(fc.args).toString("utf8")) };
}
const open = async (page: Page) => { await page.goto("/bet/7"); await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 }); };
const signs = (page: Page) => page.evaluate(() => (window as any).__signs ?? 0);

test.describe("FE12 human referee screen", () => {
  test("referee rules YES: confirm names who gets paid, one signature, referee_rule(bet_id, outcome), then Done", async ({ page }) => {
    const w = world();
    const relayed = await setup(page, w, (x, d) => { if (d.method === "referee_rule") { x.status = "Finalized"; x.outcome = d.args.outcome; } });
    await open(page);
    await expect(page.getByTestId("referee-banner")).toContainText("You're the referee for this bet");
    await expect(page.getByTestId("referee-deadline")).toContainText("You can rule any time until");
    await expect(page.getByTestId("referee-btn-YES")).toBeVisible();
    await expect(page.getByTestId("referee-btn-NO")).toBeVisible();
    await expect(page.getByTestId("referee-btn-VOID")).toHaveText("VOID — refund both");
    await expect(page.getByTestId("challenge-btn")).toHaveCount(0);
    await page.getByTestId("referee-btn-YES").click();
    // M1 (PEOPLE RULE): no registry name for the maker here -> "Unnamed account", never the id; the risk is the sheet's last line.
    await expect(page.getByTestId("referee-confirm-text")).toHaveText("You're ruling YES: Unnamed account wins 19 USDC.");
    await expect(page.getByTestId("referee-terms-risk")).toHaveText("This pays out immediately and can't be changed or challenged.");
    expect(await signs(page)).toBe(0); // nothing signed until the confirm
    await page.getByTestId("referee-confirm-btn").click();
    await expect(page.getByTestId("referee-result")).toContainText("Done. Unnamed account has been paid.");
    expect(await signs(page)).toBe(1);
    expect(relayed).toHaveLength(1);
    expect(relayed[0].method).toBe("referee_rule");
    expect(relayed[0].args).toEqual({ bet_id: 7, outcome: "YES" });
    expect(relayed[0].gasTgas).toBe(300); // REFGAS1: lib/relayGas.ts table (referee_rule fans out payouts)
    await expect(page.getByTestId("referee-btn-YES")).toHaveCount(0);
  });

  test("REFGAS1: a ruling that reached the chain and failed says the contract refused it, not 'Nothing was sent'", async ({ page }) => {
    const w = world();
    await setup(page, w, undefined, () => ({ ok: false, txHash: "TXFAIL", receiptFailure: "Smart contract panicked: only the named referee may rule", error: "transaction failed on chain: Smart contract panicked: only the named referee may rule" }));
    await open(page);
    await page.getByTestId("referee-btn-NO").click();
    await page.getByTestId("referee-confirm-btn").click();
    await expect(page.getByTestId("referee-result")).toHaveText("The contract refused this: only the named referee may rule. No money moved.");
    await expect(page.getByTestId("referee-result")).not.toContainText("Nothing was sent");
  });

  test("cancelling the confirm signs and sends nothing", async ({ page }) => {
    const w = world();
    await setup(page, w);
    await open(page);
    await page.getByTestId("referee-btn-NO").click();
    await expect(page.getByTestId("referee-confirm-text")).toContainText("You're ruling NO: Unnamed account wins"); // M1: never the raw id
    await page.getByTestId("referee-cancel-btn").click();
    await expect(page.getByTestId("referee-confirm-text")).toHaveCount(0);
    expect(await signs(page)).toBe(0);
    expect(w.relays).toBe(0);
  });

  test("too early: 'You can rule from <time>', no rule buttons", async ({ page }) => {
    await setup(page, world({ fundMs: Date.now() + 5 * HOUR }));
    await open(page);
    await expect(page.getByTestId("referee-state")).toHaveAttribute("data-state", "early");
    await expect(page.getByTestId("referee-state")).toContainText("You can rule from ");
    await expect(page.getByTestId("referee-btn-YES")).toHaveCount(0);
  });

  test("after the resolve deadline: window closed, no rule buttons", async ({ page }) => {
    await setup(page, world({ fundMs: Date.now() - 48 * HOUR, resolveMs: Date.now() - HOUR }));
    await open(page);
    await expect(page.getByTestId("referee-state")).toHaveAttribute("data-state", "closed");
    await expect(page.getByTestId("referee-state")).toHaveText("The ruling window closed with no ruling. Both bettors get their stakes back; the refund is sent automatically.");
    await expect(page.getByTestId("referee-btn-YES")).toHaveCount(0);
  });

  test("a ruling the contract did not take is reported honestly, not as success", async ({ page }) => {
    const w = world();
    await setup(page, w); // relay returns ok but the bet never changes
    await open(page);
    await page.getByTestId("referee-btn-VOID").click();
    await expect(page.getByTestId("referee-confirm-text")).toContainText("both bettors get their stake back");
    await page.getByTestId("referee-confirm-btn").click();
    await expect(page.getByTestId("referee-result")).toContainText("can't see it on the bet yet");
    await expect(page.getByTestId("referee-result")).not.toContainText("Done.");
  });

  test("bettors see the waiting view and no challenge or rule buttons (UX-19/UX-20)", async ({ page }) => {
    const w = world(); // FE10g: one setup; the mock reads w per request, so switching `me` needs no unrouteAll/re-route gap
    await mockUsernames(page);
    await setup(page, w);
    for (const me of ["maker", "taker"] as const) {
      w.me = me;
      await open(page);
      // B1: the referee by @username in the header sentence; the deadline relative (exact under Details -> Money & deadlines)
      await expect(page.getByTestId("bet-sentence")).toHaveText("Waiting for @ref to decide.");
      await expect(page.getByTestId("referee-waiting")).toContainText("They have until the deadline to decide (due in");
      await expect(page.getByTestId("challenge-btn")).toHaveCount(0);
      await expect(page.getByTestId("referee-btn-YES")).toHaveCount(0);
      await expect(page.getByTestId("referee-banner")).toHaveCount(0);
    }
  });

  test("a non-referee stranger sees no rule buttons and no banner", async ({ page }) => {
    await setup(page, world({ me: "stranger" }));
    await open(page);
    for (const t of ["referee-btn-YES", "referee-btn-NO", "referee-btn-VOID", "referee-banner", "referee-waiting"]) await expect(page.getByTestId(t)).toHaveCount(0);
  });
});
