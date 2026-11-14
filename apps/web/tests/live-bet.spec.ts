// FE10 (S12): live bet page: plain status chips, concede with confirm, referee change (maker alone while Open; propose + agree after the take),
// frozen while a ruling is in progress. Fully mocked: NEAR RPC views, relayer POST /relay, wallet seam. Never a real Privy login; no testnet write.
import { type Page } from "@playwright/test"; import { test, expect } from "./e2eGuard";
import { mockUsernames, openMoreActions } from "./lib/betPage";
import { createHash } from "node:crypto";
import { SCHEMA } from "@near-js/transactions";
import * as borsh from "borsh";

const WALLET = "11".repeat(32);
const RPC = "https://test.rpc.fastnear.com";
const RELAYER = "http://localhost:8788";
const USDC = "nep141:usdc.testnet";
const FUND_NS = Date.UTC(2037, 0, 2, 3, 4) * 1_000_000;
const RESOLVE_NS = Date.UTC(2037, 0, 5, 3, 4) * 1_000_000;

interface World {
  me: "maker" | "taker"; proposal: { maker_value: string | null; taker_value: string | null }; onRelay: ((w: World) => void) | null; bonds: number; outcome: string | null;
  relays: number; signs: number; getBets: number;
  status: string; taker: string | null; referee: string | null; stakeTaker: string; termsHash: string;
  takerAllow: any; fundingNs: number; paused: boolean; txLogs: string[] | null;
  terms: string | null; txFail: string | null; scMode: "pass" | "fail"; scCalls: number;
}
const world = (o: Partial<World> = {}): World => ({ me: "maker", proposal: { maker_value: null, taker_value: null }, onRelay: null, bonds: 0, outcome: null,  relays: 0, signs: 0, getBets: 0, status: "Taken", taker: "taker.testnet", referee: "ref.testnet", stakeTaker: "10000000", termsHash: "ab".repeat(32), takerAllow: "Any", fundingNs: FUND_NS, paused: false, txLogs: [], terms: null, txFail: null, scMode: "pass", scCalls: 0, ...o });

const betJson = (w: World) => ({
  envelope: { bet_id: 7, version: 1, maker: w.me === "maker" ? WALLET : "maker.testnet", taker_allow: w.takerAllow, terms_hash: w.terms ? createHash("sha256").update(w.terms).digest("hex") : w.termsHash, models_snapshot_hash: "cd".repeat(32), terms: w.terms, outcomes: ["YES", "NO"], maker_side: "YES",
    maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: w.stakeTaker, taker_options: [], fee_bps: 100, funding_deadline: w.fundingNs, resolve_deadline: RESOLVE_NS, settlement_period: 86_400_000_000_000,
    referee: w.referee ? { account: w.referee, mode: "Human" } : null },
  status: w.status, taker: w.me === "taker" && w.taker ? WALLET : w.taker, referee_proposal: w.proposal, created_at: 0, taken_at: null, proposed_at: w.status === "Proposed" ? Date.now() * 1_000_000 : null, outcome: w.outcome, reserve_remaining: "0", bonds: Array.from({ length: w.bonds }, () => ({ holder: "x", amount: "1", asset: USDC })), exhibits: [], challenged_by: null, window_extension_ns: 0, fee_min_taker: "500000",
});

