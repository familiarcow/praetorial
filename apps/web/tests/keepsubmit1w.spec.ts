// KEEPSUBMIT1W: "Apply the judge's ruling" on a Resolving bet whose stored result is signed. Fully mocked: NEAR RPC views, relayer POST /relay, wallet seam.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { SCHEMA } from "@near-js/transactions";
import * as borsh from "borsh";
import { screenPath } from "./lib/screens";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const RELAYER = "http://localhost:8788";
const USDC = "nep141:usdc.testnet";
const HOUR = 3_600_000;
const TERMS = "ab".repeat(32);
const SIG = "9f".repeat(64);

interface World { status: string; raw: string | ((contract: string) => string) | null; escrow?: string; pending: number | null; relays: number }
const signedRaw = (contract: string, runNo = 3) => `{"contract":"${contract}","judge":{"backend":"near-ai"},"notes":[],"result":{"bet_id":7,"checked_until":1783000000123456789,"element_results_hash":"${"ee".repeat(32)}","judge_pair_index":0,"outcome":"YES","run_no":${runNo},"terms_hash":"${TERMS}"},"signing":{"pubkey_hex":"${"11".repeat(32)}","signature_hex":"${SIG}"}}`;
const NOKEY = `{"error":"no_live_judge_key","reason":"NEAR_AI_API_KEY is not set","judge":{"judge_ran":false}}`;
const betJson = (w: World) => ({
  envelope: { bet_id: 7, version: 1, maker: "maker.testnet", taker_allow: "Any", terms_hash: TERMS, models_snapshot_hash: "cd".repeat(32), terms: JSON.stringify({ claim: "Team A wins" }), outcomes: ["YES", "NO"], maker_side: "YES",
    maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: "10000000", taker_options: [], fee_bps: 100, funding_deadline: (Date.now() - HOUR) * 1e6, resolve_deadline: (Date.now() + 48 * HOUR) * 1e6, settlement_period: 0,
    referee: { account: "ref.testnet", mode: "Ai" }, tip_maker: false },
  status: w.status, taker: WALLET, created_at: 0, taken_at: 0, proposed_at: null, outcome: null, reserve_remaining: "0", used_run_nos: [], pending_run_no: w.pending,
  bonds: [], exhibits: [], challenged_by: null, window_extension_ns: 0, fee_min_maker: "500000", fee_min_taker: "500000", tip_maker: "0", tip_taker: "0", last_resolution_raw: typeof w.raw === "function" ? w.raw(w.escrow ?? "") : w.raw,
});

async function setup(page: Page, w: World, relayReply: (n: number) => object = (n) => ({ ok: true, txHash: `TX${n}` })) {
  await page.addInitScript((address) => {
    (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => { (window as any).__signs = ((window as any).__signs ?? 0) + 1; return "22".repeat(64); } };
    (window as any).__e2eConfirm = { delayMs: 50, attempts: 4 };
  }, WALLET);
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      let r: unknown = null;
      if (params.method_name === "get_bet") w.escrow = params.account_id;
      switch (params.method_name) {
        case "is_paused": case "is_shutdown": r = false; break;
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
    const sd: any = borsh.deserialize(SCHEMA.SignedDelegate as any, Buffer.from(JSON.parse(r.request().postData() ?? "{}").signedDelegate, "base64"));
    const fc = sd.delegateAction.actions[0].functionCall;
    relayed.push({ receiver: sd.delegateAction.receiverId, method: fc.methodName, deposit: String(fc.deposit), gasTgas: Number(BigInt(fc.gas) / 1_000_000_000_000n), argsText: Buffer.from(fc.args).toString("utf8"), args: JSON.parse(Buffer.from(fc.args).toString("utf8")) });
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(relayReply(w.relays)) });
  });
  return relayed;
}
const open = async (page: Page) => { await page.goto("/bet/7"); await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 }); await expect(page.getByTestId("bet-page")).toBeVisible(); }; // B1: the raw status is a hidden span; bet-page renders only once the bet loaded
// The stored raw's `contract` field is filled from the account the page's own get_bet view targets (the app's configured escrow).

