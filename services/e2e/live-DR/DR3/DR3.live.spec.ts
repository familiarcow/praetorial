// DR3 (rehearsal-nws-daily-high-ai): AI-judged nws_daily_high on the DEPLOYED testnet web (escrow = the one the web bundle targets).
// Phase "open" (default): maker (real Privy login; OTP never logged) builds + opens the bet in the web builder, a FRESH per-run taker wallet takes via the web.
// Phase "finish" (DR3_PHASE=finish): the harness polls the IEM copy of the CLI product for the climate day and writes ground_truth.json BEFORE request_resolution;
// then request_resolution through the web, judge result (wrong-winner guard), finalize (web button, else keeper), money from chain views, verifier expectations.
// Env: DR3_STATION (e.g. KNYC), DR3_DATE (YYYY-MM-DD local standard-time day), DR3_OP (>=), DR3_X (whole degrees F), PRIVY_TEST_EMAIL, PRIVY_TEST_OTP (read only to fill the form).
import { test, expect, type Page, type Browser } from "../DR1/pw.js";
import fs from "node:fs";
import path from "node:path";
import { loadFeeConfig, checkPerBetMoney } from "../harness/money.js";
import { expectedDecisive, paidTo, methodProblems, type BetView } from "./expected.js";
import { cliTruth, fetchIemCli, type Op } from "./groundTruth.js";
import { freshWallet, loadWallet, type Wallet } from "./wallet.js";
import { ESCROW, FEE, view, bal, nearBal, fundUsdc, fundNear, escrowMethods, sleep } from "./chain.js";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const RUN = path.join(DIR, "run");
fs.mkdirSync(RUN, { recursive: true });
const cacheDir = (): string => process.env.PRAETORIAL_CACHE_DIR ?? (() => { throw new Error("set PRAETORIAL_CACHE_DIR (operator cache dir; holds scratch/<run>_<role>_key.json)"); })();
// PUB1/MISS1: resolved lazily (Playwright --list imports this spec with no env)
const scratch = (): string => `${cacheDir()}/scratch/dr3_taker_wallet.json`; // 0600, outside the repo
const ORPHAN = Number(process.env.DR3_CANCEL_ORPHAN ?? "0");
const PHASE = process.env.DR3_PHASE ?? "open";
const R: Record<string, any> = fs.existsSync(path.join(RUN, "results.json")) && (PHASE === "finish" || PHASE === "take") ? JSON.parse(fs.readFileSync(path.join(RUN, "results.json"), "utf8")) : { txs: [], steps: [] };
const save = () => fs.writeFileSync(path.join(RUN, "results.json"), JSON.stringify(R, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
const step = (s: string, extra: Record<string, unknown> = {}) => { R.steps.push({ s, t: new Date().toISOString(), ...extra }); save(); };
const tx = (s: string, hash: string | null, by = "web") => { R.txs.push({ step: s, by, hash, url: hash ? `https://testnet.nearblocks.io/txns/${hash}` : null }); save(); };
const EMAIL = process.env.PRIVY_TEST_EMAIL ?? "", OTP = process.env.PRIVY_TEST_OTP ?? "";
const STATE = path.join(RUN, "state.json");
const NEAR1 = 10n ** 24n, STAKE = 3n * NEAR1;
const STATION = process.env.DR3_STATION ?? "KNYC", DATE = process.env.DR3_DATE ?? new Date().toISOString().slice(0, 10), OP = (process.env.DR3_OP ?? ">=") as Op, X = Number(process.env.DR3_X ?? "62");

async function ready(p: Page) { await p.waitForFunction(() => (globalThis as { __e2e?: { ready?: boolean } }).__e2e?.ready === true, undefined, { timeout: 30_000 }); }
async function skipUsernameIfAsked(p: Page, who: string) {
  await p.waitForTimeout(3000); // the first-login dialog renders a moment after the wallet is ready
  const input = p.getByTestId("username-input");
  await expect(input.or(p.getByTestId("create-offer-form")).or(p.getByTestId("nav-create")).or(p.getByTestId("bet-page")).or(p.getByTestId("take-section")).first()).toBeVisible({ timeout: 60_000 });
  if (!(await input.isVisible().catch(() => false))) return;
  if (await p.getByTestId("username-skip").count()) { await p.getByTestId("username-skip").click(); R[`username_${who}`] = "skipped via the app's Skip button"; save(); }
  else {
    // a fresh account has no username and the web gates the bet page on one (Skip is shown only when the registry is down): claim one through the dialog
    const name = "dr3t" + Math.random().toString(16).slice(2, 10);
    await input.fill(name);
    await expect(p.getByTestId("username-claim-btn")).toBeEnabled({ timeout: 30_000 });
    await p.getByTestId("username-claim-btn").click();
    await expect(input).toBeHidden({ timeout: 60_000 });
    R[`username_${who}`] = `claimed ` + name + ` via the first-login dialog`; save();
  }
}
const testWalletCtx = async (browser: Browser, w: Wallet) => {
  const ctx = await browser.newContext();
  await ctx.exposeBinding("__drSign", (_s, _address: never, hashHex: never) => w.sign(hashHex));
  await ctx.addInitScript(`(() => { window.__e2eTestWallet = { nearAddress: ${JSON.stringify(w.address)}, signRawHash: (a, h) => window.__drSign(a, h) }; })();`);
  return ctx;
};
const optText = async (l: { count(): Promise<number>; textContent(): Promise<string | null> }): Promise<string | null> => ((await l.count()) > 0 ? l.textContent() : null);
const bals = async (maker: string, taker: string) => ({ maker: await bal(maker), taker: await bal(taker), fee: await bal(FEE), escrow: await bal(ESCROW) });

test("DR3: AI nws_daily_high, real CLI reading decides, request_resolution -> judge -> finalize through the web", async ({ browser }) => {
  test.setTimeout(PHASE === "finish" ? 4 * 3_600_000 : 900_000);
  const cfg = loadFeeConfig();

  if (PHASE === "finish") {
    const st = JSON.parse(fs.readFileSync(STATE, "utf8")) as { betId: number; maker: string; sinceNs: string; station: string; date: string; op: Op; x: number; mid: Record<string, string>; before: Record<string, string> };
    const betId = st.betId, tw = loadWallet(scratch());
    const mid = Object.fromEntries(Object.entries(st.mid).map(([k, v]) => [k, BigInt(v)])) as Record<"maker" | "taker" | "fee" | "escrow", bigint>;
    // 1. ground truth first: poll the IEM copy until a CLI product for the climate day exists (preliminary 4 PM issue or the next-morning final)
    let truth: ReturnType<typeof cliTruth> | null = null, raw = "";
    const t0 = Date.now();
    while (!truth && Date.now() - t0 < 6 * 3_600_000) {
      raw = await fetchIemCli(st.station, 8);
      try { truth = cliTruth(raw, st.station, st.date, st.op, st.x); } catch { await sleep(60_000); }
    }
    if (!truth) throw new Error("no CLI product for the climate day within 6 h");
    // the judge may use only a product that is out; wait one more minute so the IEM and NWS copies agree before we ask
    const preStatus: BetView = await view("get_bet", { bet_id: betId });
    fs.writeFileSync(path.join(RUN, "iem_cli_raw.txt"), raw);
    const gt = { fetched_at: new Date().toISOString(), bet_id: betId, claim: `NWS CLI max temperature at ${st.station} on ${st.date} ${st.op} ${st.x} F`, source: "IEM copy of the NWS CLI product (mesonet.agron.iastate.edu afos retrieve.py), fetched by the harness; judge not consulted",
      raw_text_sha256_of_decisive_product: truth.rawSha256, raw_response_file: "iem_cli_raw.txt", ...truth, outcome_read_before_this: false, bet_status_at_write: preStatus.status, bet_outcome_at_write: preStatus.outcome ?? null, request_resolution_sent_before_this: false };
    fs.writeFileSync(path.join(RUN, "ground_truth.json"), JSON.stringify(gt, null, 2));
    expect(preStatus.outcome ?? null).toBe(null);
    R.ground_truth = truth; step("ground_truth.json written", { outcome: truth.outcome, highF: truth.highF, issued: truth.issued });

    const tctx = await testWalletCtx(browser, tw);
    const taker = await tctx.newPage();
    if (BigInt(await nearBal(tw.address)) < NEAR1 / 2n) tx("tNEAR top-up to taker for the resolution deposit", await fundNear(tw.address, NEAR1), "harness");
    await taker.goto(`/bet/${betId}`); await ready(taker); await skipUsernameIfAsked(taker, "taker");
    await expect(taker.getByTestId("request-result-section")).toBeVisible({ timeout: 60_000 });
    await expect(taker.getByTestId("request-result-btn")).toBeEnabled({ timeout: 60_000 });
    await taker.getByTestId("request-result-btn").click();
    step("request_resolution clicked in the web");
    await sleep(15_000);
    R.request_result_ui = { status: await optText(taker.getByTestId("request-result-status")), error: await optText(taker.getByTestId("request-result-error")), tx: await optText(taker.getByTestId("request-result-tx")) }; save();
    tx("request_resolution (web, taker)", R.request_result_ui.tx);

    const statuses: string[] = [];
    let cur: BetView & Record<string, any> = await view("get_bet", { bet_id: betId });
    const t1 = Date.now();
    while (cur.outcome == null && Date.now() - t1 < 45 * 60_000) { await sleep(20_000); cur = await view("get_bet", { bet_id: betId }); if (statuses.at(-1) !== cur.status) statuses.push(cur.status); }
    R.status_trail = statuses; R.bet_after_judge = cur; step("judge result observed", { status: cur.status, outcome: cur.outcome ?? null });
    expect(cur.outcome ?? null).toBeTruthy();
    R.winner_check = { chain_outcome: cur.outcome, ground_truth: truth.outcome, match: cur.outcome === truth.outcome }; save(); // recorded first, asserted second
    expect(cur.outcome).toBe(truth.outcome);

    const tFin = Date.now();
    let finalized = false;
    while (Date.now() - tFin < 90 * 60_000) {
      await taker.goto(`/bet/${betId}`); await ready(taker);
      if (await taker.getByTestId("finalize-btn").isVisible().catch(() => false)) {
        try { await expect(taker.getByTestId("finalize-btn")).toBeEnabled({ timeout: 10_000 }); finalized = true; break; } catch { /* window still open */ }
      }
      cur = await view("get_bet", { bet_id: betId });
      if (cur.status === "Settled" || cur.status === "Finalized") break;
      await sleep(60_000);
    }
    if (finalized) { await taker.getByTestId("finalize-btn").click(); step("finalize clicked in the web"); await sleep(15_000); R.finalize_ui = { text: await optText(taker.getByTestId("finalize-section")) }; save(); }
    else R.finalize_by = "keeper (web finalize button never became actionable)";
    for (let i = 0; i < 200 && !(await view("is_fully_paid", { bet_id: betId })); i++) await sleep(3000);
    const fin: BetView & Record<string, any> = await view("get_bet", { bet_id: betId });
    R.bet_final = fin; save();
    expect(fin.status).toBe("Settled"); expect(fin.outcome).toBe(truth.outcome);

    const betTaken = JSON.parse(fs.readFileSync(path.join(RUN, "bet_taken.json"), "utf8")) as BetView;
    const exp = expectedDecisive(betTaken, fin.outcome as "YES" | "NO");
    const after = await bals(st.maker, tw.address);
    R.balances_after = after;
    // taker is a FRESH per-run account (hard balance-delta assertion); the maker is the fixed Privy login (not fresh) and the fee/escrow accounts are shared, so those
    // three are proven from this bet's finalize receipts by `npx tsx DR3/money.ts <finalize_tx> <signer>` (run after finalize), plus is_fully_paid / pending_payouts below.
    const bad = checkPerBetMoney(exp, { accounts: { maker: st.maker, taker: tw.address, fee: FEE }, credits: { [st.maker]: paidTo(exp, "maker"), [tw.address]: after.taker - mid.taker, [FEE]: paidTo(exp, "fee") }, bettorDeltas: { taker: after.taker - mid.taker }, fresh: { taker: true }, isFullyPaid: await view("is_fully_paid", { bet_id: betId }) });
    R.money_check_taker_fresh = { expected_taker: paidTo(exp, "taker").toString(), taker_delta_since_take: (after.taker - mid.taker).toString(), mismatches: bad }; save();
    expect(bad).toEqual([]);
    expect((await view("pending_payouts", { bet_id: betId })).filter((l: any) => !l.done)).toEqual([]);
    await sleep(4000);
    const hist = await escrowMethods(BigInt(st.sinceNs));
    R.escrow_tx_methods = hist; save();
    expect(methodProblems(hist.flatMap((h) => h.methods))).toEqual([]);
    step("DR3 finish assertions passed");
    return;
  }

  if (PHASE === "take") { // resume an opened-but-untaken bet (the first take attempt of a run failed on a UI step): the fresh taker wallet is the one persisted by the open phase
    const betId = Number(process.env.DR3_BET_ID), tw = loadWallet(scratch());
    const sinceNs = BigInt(Date.parse(R.steps[0].t) - 60_000) * 1_000_000n;
    const before = Object.fromEntries(Object.entries(R.balances_before).map(([k, v]) => [k, BigInt(v as string)])) as Record<"maker" | "taker" | "fee" | "escrow", bigint>;
    expect(R.taker).toBe(tw.address);
    const tctx = await testWalletCtx(browser, tw);
    const taker = await tctx.newPage();
    await taker.goto(`/bet/${betId}`); await ready(taker); await skipUsernameIfAsked(taker, "taker");
    await expect(taker.getByTestId("take-open")).toBeEnabled({ timeout: 60_000 });
    await taker.getByTestId("take-open").click();
    await expect(taker.getByTestId("take-next")).toBeEnabled({ timeout: 60_000 });
    await taker.getByTestId("take-next").click();
    await expect(taker.getByTestId("take-confirm")).toBeEnabled({ timeout: 60_000 });
    await taker.getByTestId("take-confirm").click();
    await expect(taker.getByTestId("take-result")).toHaveAttribute("data-kind", "taken", { timeout: 120_000 });
    tx("take (web, taker)", await optText(taker.getByTestId("take-tx")));
    const betTaken: BetView = await view("get_bet", { bet_id: betId });
    expect(betTaken.status).toBe("Taken"); expect(betTaken.taker).toBe(tw.address);
    fs.writeFileSync(path.join(RUN, "bet_taken.json"), JSON.stringify(betTaken, null, 2));
    const mid = await bals(R.maker, tw.address);
    R.balances_after_take = mid; R.betId = betId; save();
    fs.writeFileSync(path.join(RUN, "ground_truth.json"), JSON.stringify({ written_at: new Date().toISOString(), bet_id: betId, status: "PENDING: the CLI product for the climate day is not out yet; the harness fetches the IEM copy in phase 2 BEFORE request_resolution", outcome_read_before_this: false }, null, 2));
    fs.writeFileSync(STATE, JSON.stringify({ betId, maker: R.maker, taker: tw.address, sinceNs: sinceNs.toString(), station: STATION, date: DATE, op: OP, x: X,
      mid: Object.fromEntries(Object.entries(mid).map(([k, v]) => [k, v.toString()])), before: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.toString()])), fresh_taker: true }, null, 2));
    step("DR3 take phase done; resume once the CLI product is out with DR3_PHASE=finish");
    return;
  }

  // ================= phase 1 (open): zero NEAR AI calls except the web's own sourcecheck
  const tw = freshWallet(scratch());
  const sinceNs = BigInt(Date.now() - 60_000) * 1_000_000n;
  R.escrow = ESCROW; R.taker = tw.address; R.market = { station: STATION, date: DATE, op: OP, x_f: X }; save();
  const mctx = await browser.newContext();
  const maker = await mctx.newPage();
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
  const takerBefore = await bal(tw.address); // freshness: must be 0 BEFORE funding
  if (takerBefore !== 0n) throw new Error(`taker account is not fresh: ${takerBefore}`);
  tx("mint wNEAR (betting balance) to maker", await fundUsdc(makerAddr, STAKE + NEAR1 / 10n), "harness");
  tx("mint wNEAR (betting balance) to taker", await fundUsdc(tw.address, STAKE + NEAR1 / 10n), "harness");
  if ((await nearBal(makerAddr)) === "absent") tx("tNEAR to maker implicit", await fundNear(makerAddr, NEAR1 / 10n), "harness");
  tx("tNEAR to taker implicit", await fundNear(tw.address, NEAR1 / 2n), "harness");
  await skipUsernameIfAsked(maker, "maker");
  const before = await bals(makerAddr, tw.address);
  R.balances_before = before; save();
  if (ORPHAN > 0) { // an earlier attempt's bet whose funding window closed before the taker could act: the maker cancels it through the web (stake + storage back)
    await maker.goto(`/bet/${ORPHAN}`); await ready(maker);
    await expect(maker.getByTestId("cancel-bet")).toBeVisible({ timeout: 60_000 });
    await maker.getByTestId("cancel-bet").click(); await maker.getByTestId("cancel-confirm").click();
    await expect(maker.getByTestId("cancel-result")).toBeVisible({ timeout: 180_000 });
    tx(`cancel orphan bet ${ORPHAN} (web, maker)`, await optText(maker.getByTestId("cancel-tx")));
    for (let i = 0; i < 40 && !(await view("is_fully_paid", { bet_id: ORPHAN })); i++) await sleep(3000);
    R.orphan = { bet: ORPHAN, status: (await view("get_bet", { bet_id: ORPHAN })).status }; step("orphan bet cancelled", R.orphan);
    await maker.goto("/"); await ready(maker);
  }
  // pre-warm the taker (wallet ready, username dialog dismissed): a climate day that already started has a ~60 s funding window
  const tctx = await testWalletCtx(browser, tw);
  const taker = await tctx.newPage();
  await taker.goto("/"); await ready(taker); await skipUsernameIfAsked(taker, "taker");

  await maker.getByTestId("nav-create").click();
  await expect(maker.getByTestId("create-offer-form")).toBeVisible();
  await maker.getByTestId("bet-type-card-nws_daily_high").click();
  await maker.getByTestId("guided-station").selectOption(STATION);
  await maker.getByTestId("guided-date").fill(DATE);
  await maker.getByTestId("guided-op").selectOption(OP);
  await maker.getByTestId("guided-x_f").fill(String(X));
  await maker.getByTestId("fill-next").click();
  await maker.getByTestId("maker-amount").fill("3");
  await maker.getByTestId("odds-input").fill("1");
  await maker.getByTestId("invite-by-link").check(); // the invite link carries the terms; a plain /bet/N page shows the taker "Terms not available"
  await maker.getByTestId("settlement-period").selectOption("1h");
  await maker.getByTestId("review-offer").click();
  await expect(maker.getByTestId("review-card")).toBeVisible();
  R.review_text = (await maker.getByTestId("review-card").innerText()).slice(0, 2500); save();
  await maker.getByTestId("check-sources-btn").click(); // the ONLY sourcecheck; a 429 stops the run
  await expect(maker.getByTestId("source-check-status")).toContainText("The AI can read these sources.", { timeout: 240_000 });
  R.sourcecheck_status = await maker.getByTestId("source-check-status").innerText(); save();
  await expect(maker.getByTestId("open-offer-btn")).toBeEnabled({ timeout: 30_000 });
  await maker.getByTestId("open-offer-btn").click();
  await expect(maker.getByTestId("share-screen")).toBeVisible({ timeout: 120_000 });
  const link = await maker.getByTestId("share-link").inputValue();
  const betId = Number(link.match(/\/bet\/(\d+)/)![1]);
  R.betId = betId; step("maker opened the AI bet via web", { betId });
  tx("open (web, maker)", await optText(maker.getByTestId("open-tx")));
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
  await taker.goto(inviteLink); await ready(taker); await skipUsernameIfAsked(taker, "taker");
  await expect(taker.getByTestId("take-open")).toBeEnabled({ timeout: 60_000 });
  await taker.getByTestId("take-open").click();
  await expect(taker.getByTestId("take-next")).toBeEnabled({ timeout: 60_000 });
  await taker.getByTestId("take-next").click();
  await expect(taker.getByTestId("take-confirm")).toBeEnabled({ timeout: 60_000 });
  await taker.getByTestId("take-confirm").click();
  await expect(taker.getByTestId("take-result")).toHaveAttribute("data-kind", "taken", { timeout: 120_000 });
  tx("take (web, taker)", await optText(taker.getByTestId("take-tx")));
  const betTaken: BetView = await view("get_bet", { bet_id: betId });
  expect(betTaken.status).toBe("Taken"); expect(betTaken.taker).toBe(tw.address);
  fs.writeFileSync(path.join(RUN, "bet_taken.json"), JSON.stringify(betTaken, null, 2));
  const mid = await bals(makerAddr, tw.address);
  R.balances_after_take = mid; save();
  fs.writeFileSync(path.join(RUN, "ground_truth.json"), JSON.stringify({ written_at: new Date().toISOString(), bet_id: betId, status: "PENDING: the CLI product for the climate day is not out yet; the harness fetches the IEM copy in phase 2 BEFORE request_resolution", outcome_read_before_this: false }, null, 2));
  fs.writeFileSync(STATE, JSON.stringify({ betId, maker: makerAddr, taker: tw.address, sinceNs: sinceNs.toString(), station: STATION, date: DATE, op: OP, x: X,
    mid: Object.fromEntries(Object.entries(mid).map(([k, v]) => [k, v.toString()])), before: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.toString()])), fresh_taker: true }, null, 2));
  step("DR3 phase 1 done; resume once the CLI product is out with DR3_PHASE=finish");
});
