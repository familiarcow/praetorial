// DR1 (rehearsal-btc-touch-ai): AI-judged btc_touch (Coinbase / Bitstamp / Kraken template sources) on the DEPLOYED testnet web.
// Phase "open" (default): maker (real Privy login) builds + opens in the web builder, taker takes via the invite link (Node-side __drSign), pending ground truth + state saved. Zero NEAR AI calls.
// Phase "finish" (DR1_PHASE=finish): after T: harness fetches Kraken/Coinbase/Bitstamp candles and writes ground_truth.json BEFORE request_resolution,
// then request_resolution through the web, judge result, finalize through the web after the settlement window, payouts + money from chain views.
import { test, expect, type Page, type Browser } from "./pw.js";
import fs from "node:fs";
import path from "node:path";
import { checkObserved, loadFeeConfig } from "../harness/money.js";
import { expectedDecisive, methodProblems, paidTo, type BetView } from "./expected.js";
import { computeTruth, chooseThreshold, type Direction } from "./groundTruth.js";
import { ESCROW, FEE, view, bal, nearBal, wallet, fundUsdc, fundNear, escrowMethods, sleep } from "./chain.js";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const RUN = path.join(DIR, "run");
fs.mkdirSync(RUN, { recursive: true });
const PHASE = process.env.DR1_PHASE ?? "open";
const ORPHAN = Number(process.env.DR1_CANCEL_ORPHAN ?? "0"); // an earlier attempt's open bet whose invite secret (browser localStorage) was lost: the maker cancels it through the web first
const R: Record<string, any> = fs.existsSync(path.join(RUN, "results.json")) && PHASE === "finish" ? JSON.parse(fs.readFileSync(path.join(RUN, "results.json"), "utf8")) : { txs: [], steps: [] };
const save = () => fs.writeFileSync(path.join(RUN, "results.json"), JSON.stringify(R, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
const step = (s: string, extra: Record<string, unknown> = {}) => { R.steps.push({ s, t: new Date().toISOString(), ...extra }); save(); };
const tx = (s: string, hash: string | null) => { R.txs.push({ step: s, hash, url: hash ? `https://testnet.nearblocks.io/txns/${hash}` : null }); save(); };
const EMAIL = process.env.PRIVY_TEST_EMAIL ?? "", OTP = process.env.PRIVY_TEST_OTP ?? ""; // only used to fill the form; never logged or stored
const STATE = path.join(RUN, "state.json");
const NEAR1 = 10n ** 24n, STAKE = 3n * NEAR1; // 3 wNEAR per side
const WINDOW_H = Number(process.env.DR1_WINDOW_H ?? "6"); // > 5 h proves D-SRCCHK3 (btc_touch sourcecheck probes the last closed minute, not the whole window)
const DIRECTION: Direction = "at_or_above";

async function ready(p: Page) { await p.waitForFunction(() => (globalThis as { __e2e?: { ready?: boolean } }).__e2e?.ready === true, undefined, { timeout: 30_000 }); }
async function skipUsernameIfAsked(p: Page, who: string) {
  const input = p.getByTestId("username-input");
  await expect(input.or(p.getByTestId("create-offer-form")).or(p.getByTestId("nav-create")).or(p.getByTestId("bet-page")).or(p.getByTestId("take-section")).first()).toBeVisible({ timeout: 60_000 });
  if (!(await input.isVisible().catch(() => false))) return;
  if (await p.getByTestId("username-skip").count()) { await p.getByTestId("username-skip").click(); R[`username_${who}`] = "skipped via the app's Skip button"; save(); }
}
const testWalletCtx = async (browser: Browser, w: ReturnType<typeof wallet>) => {
  const ctx = await browser.newContext();
  await ctx.exposeBinding("__drSign", (_s, _address: never, hashHex: never) => w.sign(hashHex));
  await ctx.addInitScript(`(() => { window.__e2eTestWallet = { nearAddress: ${JSON.stringify(w.address)}, signRawHash: (a, h) => window.__drSign(a, h) }; })();`);
  return ctx;
};
const optText = async (l: { count(): Promise<number>; textContent(): Promise<string | null> }): Promise<string | null> => ((await l.count()) > 0 ? l.textContent() : null);
const bals = async (maker: string, taker: string) => ({ maker: await bal(maker), taker: await bal(taker), fee: await bal(FEE), escrow: await bal(ESCROW) });

test("DR1: AI btc_touch, real price decides, request_resolution -> judge -> finalize through the web", async ({ browser }) => {
  test.setTimeout(PHASE === "finish" ? 3 * 3_600_000 : 900_000);
  const cfg = loadFeeConfig();
  const tw = wallet("taker");

  if (PHASE === "finish") {
    // ================= phase 2 (after T)
    const st = JSON.parse(fs.readFileSync(STATE, "utf8")) as { betId: number; maker: string; sinceNs: string; deadlineSecs: number; openSecs: number; x: number; mid: Record<string, string>; before: Record<string, string> };
    const betId = st.betId;
    const toB = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, BigInt(v)])) as Record<"maker" | "taker" | "fee" | "escrow", bigint>;
    const mid = toB(st.mid), before = toB(st.before);
    while (Date.now() / 1000 < st.deadlineSecs + 120) await sleep(15_000); // T + 2 min: the last window minute is closed on every venue
    step("T passed; fetching independent ground truth");
    const betTaken = JSON.parse(fs.readFileSync(path.join(RUN, "bet_taken.json"), "utf8")) as BetView;
    const truth = await computeTruth(DIRECTION, st.x, st.openSecs, st.deadlineSecs);
    const preStatus: BetView = await view("get_bet", { bet_id: betId });
    const gt = { written_at: new Date().toISOString(), bet_id: betId, claim: `BTC ${DIRECTION} ${st.x} USD (1-minute wick) between ${new Date(st.openSecs * 1000).toISOString()} and ${new Date(st.deadlineSecs * 1000).toISOString()}`,
      source: "public Kraken OHLC, Coinbase Exchange candles, Bitstamp OHLC, fetched by the harness; judge not consulted", ...truth,
      outcome_read_before_this: false, bet_status_at_write: preStatus.status, bet_outcome_at_write: preStatus.outcome ?? null, request_resolution_sent_before_this: false };
    fs.writeFileSync(path.join(RUN, "ground_truth.json"), JSON.stringify(gt, null, 2));
    expect(preStatus.outcome ?? null).toBe(null);
    R.ground_truth = truth; step("ground_truth.json written", { outcome: truth.outcome, confirming: truth.confirming });

    const tctx = await testWalletCtx(browser, tw);
    const taker = await tctx.newPage();
    taker.on("response", async (r) => { if (/workers\.dev/.test(r.url())) { (R.relayer_responses ??= []).push({ url: r.url().replace(/\?.*/, ""), method: r.request().method(), status: r.status(), body: (await r.text().catch(() => "")).slice(0, 300) }); save(); } });
    // request_resolution through the web (the only NEAR AI spend of this item)
    if (BigInt(await nearBal(tw.address)) < NEAR1 / 2n) tx("tNEAR top-up to taker for the resolution deposit", await fundNear(tw.address, NEAR1));
    await taker.goto(`/bet/${betId}`); await ready(taker); await skipUsernameIfAsked(taker, "taker");
    await expect(taker.getByTestId("request-result-section")).toBeVisible({ timeout: 60_000 });
    await expect(taker.getByTestId("request-result-btn")).toBeEnabled({ timeout: 60_000 });
    await taker.getByTestId("request-result-btn").click();
    step("request_resolution clicked in the web");
    await sleep(15_000);
    R.request_result_ui = { status: await optText(taker.getByTestId("request-result-status")), error: await optText(taker.getByTestId("request-result-error")), tx: await optText(taker.getByTestId("request-result-tx")) }; save();
    tx("request_resolution (web)", R.request_result_ui.tx);

    // judge result: poll the chain until the AI outcome is submitted
    const statuses: string[] = [];
    let cur: BetView & Record<string, any> = await view("get_bet", { bet_id: betId });
    const t0 = Date.now();
    while (cur.outcome == null && Date.now() - t0 < 45 * 60_000) { await sleep(20_000); cur = await view("get_bet", { bet_id: betId }); if (statuses.at(-1) !== cur.status) statuses.push(cur.status); }
    R.status_trail = statuses; R.bet_after_judge = cur; step("judge result observed", { status: cur.status, outcome: cur.outcome ?? null });
    expect(cur.outcome ?? null).toBeTruthy();
    // WRONG-WINNER guard: recorded first, asserted second
    R.winner_check = { chain_outcome: cur.outcome, ground_truth: truth.outcome, match: cur.outcome === truth.outcome }; save();
    expect(cur.outcome).toBe(truth.outcome);

    // finalize through the web after the settlement window
    const tFin = Date.now();
    let finalized = false;
    while (Date.now() - tFin < 90 * 60_000) {
      await taker.goto(`/bet/${betId}`); await ready(taker);
      if (await taker.getByTestId("finalize-btn").isVisible().catch(() => false)) {
        try { await expect(taker.getByTestId("finalize-btn")).toBeEnabled({ timeout: 10_000 }); finalized = true; break; } catch { /* window still open */ }
      }
      cur = await view("get_bet", { bet_id: betId });
      if (cur.status === "Settled" || cur.status === "Finalized") break; // keeper finalized first: recorded as such
      await sleep(60_000);
    }
    if (finalized) {
      await taker.getByTestId("finalize-btn").click();
      step("finalize clicked in the web");
      await sleep(15_000);
      R.finalize_ui = { text: await optText(taker.getByTestId("finalize-section")) }; save();
    } else R.finalize_by = "keeper (web finalize button never became actionable)";
    for (let i = 0; i < 200 && !(await view("is_fully_paid", { bet_id: betId })); i++) await sleep(3000);
    const fin: BetView & Record<string, any> = await view("get_bet", { bet_id: betId });
    R.bet_final = fin; save();
    expect(fin.status).toBe("Settled");
    expect(fin.outcome).toBe(truth.outcome);

    const after = await bals(st.maker, tw.address);
    R.balances_after = after;
    const exp = expectedDecisive(betTaken, fin.outcome as "YES" | "NO", cfg.feeBps);
    const deltas = { maker: after.maker - mid.maker, taker: after.taker - mid.taker, fee: after.fee - mid.fee };
    const bad = checkObserved(exp, deltas, { escrowAfter: after.escrow - before.escrow });
    R.money_check = { expected: exp.lines, deltas, mismatches: bad, winner_paid: paidTo(exp, "maker") > 0n ? "maker" : "taker" }; save();
    expect(bad).toEqual([]);
    expect(await view("is_fully_paid", { bet_id: betId })).toBe(true);
    expect((await view("pending_payouts", { bet_id: betId })).filter((l: any) => !l.done)).toEqual([]);
    await sleep(4000);
    const hist = await escrowMethods(BigInt(st.sinceNs));
    R.escrow_tx_methods = hist; save();
    expect(methodProblems(hist.flatMap((h) => h.methods))).toEqual([]);
    step("DR1 finish assertions passed");
    return;
  }

  // ================= phase 1 (open): zero NEAR AI calls
  const sinceNs = BigInt(Date.now() - 60_000) * 1_000_000n;
  R.escrow = ESCROW; R.taker = tw.address; save();
  const { x, spot } = await chooseThreshold(DIRECTION);
  R.threshold = { direction: DIRECTION, x_usd: x, coinbase_spot_at_choice: spot, pct_above_spot: Number(((x / spot - 1) * 100).toFixed(3)) }; save();

  const mctx = await browser.newContext();
  const maker = await mctx.newPage();
  maker.on("response", async (r) => { if (/workers\.dev/.test(r.url())) { (R.relayer_responses ??= []).push({ url: r.url().replace(/\?.*/, ""), method: r.request().method(), status: r.status(), body: (await r.text().catch(() => "")).slice(0, 300) }); save(); } });
  await maker.goto("/"); await ready(maker);
  await maker.getByTestId("email-input").fill(EMAIL);
  await maker.getByTestId("send-code").click();
  await maker.waitForTimeout(2500);
  await maker.getByTestId("otp-input").fill(OTP);
  await maker.getByTestId("submit-code").click();
  await maker.waitForFunction(() => !!(globalThis as { __e2e?: { nearAddress?: string } }).__e2e?.nearAddress, undefined, { timeout: 60_000 });
  const makerAddr = (await maker.getByTestId("near-address").textContent())!.trim();
  expect(makerAddr).toMatch(/^[0-9a-f]{64}$/);
  R.maker = makerAddr; step("maker logged in (Privy)");
  tx("mint wNEAR (betting balance) to maker", await fundUsdc(makerAddr, STAKE + NEAR1 / 10n));
  tx("mint wNEAR (betting balance) to taker", await fundUsdc(tw.address, STAKE + NEAR1 / 10n));
  if ((await nearBal(makerAddr)) === "absent") tx("tNEAR to maker implicit", await fundNear(makerAddr, NEAR1 / 10n));
  if ((await nearBal(tw.address)) === "absent") tx("tNEAR to taker implicit", await fundNear(tw.address, NEAR1 / 10n));
  await skipUsernameIfAsked(maker, "maker");
  const before = await bals(makerAddr, tw.address);
  R.balances_before = before; save();

  if (ORPHAN > 0) { // cancel the orphan through the web; the maker gets stake + storage back
    await maker.goto(`/bet/${ORPHAN}`); await ready(maker);
    await expect(maker.getByTestId("cancel-bet")).toBeVisible({ timeout: 60_000 });
    await maker.getByTestId("cancel-bet").click(); await maker.getByTestId("cancel-confirm").click();
    await expect(maker.getByTestId("cancel-result")).toBeVisible({ timeout: 180_000 });
    tx(`cancel orphan bet ${ORPHAN} (web, maker)`, await optText(maker.getByTestId("cancel-tx")));
    for (let i = 0; i < 40 && !(await view("is_fully_paid", { bet_id: ORPHAN })); i++) await sleep(3000);
    R.orphan = { bet: ORPHAN, status: (await view("get_bet", { bet_id: ORPHAN })).status }; step("orphan bet cancelled", R.orphan);
    await maker.goto("/"); await ready(maker);
  }
  let betId: number; let dl: Date; let openMs: number; const xUsd: number = x;
  await maker.getByTestId("nav-create").click();
  await expect(maker.getByTestId("create-offer-form")).toBeVisible();
  await maker.getByTestId("bet-type-card-btc_touch").click();
  dl = new Date(Date.now() + WINDOW_H * 3_600_000); dl.setUTCSeconds(0, 0);
  await maker.getByTestId("guided-direction").selectOption(DIRECTION);
  await maker.getByTestId("guided-x_usd").fill(String(xUsd));
  await maker.getByTestId("guided-deadline_utc").fill(dl.toISOString().slice(0, 16));
  await maker.getByTestId("fill-next").click();
  await maker.getByTestId("maker-amount").fill("3");
  await maker.getByTestId("odds-input").fill("1");
  await maker.getByTestId("invite-by-link").check();
  await maker.getByTestId("settlement-period").selectOption("1h");
  await maker.getByTestId("review-offer").click();
  await expect(maker.getByTestId("review-card")).toBeVisible();
  R.review_text = (await maker.getByTestId("review-card").innerText()).slice(0, 2500); save();
  await maker.getByTestId("check-sources-btn").click(); // the ONLY sourcecheck; a 429 stops the run
  await expect(maker.getByTestId("source-check-status")).toContainText("The AI can read these sources.", { timeout: 240_000 });
  R.sourcecheck_status = await maker.getByTestId("source-check-status").innerText(); save();
  await expect(maker.getByTestId("open-offer-btn")).toBeEnabled({ timeout: 30_000 });
  openMs = Date.now();
  await maker.getByTestId("open-offer-btn").click();
  await expect(maker.getByTestId("share-screen")).toBeVisible({ timeout: 120_000 });
  const link = await maker.getByTestId("share-link").inputValue();
  betId = Number(link.match(/\/bet\/(\d+)/)![1]);
  R.betId = betId; step("maker opened the AI bet via web", { betId });
  tx("open (web, maker; txHash shown on the share screen, else the relay response)", await optText(maker.getByTestId("open-tx")));
  const betOpen: BetView = await view("get_bet", { bet_id: betId });
  expect(betOpen.status).toBe("Open"); expect(betOpen.envelope.referee ?? null).toBe(null);
  R.bet_open = betOpen; save();

  await maker.getByTestId("share-view-bet").click();
  await expect(maker.getByTestId("invite-section")).toBeVisible({ timeout: 30_000 });
  await maker.getByTestId("invite-invitee-input").fill(tw.address);
  await maker.getByTestId("invite-make-link").click();
  await expect(maker.getByTestId("invite-link-output")).toBeVisible();
  const inviteLink = (await maker.getByTestId("invite-link-output").inputValue().catch(async () => (await maker.getByTestId("invite-link-output").textContent()) ?? "")).trim();
  step("maker made the taker's invite link");
  const tctx = await testWalletCtx(browser, tw);
  const taker = await tctx.newPage();
  await taker.goto(inviteLink); await ready(taker); await skipUsernameIfAsked(taker, "taker");
  await expect(taker.getByTestId("take-confirm")).toBeEnabled({ timeout: 60_000 });
  await taker.getByTestId("take-confirm").click();
  await expect(taker.getByTestId("take-result")).toHaveAttribute("data-kind", "taken", { timeout: 120_000 });
  tx("take (web, taker)", await optText(taker.getByTestId("take-tx")));
  step("taker took via invite link");
  const betTaken: BetView = await view("get_bet", { bet_id: betId });
  expect(betTaken.status).toBe("Taken"); expect(betTaken.taker).toBe(tw.address);
  fs.writeFileSync(path.join(RUN, "bet_taken.json"), JSON.stringify(betTaken, null, 2));
  const mid = await bals(makerAddr, tw.address);
  R.balances_after_take = mid; save();

  const deadlineSecs = Math.floor(dl.getTime() / 1000);
  const openSecs = Math.ceil(openMs / 60_000) * 60; // candles from the first whole minute after the open click (conservative; web open_utc is the click time)
  const pending = { written_at: new Date().toISOString(), bet_id: betId, claim: `BTC ${DIRECTION} ${xUsd} USD (1-minute wick) before ${dl.toISOString()}`, status: "PENDING: the event window has not happened yet; candles are fetched in phase 2 from Kraken + Coinbase (+ Bitstamp), BEFORE request_resolution is sent",
    outcome_read_before_this: false, bet_status_at_write: betTaken.status, bet_outcome_at_write: betTaken.outcome ?? null, window_utc: [new Date(openSecs * 1000).toISOString(), dl.toISOString()] };
  fs.writeFileSync(path.join(RUN, "ground_truth.json"), JSON.stringify(pending, null, 2));
  fs.writeFileSync(STATE, JSON.stringify({ betId, maker: makerAddr, sinceNs: sinceNs.toString(), deadlineSecs, openSecs, x: xUsd,
    mid: Object.fromEntries(Object.entries(mid).map(([k, v]) => [k, v.toString()])), before: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.toString()])) }, null, 2));
  step("DR1 phase 1 done; resume after T with DR1_PHASE=finish", { T: dl.toISOString(), earliest_request_resolution: new Date((deadlineSecs + 120) * 1000).toISOString() });
});
