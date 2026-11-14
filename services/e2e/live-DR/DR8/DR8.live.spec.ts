// DR8 (rehearsal-ai-challenge-round2): btc_touch AI bet created via the web "Duplicate this bet" (FE-15) from frz3 bet 5, 1 h settlement period;
// after round 1 the LOSING side challenges ONCE through the S13 challenge screen paying exactly required_challenge_bond; round 2; finalize.
// Phases (DR8_PHASE): open (default) | challenge | finish. State in run/state.json. Maker = real Privy test login (OTP only read to fill the form); taker = FRESH per-run
// wallet persisted 0600 in scratch (never in the repo). Ground truth (Coinbase+Kraken+Bitstamp candles via DR1/groundTruth.ts) is written BEFORE any outcome is read.
// Settlement path: the testnet keeper requests resolution and submits stored signed rulings; web fallback is recorded as such in results.json.
import { test, expect, type Page, type Browser } from "../DR1/pw.js";
import fs from "node:fs";
import path from "node:path";
import { checkPerBetMoney } from "../harness/money.js";
import { computeTruth, type Direction } from "../DR1/groundTruth.js";
import { expectedChallenge, bondProblems, loserOf, methodProblems, paidTo, type Outcome } from "./expected.js";
import type { BetView } from "../DR1/expected.js";
import { freshWallet, loadWallet, type Wallet } from "./wallet.js";
import { ESCROW, FEE, view, bal, nearBal, fundUsdc, fundNear, escrowMethods, sleep } from "./chain.js";