test.describe("KEEPSUBMIT1W apply the judge's ruling", () => {
  test("signed result for the pending run while Resolving: button shows; one click sends exactly one submit_outcome with the stored result + signature; bet refreshes", async ({ page }) => {
    const w: World = { status: "Resolving", raw: null, pending: 3, relays: 0 };
    w.raw = (c) => signedRaw(c);
    const relayed = await setup(page, w);
    await open(page);
    const btn = page.getByTestId("apply-ruling");
    await expect(btn).toHaveText("Apply the AI judge's ruling"); // B1 (familiarcow 2026-11-11): "judge" only ever means the AI judge, and says so
    for (const [x, h, n] of [[1280, 900, "1280"], [375, 800, "375"]] as const) { await page.setViewportSize({ width: x, height: h }); await page.getByTestId("apply-ruling-section").screenshot({ path: screenPath(`keepsubmit1w/button-${n}.png`) }); }
    await page.setViewportSize({ width: 1280, height: 900 });
    await btn.click();
    await expect.poll(() => relayed.length).toBe(1);
    await page.waitForTimeout(400);
    expect(relayed.length).toBe(1);
    const d = relayed[0];
    expect(d.method).toBe("submit_outcome");
    expect(d.receiver).toBe(w.escrow);
    expect(w.escrow).toBeTruthy();
    expect(d.deposit).toBe("0");
    expect(d.args.signature_hex).toBe(SIG);
    expect(d.args.result).toEqual({ bet_id: 7, checked_until: "1783000000123456789", element_results_hash: "ee".repeat(32), judge_pair_index: 0, outcome: "YES", run_no: 3, terms_hash: TERMS });
    expect(Object.keys(d.args).sort()).toEqual(["result", "signature_hex"]);
    w.status = "Proposed"; w.pending = null;
    await expect(page.getByTestId("apply-ruling")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId("bet-status")).toHaveText("Proposed");
  });

  test("contract refusal shows a plain message and sends nothing more", async ({ page }) => {
    const w: World = { status: "Resolving", raw: null, pending: 3, relays: 0 };
    w.raw = (c) => signedRaw(c);
    const relayed = await setup(page, w, () => ({ ok: false, txHash: "TXBAD", receiptFailure: "Smart contract panicked: run_no does not match the pending resolution request" }));
    await open(page);
    await page.getByTestId("apply-ruling").click();
    const msg = page.getByTestId("apply-ruling-result");
    await expect(msg).toContainText("The contract refused this: run_no does not match the pending resolution request. No money moved.");
    expect(relayed.length).toBe(1);
    await expect(page.getByTestId("apply-ruling")).toBeVisible();
    await page.getByTestId("apply-ruling-section").screenshot({ path: screenPath("keepsubmit1w/refused-1280.png") });
    await page.setViewportSize({ width: 375, height: 800 });
    await page.getByTestId("apply-ruling-section").screenshot({ path: screenPath("keepsubmit1w/refused-375.png") });
  });

  for (const [name, mk] of [
    ["unsigned NOKEY1 error output", () => ({ status: "Resolving", raw: NOKEY, pending: 3 })],
    ["malformed raw", () => ({ status: "Resolving", raw: `{"result":{"bet_id":7,"run_no":3`, pending: 3 })],
    ["run_no mismatch", () => ({ status: "Resolving", raw: (c: string) => signedRaw(c, 2), pending: 3 })],
    ["state Taken", () => ({ status: "Taken", raw: (c: string) => signedRaw(c), pending: 3 })],
    ["state Proposed", () => ({ status: "Proposed", raw: (c: string) => signedRaw(c), pending: 3 })],
  ] as const) {
    test(`hidden: ${name}`, async ({ page }) => {
      const w: World = { ...(mk as any)(), relays: 0 };
      const relayed = await setup(page, w);
      await open(page);
      await expect(page.getByTestId("bet-page")).toBeVisible();
      await page.waitForTimeout(300);
      await expect(page.getByTestId("apply-ruling")).toHaveCount(0);
      expect(relayed.length).toBe(0);
    });
  }
});