async function setup(page: Page, w: World, opts: { wallet?: boolean; decline?: boolean } = {}) {
  await page.addInitScript(({ address, wallet, decline }) => {
    if (wallet) (window as any).__e2eTestWallet = { nearAddress: address, signRawHash: async () => { (window as any).__signs = ((window as any).__signs ?? 0) + 1; if (decline) throw new Error("User rejected the request"); return "22".repeat(64); } };
    (window as any).__e2eConfirm = { delayMs: 50, attempts: 4 };
    (window as any).__e2eRegistryUrl = ""; // WEBREG1: extra browser.newContext() pages bypass e2eGuard; registry off (testnet default is the live Worker)
  }, { address: WALLET, wallet: opts.wallet !== false, decline: !!opts.decline });
  await page.route(RPC, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const params = body.params ?? {};
    const reply = (obj: object) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", ...obj }) });
    const ok = (result: unknown) => reply({ result });
    if (body.method === "block") return ok({ header: { height: 100 } });
    if (body.method === "tx" || body.method === "EXPERIMENTAL_tx_status") {
      if (w.txLogs === null) return reply({ error: { name: "UNKNOWN_TRANSACTION", cause: { name: "UNKNOWN_TRANSACTION" } } });
      // a relayed call: the outer transaction succeeds, the contract call's own receipt carries the failure
      if (w.txFail) return ok({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { logs: [], status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${w.txFail}` } } } } } } }] });
      return ok({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { logs: w.txLogs } }] });
    }
    if (params.request_type === "view_access_key") return ok({ nonce: 1 });
    if (params.request_type === "view_account") return ok({ amount: "1000000000000000000000000" });
    if (params.request_type === "call_function") {
      const args = JSON.parse(Buffer.from(params.args_base64 ?? "e30=", "base64").toString("utf8") || "{}");
      let r: unknown = null;
      switch (params.method_name) {
        case "is_paused": r = w.paused; break;
        case "is_shutdown": r = false; break;
        case "open_offers": r = []; break;
        case "asset_limit": r = { storage_per_kib: "457" }; break;
        case "mt_balance_of": r = "1" + "0".repeat(20); break;
        case "required_challenge_bond": r = null; break;
        case "get_bet": w.getBets++; r = args.bet_id === 7 ? betJson(w) : null; break;
      }
      return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
    }
    return ok({});
  });
  const relayed: any[] = [];
  await page.route(`${RELAYER}/relay`, (r) => {
    w.relays++;
    relayed.push(JSON.parse(r.request().postData() ?? "{}"));
    w.onRelay?.(w);
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, txHash: `TX${w.relays}` }) });
  });
  await page.route("http://localhost:8790/sourcecheck", async (route) => {
    const cors = { "access-control-allow-origin": "*" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-headers": "*" } });
    w.scCalls++;
    const { terms } = JSON.parse(route.request().postData() ?? "{}");
    const spec_hash = createHash("sha256").update(terms).digest("hex");
    if (w.scMode === "fail") return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ ok: false, spec_hash, checked_at: String(Date.now() * 1_000_000), unreachable: [{ id: "S1", reason: "HTTP 403 (non-2xx)" }] }) });
    return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ ok: true, spec_hash, checked_at: String(Date.now() * 1_000_000), unreachable: [], signing: { signature_hex: "33".repeat(64) } }) });
  });
  return relayed;
}
/** The relayed delegate action, decoded: the exact method, args and deposit the page asked the relayer to send. */
function decodeRelayed(body: any) {
  const sd: any = borsh.deserialize(SCHEMA.SignedDelegate as any, Buffer.from(body.signedDelegate, "base64"));
  const fc = sd.delegateAction.actions[0].functionCall;
  return { receiver: sd.delegateAction.receiverId as string, method: fc.methodName as string, args: JSON.parse(Buffer.from(fc.args).toString("utf8")), deposit: String(fc.deposit) };
}
// B1 (UX-37 #4): concede and "change who decides" are under the collapsed More actions; open it whenever the page has one.
const open = async (page: Page, path = "/bet/7") => {
  await mockUsernames(page); // B1: people are @usernames (registered last so the spec's catch-all route doesn't shadow it)
  await page.goto(path);
  await page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
  await page.getByTestId("bet-chip").or(page.getByTestId("login-gate")).first().waitFor();
  if (await page.getByTestId("more-actions").count()) await openMoreActions(page);
};
const signs = (page: Page) => page.evaluate(() => (window as any).__signs ?? 0);

const NEW_REF = "newref.testnet";
const refValue = (a: string) => JSON.stringify({ account: a, mode: "Human" });

test.describe("FE10 live bet page", () => {
  test("status chip + plain sentence for a taken bet, naming the referee", async ({ page }) => {
    await setup(page, world());
    await open(page);
    await expect(page.getByTestId("bet-chip")).toHaveAttribute("data-chip", "live");
    await expect(page.getByTestId("bet-chip")).toContainText("Live");
    await expect(page.getByTestId("bet-sentence")).toContainText("@ref"); // B1: @username
  });

  test("status chip: a ruling in progress reads as a ruling, not a status code", async ({ page }) => {
    // B1: a realistic AI ruling (the chain sets proposed_at with Proposed; an AI-decided bet has no human referee)
    await setup(page, world({ status: "Proposed", referee: null, outcome: "YES" }));
    await open(page);
    await expect(page.getByTestId("bet-chip")).toHaveAttribute("data-chip", "ruling");
    await expect(page.getByTestId("bet-chip")).not.toContainText("Proposed");
  });

  test("concede: confirm text, one signature, success only after get_bet shows the bet decided for the other side", async ({ page }) => {
    const w = world({ onRelay: (x) => { x.status = "Finalized"; x.outcome = "NO"; } });
    await setup(page, w);
    await open(page);
    await page.getByTestId("concede-btn").click();
    // MODAL1c3: the confirm text moved from window.confirm into the modal (same words: who is paid, cannot be undone)
    await expect(page.getByTestId("concede-terms")).toContainText("cannot be undone");
    await expect(page.getByTestId("concede-terms")).toContainText("@taker is paid"); // M1 (PEOPLE RULE): @username, never the raw id
    await expect(page.getByTestId("concede-terms")).not.toContainText("taker.testnet");
    await page.getByTestId("concede-confirm").click();
    await expect(page.getByTestId("concede-result")).toHaveAttribute("data-kind", "conceded", { timeout: 20_000 });
    await expect(page.getByTestId("concede-result")).toContainText("You conceded");
    expect(w.relays).toBe(1);
    expect(await signs(page)).toBe(1);
  });

  test("concede: the success message stays after the page re-reads the bet as decided (FE10c)", async ({ page }) => {
    const w = world({ onRelay: (x) => { x.status = "Finalized"; x.outcome = "NO"; } });
    await setup(page, w);
    await open(page);
    await page.getByTestId("concede-btn").click();
    await page.getByTestId("concede-confirm").click(); // MODAL1c3: confirm moved from window.confirm into the modal
    // The Concede section is only offered while the bet is live; once the refresh shows it decided the button is gone.
    await expect(page.getByTestId("concede-btn")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId("concede-result")).toHaveAttribute("data-kind", "conceded");
    await expect(page.getByTestId("concede-result")).toContainText("You conceded");
  });

  test("concede: cancelling the confirm signs and sends nothing", async ({ page }) => {
    const w = world();
    await setup(page, w);
    await open(page);
    await page.getByTestId("concede-btn").click();
    await page.getByTestId("concede-cancel").click(); // MODAL1c3: Cancel in the modal replaces dismissing window.confirm
    await expect(page.getByTestId("concede-result")).toHaveCount(0);
    expect(w.relays).toBe(0);
    expect(await signs(page)).toBe(0);
  });

  test("concede: sent but the contract refused -> no success shown, plain 'still confirming' line", async ({ page }) => {
    const w = world();
    await setup(page, w);
    await open(page);
    await page.getByTestId("concede-btn").click();
    await page.getByTestId("concede-confirm").click(); // MODAL1c3: confirm moved from window.confirm into the modal
    await expect(page.getByTestId("concede-result")).toHaveAttribute("data-kind", "pending", { timeout: 20_000 });
    await expect(page.getByTestId("concede-result")).not.toContainText("You conceded");
  });

  test("a referee change already proposed on-chain is shown read-only with who still has to agree", async ({ page }) => {
    await setup(page, world({ proposal: { maker_value: refValue(NEW_REF), taker_value: null } }));
    await open(page);
    await expect(page.getByTestId("referee-pending")).toContainText("@newref"); // B1: @username
    await expect(page.getByTestId("referee-pending")).toContainText("waiting for @taker"); // B1: @username
    await expect(page.getByTestId("bet-sentence")).toContainText("@ref"); // B1: @username
  });

  test("frozen while a ruling is in progress: no change form, plain reason; concede stays available", async ({ page }) => {
    const w = world({ status: "Resolving" });
    await setup(page, w);
    await open(page);
    await expect(page.getByTestId("referee-change-frozen")).toContainText("ruling");
    await expect(page.getByTestId("concede-btn")).toBeVisible();
    expect(w.relays).toBe(0);
  });

  test("frozen once a dispute opened (a challenge bond is posted), even in Taken", async ({ page }) => {
    await setup(page, world({ bonds: 1 }));
    await open(page);
    await expect(page.getByTestId("referee-change-frozen")).toBeVisible();
  });

  test("switch-to-AI is not offered when the bet carries no terms text (hash-only) (FE10b)", async ({ page }) => {
    await setup(page, world());
    await open(page);
    await expect(page.getByTestId("switch-to-ai")).toHaveCount(0);
  });

  test("referee change after the take: maker proposes, shows waiting; taker agrees; new referee shown only after get_bet", async ({ page, browser }) => {
    const w = world({ onRelay: (x) => { x.proposal = { maker_value: refValue(NEW_REF), taker_value: null }; } });
    const relayed = await setup(page, w);
    await open(page);
    await expect(page.getByTestId("referee-change-section")).toBeVisible();
    await page.getByTestId("referee-change-input").fill(NEW_REF);
    await page.getByTestId("referee-change-submit").click();
    await page.getByTestId("referee-change-confirm").click(); // MODAL1c4: the send is confirmed in a modal now
    await expect(page.getByTestId("referee-change-result")).toHaveAttribute("data-kind", "proposed", { timeout: 20_000 });
    await expect(page.getByTestId("referee-pending")).toContainText("waiting for @taker"); // B1: @username
    await expect(page.getByTestId("bet-sentence")).toContainText("@ref"); // B1: @username
    expect(w.relays).toBe(1);
    const d = decodeRelayed(relayed[0]);
    expect(d.method).toBe("amend_referee");
    expect(d.deposit).toBe("0");
    expect(d.args).toEqual({ bet_id: 7, new_referee_json: refValue(NEW_REF) });
    expect(Object.keys(d.args).sort()).toEqual(["bet_id", "new_referee_json"]);

    // the taker's own session sees the maker's proposal and agrees with the very same text
    const ctx = await browser.newContext();
    const p2 = await ctx.newPage();
    const w2 = world({ me: "taker", proposal: { maker_value: refValue(NEW_REF), taker_value: null }, onRelay: (x) => { x.proposal = { maker_value: null, taker_value: null }; x.referee = NEW_REF; } });
    const relayed2 = await setup(p2, w2);
    await open(p2);
    await expect(p2.getByTestId("referee-pending")).toContainText("@newref"); // B1: @username
    await p2.getByTestId("referee-agree-btn").click();
    await p2.getByTestId("referee-change-confirm").click(); // MODAL1c4: the send is confirmed in a modal now
    await expect(p2.getByTestId("referee-change-result")).toHaveAttribute("data-kind", "changed", { timeout: 20_000 });
    await expect(p2.getByTestId("bet-sentence")).toContainText("@newref"); // B1: @username
    // FE10c-style: the result stays after the page re-read the bet (the pending line is gone by then)
    await expect(p2.getByTestId("referee-pending")).toHaveCount(0);
    await expect(p2.getByTestId("referee-change-result")).toBeVisible();
    expect(w2.relays).toBe(1);
    const d2 = decodeRelayed(relayed2[0]);
    expect({ m: d2.method, dep: d2.deposit, a: d2.args }).toEqual({ m: "amend_referee", dep: "0", a: { bet_id: 7, new_referee_json: refValue(NEW_REF) } });
    await ctx.close();
  });

  test("taker declines: nothing is signed or sent, the prompt is dismissed, the taker can counter-propose", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const w = world({ me: "taker", proposal: { maker_value: refValue(NEW_REF), taker_value: null }, onRelay: (x) => { x.proposal = { maker_value: refValue(NEW_REF), taker_value: refValue("other.testnet") }; } });
    const relayed = await setup(page, w);
    await open(page);
    await page.getByTestId("referee-decline-btn").click();
    await expect(page.getByTestId("referee-agree-btn")).toHaveCount(0);
    await expect(page.getByTestId("referee-change-declined")).toContainText("nothing was sent");
    expect(w.relays).toBe(0);
    expect(await signs(page)).toBe(0);
    await page.getByTestId("referee-change-input").fill("other.testnet");
    await page.getByTestId("referee-change-submit").click();
    await page.getByTestId("referee-change-confirm").click(); // MODAL1c4: the send is confirmed in a modal now
    await expect(page.getByTestId("referee-change-result")).toHaveAttribute("data-kind", "proposed", { timeout: 20_000 });
    expect(decodeRelayed(relayed[0]).args).toEqual({ bet_id: 7, new_referee_json: refValue("other.testnet") });
    await ctx.close();
  });

  test("referee change: cannot name the maker, the taker or yourself-as-referee; nothing is sent", async ({ page }) => {
    const w = world();
    await setup(page, w);
    await open(page);
    await page.getByTestId("referee-change-input").fill("taker.testnet");
    await expect(page.getByTestId("referee-change-problem")).toContainText("taker");
    await expect(page.getByTestId("referee-change-submit")).toBeDisabled();
    expect(w.relays).toBe(0);
  });

  test("maker alone while the offer is Open: change applies at once, shown after read-back; relayed as amend_referee with deposit 0", async ({ page }) => {
    const w = world({ status: "Open", taker: null, onRelay: (x) => { x.referee = NEW_REF; } });
    const relayed = await setup(page, w);
    await open(page);
    await expect(page.getByTestId("referee-change-section")).toContainText("takes effect right away");
    await page.getByTestId("referee-change-input").fill(NEW_REF);
    await page.getByTestId("referee-change-submit").click();
    await page.getByTestId("referee-change-confirm").click(); // MODAL1c4: the send is confirmed in a modal now
    await expect(page.getByTestId("referee-change-result")).toHaveAttribute("data-kind", "changed", { timeout: 20_000 });
    await expect(page.getByTestId("bet-sentence")).toContainText("Waiting for someone");
    await expect(page.getByTestId("referee-change-result")).toContainText("@newref"); // B1: @username
    expect(w.relays).toBe(1);
    expect(await signs(page)).toBe(1);
    const d = decodeRelayed(relayed[0]);
    expect({ m: d.method, dep: d.deposit, a: d.args }).toEqual({ m: "amend_referee", dep: "0", a: { bet_id: 7, new_referee_json: refValue(NEW_REF) } });
  });

  test("read-back: a send the contract ignored never shows success; a refused tx shows the plain reason from the table", async ({ page }) => {
    const w = world({ status: "Open", taker: null, txFail: "referee cannot be maker or fee_account" });
    await setup(page, w);
    await open(page);
    await page.getByTestId("referee-change-input").fill(NEW_REF);
    await page.getByTestId("referee-change-submit").click();
    await page.getByTestId("referee-change-confirm").click(); // MODAL1c4: the send is confirmed in a modal now
    await expect(page.getByTestId("referee-change-result")).toHaveAttribute("data-kind", "refused", { timeout: 20_000 });
    await expect(page.getByTestId("referee-change-result")).toContainText("can't be the referee");
    await expect(page.getByTestId("referee-change-result")).not.toContainText("The referee is now");
    expect(w.relays).toBe(1);
  });

  test("read-back: sent but nothing visible and no readable failure -> 'still confirming', never success", async ({ page }) => {
    const w = world({ status: "Open", taker: null });
    await setup(page, w);
    await open(page);
    await page.getByTestId("referee-change-input").fill(NEW_REF);
    await page.getByTestId("referee-change-submit").click();
    await page.getByTestId("referee-change-confirm").click(); // MODAL1c4: the send is confirmed in a modal now
    await expect(page.getByTestId("referee-change-result")).toHaveAttribute("data-kind", "pending", { timeout: 20_000 });
  });

  test("declining the wallet prompt: nothing is sent and no error scare", async ({ page }) => {
    const w = world({ status: "Open", taker: null });
    await setup(page, w, { decline: true });
    await open(page);
    await page.getByTestId("referee-change-input").fill(NEW_REF);
    await page.getByTestId("referee-change-submit").click();
    await page.getByTestId("referee-change-confirm").click(); // MODAL1c4: the send is confirmed in a modal now
    await expect(page.getByTestId("referee-change-result")).toHaveAttribute("data-kind", "declined", { timeout: 20_000 });
    expect(w.relays).toBe(0);
  });

  test("switch human -> AI: offered when terms carry sources; a fresh preflight passes; relays amend_referee with new_referee_json 'null' and shows it after read-back", async ({ page }) => {
    const terms = JSON.stringify({ claim: "BTC high >= 100k", sources_allowed: [{ id: "S1", publisher: "Coinbase BTC-USD" }] });
    const w = world({ status: "Open", taker: null, terms, onRelay: (x) => { x.referee = null; } });
    const relayed = await setup(page, w);
    await open(page);
    await page.getByTestId("switch-to-ai").click();
    await expect(page.getByTestId("switch-to-ai-confirm")).toBeDisabled();
    await page.getByTestId("check-sources-btn").click();
    await expect(page.getByTestId("source-check-status")).toContainText("Checking sources… ✓"); // C1 wording
    expect(w.scCalls).toBe(1);
    expect(w.relays).toBe(0);
    await page.getByTestId("switch-to-ai-confirm").click();
    await page.getByTestId("referee-change-confirm").click(); // MODAL1c4: the send is confirmed in a modal now
    await expect(page.getByTestId("referee-change-result")).toHaveAttribute("data-kind", "changed", { timeout: 20_000 });
    await expect(page.getByTestId("referee-change-result")).toContainText("AI");
    const d = decodeRelayed(relayed[0]);
    expect({ m: d.method, dep: d.deposit, a: d.args }).toEqual({ m: "amend_referee", dep: "0", a: { bet_id: 7, new_referee_json: "null" } });
    expect(w.relays).toBe(1);
  });

  test("switch to AI after the take is a both-sign proposal of 'null'", async ({ page }) => {
    const terms = JSON.stringify({ claim: "x", sources_allowed: [{ id: "S1", publisher: "NWS" }] });
    const w = world({ terms, onRelay: (x) => { x.proposal = { maker_value: "null", taker_value: null }; } });
    const relayed = await setup(page, w);
    await open(page);
    await page.getByTestId("switch-to-ai").click();
    await page.getByTestId("check-sources-btn").click();
    await expect(page.getByTestId("source-check-status")).toBeVisible();
    await page.getByTestId("switch-to-ai-confirm").click();
    await page.getByTestId("referee-change-confirm").click(); // MODAL1c4: the send is confirmed in a modal now
    await expect(page.getByTestId("referee-change-result")).toHaveAttribute("data-kind", "proposed", { timeout: 20_000 });
    expect(decodeRelayed(relayed[0]).args).toEqual({ bet_id: 7, new_referee_json: "null" });
  });

  test("switch to AI: the preflight fails -> plain reason, nothing signed or sent, the confirm never enables", async ({ page }) => {
    const terms = JSON.stringify({ claim: "x", sources_allowed: [{ id: "S1", publisher: "NWS" }] });
    const w = world({ status: "Open", taker: null, terms, scMode: "fail" });
    await setup(page, w);
    await open(page);
    await page.getByTestId("switch-to-ai").click();
    await page.getByTestId("check-sources-btn").click();
    await expect(page.getByTestId("source-check-error")).toContainText("can't settle");
    await expect(page.getByTestId("switch-to-ai-confirm")).toBeDisabled();
    expect(w.relays).toBe(0);
    expect(await signs(page)).toBe(0);
  });

  test("the referee-change section never shows to someone who is not a party", async ({ page }) => {
    await setup(page, world(), { wallet: false });
    await open(page);
    await expect(page.getByTestId("referee-change-section")).toHaveCount(0);
  });
});