const DIR = path.dirname(new URL(import.meta.url).pathname), RUN = path.join(DIR, "run");
fs.mkdirSync(RUN, { recursive: true });
const cacheDir = (): string => process.env.PRAETORIAL_CACHE_DIR ?? (() => { throw new Error("set PRAETORIAL_CACHE_DIR (operator cache dir; holds scratch/<run>_<role>_key.json)"); })();
// PUB1/MISS1: resolved lazily (Playwright --list imports this spec with no env)
const scratch = (): string => `${cacheDir()}/scratch/dr8_taker_wallet.json`;
const PHASE = process.env.DR8_PHASE ?? "open", STATE = path.join(RUN, "state.json"), SOURCE_BET = Number(process.env.DR8_SOURCE_BET ?? "5");
const DIRECTION = (process.env.DR8_DIRECTION ?? "at_or_above") as Direction, PCT = Number(process.env.DR8_PCT ?? "0.35"), WINDOW_MIN = Number(process.env.DR8_WINDOW_MIN ?? "70");
const R: Record<string, any> = fs.existsSync(path.join(RUN, "results.json")) && PHASE !== "open" ? JSON.parse(fs.readFileSync(path.join(RUN, "results.json"), "utf8")) : { txs: [], steps: [] };
const save = () => fs.writeFileSync(path.join(RUN, "results.json"), JSON.stringify(R, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
const step = (s: string, extra: Record<string, unknown> = {}) => { R.steps.push({ s, t: new Date().toISOString(), ...extra }); save(); };
const tx = (s: string, hash: string | null, by: string) => { R.txs.push({ step: s, by, hash, url: hash ? `https://testnet.nearblocks.io/txns/${hash}` : null }); save(); };
const EMAIL = process.env.PRIVY_TEST_EMAIL ?? "", OTP = process.env.PRIVY_TEST_OTP ?? "";
const NEAR1 = 10n ** 24n, STAKE = 3n * NEAR1;
const ready = async (p: Page) => { await p.waitForFunction(() => (globalThis as { __e2e?: { ready?: boolean } }).__e2e?.ready === true, undefined, { timeout: 30_000 }); };
const optText = async (l: { count(): Promise<number>; textContent(): Promise<string | null> }) => ((await l.count()) > 0 ? l.textContent() : null);
const bals = async (maker: string, taker: string) => ({ maker: await bal(maker), taker: await bal(taker), fee: await bal(FEE), escrow: await bal(ESCROW) });
const testWalletCtx = async (browser: Browser, w: Wallet) => {
  const ctx = await browser.newContext();
  await ctx.exposeBinding("__drSign", (_s, _a: never, h: never) => w.sign(h));
  await ctx.addInitScript(`(() => { window.__e2eTestWallet = { nearAddress: ${JSON.stringify(w.address)}, signRawHash: (a, h) => window.__drSign(a, h) }; })();`);
  return ctx;
};
async function claimUsernameIfAsked(p: Page, who: string) {
  await p.waitForTimeout(3000);
  const input = p.getByTestId("username-input");
  await expect(input.or(p.getByTestId("create-offer-form")).or(p.getByTestId("nav-create")).or(p.getByTestId("bet-page")).or(p.getByTestId("take-section")).first()).toBeVisible({ timeout: 60_000 });
  if (!(await input.isVisible().catch(() => false))) return;
  if (await p.getByTestId("username-skip").count()) { await p.getByTestId("username-skip").click(); return; }
  const name = "dr8t" + Math.random().toString(16).slice(2, 10);
  await input.fill(name); await expect(p.getByTestId("username-claim-btn")).toBeEnabled({ timeout: 30_000 });
  await p.getByTestId("username-claim-btn").click(); await expect(input).toBeHidden({ timeout: 60_000 }); R[`username_${who}`] = `claimed ${name}`; save();
}
async function loginMaker(browser: Browser) {
  const ctx = await browser.newContext(), p = await ctx.newPage();
  await p.goto("/"); await ready(p);
  await p.getByTestId("email-input").fill(EMAIL); await p.getByTestId("send-code").click(); await p.waitForTimeout(2500);
  await p.getByTestId("otp-input").fill(OTP); await p.getByTestId("submit-code").click();
  await p.waitForFunction(() => !!(globalThis as { __e2e?: { nearAddress?: string } }).__e2e?.nearAddress, undefined, { timeout: 60_000 });
  return { p, addr: (await p.getByTestId("near-address").textContent())!.trim() };
}
async function waitOutcome(betId: number, minBonds: number, ms: number) {
  const t0 = Date.now(); let cur: BetView & Record<string, any> = await view("get_bet", { bet_id: betId });
  while (Date.now() - t0 < ms) { cur = await view("get_bet", { bet_id: betId }); if (cur.outcome != null && (cur.bonds?.length ?? 0) >= minBonds && ["Proposed", "Settled"].includes(cur.status) && (minBonds === 0 || cur.status === "Proposed")) return cur; await sleep(20_000); }
  return cur;
}

test("DR8: duplicate -> take -> round 1 -> losing side challenges (S13) -> round 2 -> finalize", async ({ browser }) => {
  test.setTimeout(PHASE === "open" ? 1_200_000 : 4 * 3_600_000);
  const cfg_ = await view("asset_limit", { token_id: process.env.DR8_ASSET ?? "" }).catch(() => null); void cfg_;

  if (PHASE === "open") {
    const tw = freshWallet(scratch()), sinceNs = BigInt(Date.now() - 60_000) * 1_000_000n;
    R.escrow = ESCROW; R.taker = tw.address; R.source_bet = SOURCE_BET; save();
    const { p: maker, addr: makerAddr } = await loginMaker(browser);
    R.maker = makerAddr; step("maker logged in (Privy)");
    if ((await bal(tw.address)) !== 0n) throw new Error("taker is not fresh");
    // the duplicate is an offer like any other: stakes need the betting balance
    tx("mint wNEAR to maker", await fundUsdc(makerAddr, STAKE + NEAR1 / 10n), "harness");
    tx("mint wNEAR to taker (stake + challenge bond headroom)", await fundUsdc(tw.address, STAKE + 2n * NEAR1), "harness");
    if ((await nearBal(makerAddr)) === "absent") tx("tNEAR to maker implicit", await fundNear(makerAddr, NEAR1 / 10n), "harness");
    tx("tNEAR to taker implicit", await fundNear(tw.address, NEAR1), "harness");
    await claimUsernameIfAsked(maker, "maker");
    const before = await bals(makerAddr, tw.address); R.balances_before = before; save();
    const tctx = await testWalletCtx(browser, tw), taker = await tctx.newPage();
    await taker.goto("/"); await ready(taker); await claimUsernameIfAsked(taker, "taker"); // pre-warm: funding deadline is floored at open+60 s

    // threshold chosen from live spot BEFORE any outcome exists; real price decides
    const spot = Number((await (await fetch("https://api.exchange.coinbase.com/products/BTC-USD/ticker")).json() as { price: string }).price);
    const raw = DIRECTION === "at_or_above" ? spot * (1 + PCT / 100) : spot * (1 - PCT / 100);
    const x = (DIRECTION === "at_or_above" ? Math.ceil(raw / 100) : Math.floor(raw / 100)) * 100;
    const dl = new Date(Math.ceil((Date.now() + WINDOW_MIN * 60_000) / 60_000) * 60_000);
    R.threshold = { direction: DIRECTION, x_usd: x, coinbase_spot_at_choice: spot, pct: Number(((x / spot - 1) * 100).toFixed(3)), deadline_utc: dl.toISOString() }; save();

    await maker.goto(`/bet/${SOURCE_BET}`); await ready(maker);
    await expect(maker.getByTestId("payout-screen")).toBeVisible({ timeout: 60_000 });
    await maker.getByTestId("payout-duplicate").click(); // FE-15 / S17
    await expect(maker.getByTestId("copied-banner")).toContainText("Copied from your bet of");
    R.duplicate_banner = await maker.getByTestId("copied-banner").innerText(); step("Duplicate this bet clicked on the payout screen of bet " + SOURCE_BET);
    await maker.getByTestId("guided-direction").selectOption(DIRECTION);
    await maker.getByTestId("guided-x_usd").fill(String(x));
    await maker.getByTestId("guided-deadline_utc").fill(dl.toISOString().slice(0, 16));
    await maker.getByTestId("fill-next").click();
    await maker.getByTestId("maker-amount").fill("3"); await maker.getByTestId("odds-input").fill("1");
    await maker.getByTestId("invite-by-link").check();
    await maker.getByTestId("settlement-period").selectOption("1h");
    await maker.getByTestId("review-offer").click();
    await expect(maker.getByTestId("review-card")).toBeVisible();
    R.review_text = (await maker.getByTestId("review-card").innerText()).slice(0, 2500); save();
    await maker.getByTestId("check-sources-btn").click();
    await expect(maker.getByTestId("source-check-status")).toContainText("The AI can read these sources.", { timeout: 240_000 });
    await expect(maker.getByTestId("open-offer-btn")).toBeEnabled({ timeout: 30_000 });
    const openClickMs = Date.now();
    await maker.getByTestId("open-offer-btn").click();
    await expect(maker.getByTestId("share-screen")).toBeVisible({ timeout: 120_000 });
    const betId = Number((await maker.getByTestId("share-link").inputValue()).match(/\/bet\/(\d+)/)![1]);
    R.betId = betId; step("maker opened the duplicated bet via web", { betId });
    tx("open (web, maker, via Duplicate)", await optText(maker.getByTestId("open-tx")), "web");
    const betOpen: BetView & Record<string, any> = await view("get_bet", { bet_id: betId });
    expect(betOpen.status).toBe("Open"); expect(Number((betOpen.envelope as Record<string, any>).settlement_period)).toBe(3_600_000_000_000);
    R.bet_open = betOpen; save();
    await maker.getByTestId("share-view-bet").click();
    await expect(maker.getByTestId("invite-section")).toBeVisible({ timeout: 30_000 });
    await maker.getByTestId("invite-invitee-input").fill(tw.address); await maker.getByTestId("invite-make-link").click();
    await expect(maker.getByTestId("invite-link-output")).toBeVisible();
    const inviteLink = (await maker.getByTestId("invite-link-output").inputValue().catch(async () => (await maker.getByTestId("invite-link-output").textContent()) ?? "")).trim();
    await taker.goto(inviteLink); await ready(taker); await claimUsernameIfAsked(taker, "taker");
    await expect(taker.getByTestId("take-open")).toBeEnabled({ timeout: 60_000 }); await taker.getByTestId("take-open").click();
    await expect(taker.getByTestId("take-next")).toBeEnabled({ timeout: 60_000 }); await taker.getByTestId("take-next").click();
    await expect(taker.getByTestId("take-confirm")).toBeEnabled({ timeout: 60_000 }); await taker.getByTestId("take-confirm").click();
    await expect(taker.getByTestId("take-result")).toHaveAttribute("data-kind", "taken", { timeout: 120_000 });
    tx("take (web, fresh taker)", await optText(taker.getByTestId("take-tx")), "web");
    const betTaken: BetView = await view("get_bet", { bet_id: betId });
    expect(betTaken.status).toBe("Taken"); expect(betTaken.taker).toBe(tw.address);
    fs.writeFileSync(path.join(RUN, "bet_taken.json"), JSON.stringify(betTaken, null, 2));
    const mid = await bals(makerAddr, tw.address); R.balances_after_take = mid;
    const openSecs = Math.ceil(openClickMs / 60_000) * 60, deadlineSecs = Math.floor(dl.getTime() / 1000);
    fs.writeFileSync(path.join(RUN, "ground_truth.json"), JSON.stringify({ written_at: new Date().toISOString(), bet_id: betId, status: "PENDING: fetched by the harness after T+2min, BEFORE any outcome is read", outcome_read_before_this: false }, null, 2));
    fs.writeFileSync(STATE, JSON.stringify({ betId, maker: makerAddr, taker: tw.address, sinceNs: sinceNs.toString(), deadlineSecs, openSecs, x, direction: DIRECTION, next_phase: "challenge",
      mid: Object.fromEntries(Object.entries(mid).map(([k, v]) => [k, v.toString()])), before: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.toString()])), fresh_taker: true }, null, 2));
    step("DR8 open phase done; resume after T with DR8_PHASE=challenge", { T: dl.toISOString() });
    return;
  }

  const st = JSON.parse(fs.readFileSync(STATE, "utf8")) as { betId: number; maker: string; taker: string; sinceNs: string; deadlineSecs: number; openSecs: number; x: number; direction: Direction; mid: Record<string, string>; challenger?: string; bond_quote?: string; round1?: Outcome };
  const betId = st.betId, tw = loadWallet(scratch());
  const mid = Object.fromEntries(Object.entries(st.mid).map(([k, v]) => [k, BigInt(v)])) as Record<"maker" | "taker" | "fee" | "escrow", bigint>;

  if (PHASE === "challenge") {
    while (Date.now() / 1000 < st.deadlineSecs + 120) await sleep(15_000);
    const pre: BetView = await view("get_bet", { bet_id: betId }); expect(pre.outcome ?? null).toBe(null);
    const truth = await computeTruth(st.direction, st.x, st.openSecs, st.deadlineSecs);
    fs.writeFileSync(path.join(RUN, "ground_truth.json"), JSON.stringify({ fetched_at: new Date().toISOString(), bet_id: betId, ...truth, outcome_read_before_this: false, bet_status_at_write: pre.status, bet_outcome_at_write: pre.outcome ?? null }, null, 2));
    R.ground_truth = truth; step("ground_truth.json written", { outcome: truth.outcome });
    // request_resolution: the keeper (KEEPSUBMIT1c) does it; give it 10 min, then the web button (taker) as a recorded fallback
    let cur = await waitOutcome(betId, 0, 10 * 60_000);
    if (cur.outcome == null) {
      const tctx = await testWalletCtx(browser, tw), taker = await tctx.newPage();
      await taker.goto(`/bet/${betId}`); await ready(taker); await claimUsernameIfAsked(taker, "taker");
      await expect(taker.getByTestId("request-result-btn")).toBeEnabled({ timeout: 60_000 }); await taker.getByTestId("request-result-btn").click();
      await sleep(15_000); tx("request_resolution (web fallback, taker)", await optText(taker.getByTestId("request-result-tx")), "web"); R.request_resolution_by = "web (keeper did not within 10 min)";
      cur = await waitOutcome(betId, 0, 45 * 60_000);
    } else R.request_resolution_by = "keeper";
    expect(cur.outcome).toBeTruthy(); const round1 = cur.outcome as Outcome;
    R.round1 = { outcome: round1, ground_truth: truth.outcome, matches_truth: round1 === truth.outcome, proposed_at: cur.proposed_at }; save();
    const bet0: BetView = JSON.parse(fs.readFileSync(path.join(RUN, "bet_taken.json"), "utf8"));
    const loser = loserOf(bet0, round1), challengerAcct = loser === "maker" ? st.maker : st.taker;
    const quote: any = await view("required_challenge_bond", { bet_id: betId, challenger: challengerAcct });
    R.bond_quote = quote; step("bond quoted", { loser, quote: String(quote?.amount) }); expect(quote).toBeTruthy();
    const balBefore = await bal(challengerAcct);
    let page: Page;
    if (loser === "taker") { const tctx = await testWalletCtx(browser, tw); page = await tctx.newPage(); await page.goto(`/bet/${betId}`); await ready(page); await claimUsernameIfAsked(page, "taker"); }
    else { const m = await loginMaker(browser); expect(m.addr).toBe(st.maker); page = m.p; await page.goto(`/bet/${betId}`); await ready(page); }
    if (BigInt(await nearBal(challengerAcct)) < NEAR1 / 5n) tx("tNEAR top-up for challenger", await fundNear(challengerAcct, NEAR1 / 2n), "harness");
    await expect(page.getByTestId("challenge-section")).toBeVisible({ timeout: 90_000 });
    R.s13 = { round: await page.getByTestId("challenge-round").innerText(), bond_line: await page.getByTestId("challenge-bond-line").innerText() }; save();
    await page.getByTestId("challenge-btn").click();
    R.s13.modal_terms = await page.getByTestId("challenge-terms").innerText(); save();
    await page.getByTestId("challenge-confirm").click();
    await expect(page.getByTestId("challenge-result")).toBeVisible({ timeout: 240_000 });
    R.s13.result = await page.getByTestId("challenge-result").innerText(); tx("challenge (web S13, losing side)", null, "web: see escrow tx list (the S13 screen shows no hash)"); save();
    const after = await view("get_bet", { bet_id: betId }) as BetView & Record<string, any>;
    const paid = BigInt(String(quote.amount)) - 0n, balAfter = await bal(challengerAcct);
    R.bond_paid_check = { quoted: String(quote.amount), challenger_balance_delta: (balBefore - balAfter).toString(), bonds: after.bonds }; save();
    expect(bondProblems({ quoted: BigInt(String(quote.amount)), paid: BigInt(String((after.bonds as any[])[0].amount)) })).toEqual([]); void paid;
    fs.writeFileSync(STATE, JSON.stringify({ ...st, challenger: challengerAcct, bond_quote: String(quote.amount), round1, next_phase: "finish" }, null, 2));
    step("DR8 challenge phase done; resume with DR8_PHASE=finish"); return;
  }

  if (PHASE === "finish") {
    const round1 = st.round1!, quote = BigInt(st.bond_quote!);
    // round 2: keeper requests + submits; wait for a new outcome with the bond on file and status Proposed again
    let cur: BetView & Record<string, any> = await view("get_bet", { bet_id: betId }); const t0 = Date.now(), trail: string[] = [];
    while (Date.now() - t0 < 60 * 60_000 && !(cur.runs_used >= 2 && cur.status === "Proposed")) { await sleep(20_000); cur = await view("get_bet", { bet_id: betId }); if (trail.at(-1) !== cur.status) trail.push(cur.status); }
    R.round2_trail = trail; R.round2 = { outcome: cur.outcome, status: cur.status, runs_used: cur.runs_used }; save();
    expect(cur.outcome).toBeTruthy();
    const gt = JSON.parse(fs.readFileSync(path.join(RUN, "ground_truth.json"), "utf8"));
    const flips = cur.outcome !== round1; R.what_happened = flips ? "FLIPS" : "ROUND 1 STANDS"; R.round2_matches_truth = cur.outcome === gt.outcome; save();
    expect(cur.outcome).toBe(gt.outcome);
    // finalize after the window (min(settlement_period, round window) from proposed_at): web button, else keeper
    const taker = await (await testWalletCtx(browser, tw)).newPage(); let finalized = false; const tF = Date.now();
    while (Date.now() - tF < 90 * 60_000) {
      await taker.goto(`/bet/${betId}`); await ready(taker);
      if (await taker.getByTestId("finalize-btn").isVisible().catch(() => false)) { try { await expect(taker.getByTestId("finalize-btn")).toBeEnabled({ timeout: 10_000 }); finalized = true; break; } catch { /* window open */ } }
      cur = await view("get_bet", { bet_id: betId }); if (cur.status === "Settled") break; await sleep(60_000);
    }
    if (finalized) { await taker.getByTestId("finalize-btn").click(); await sleep(15_000); tx("finalize (web, taker)", null, "web"); } else R.finalize_by = "keeper";
    for (let i = 0; i < 200 && !(await view("is_fully_paid", { bet_id: betId })); i++) await sleep(3000);
    const fin: BetView & Record<string, any> = await view("get_bet", { bet_id: betId }); R.bet_final = fin; save(); expect(fin.status).toBe("Settled");
    const lim: any = await view("asset_limit", { token_id: (JSON.parse(fs.readFileSync(path.join(RUN, "bet_taken.json"), "utf8")) as BetView).envelope.maker_asset });
    const runPrice = BigInt(String(lim?.run_price ?? "0"));
    const bet0: BetView = JSON.parse(fs.readFileSync(path.join(RUN, "bet_taken.json"), "utf8"));
    const e = expectedChallenge(bet0, { round1, final: fin.outcome as Outcome, bond: quote, runPrice });
    const after = await bals(st.maker, tw.address); R.balances_after = after;
    const wantTakerDelta = e.credits.taker - (e.challenger === "taker" ? quote : 0n);
    const bad = [ ...(after.taker - mid.taker !== wantTakerDelta ? [`taker delta ${after.taker - mid.taker} != ${wantTakerDelta}`] : []),
      ...checkPerBetMoney(e.settlement, { accounts: { maker: st.maker, taker: tw.address, fee: FEE }, credits: { [st.maker]: paidTo(e.settlement, "maker"), [tw.address]: paidTo(e.settlement, "taker"), [FEE]: paidTo(e.settlement, "fee") }, isFullyPaid: true }) ];
    R.money_check = { expected: Object.fromEntries(Object.entries(e.credits).map(([k, v]) => [k, v.toString()])), bond_result: e.bondResult, mismatches: bad }; save();
    expect(bad).toEqual([]);
    expect((await view("pending_payouts", { bet_id: betId })).filter((l: any) => !l.done)).toEqual([]);
    const hist = await escrowMethods(BigInt(st.sinceNs)); R.escrow_tx_methods = hist; save();
    expect(methodProblems(hist.flatMap((h) => h.methods))).toEqual([]);
    step("DR8 finish assertions passed", { what_happened: R.what_happened });
  }
});
