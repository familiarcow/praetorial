// RFRZ2c LIVE (testnet, frz3 escrow, deployed web, real Privy maker login, NO NEAR AI): ONE AI btc_touch bet, event window > 5 h,
// staked in nep141:wrap.testnet. Live sourcecheck must pass, review card must show a real storage line (screenshot),
// taker takes via invite link, taker concedes (S12). Money asserted from chain views; tx list must hold no request_resolution/submit_outcome.
// Run (from apps/web): PLAYWRIGHT_BASE_URL=https://praetorial-web-testnet.familiarcow.workers.dev npx playwright test -c ../../services/e2e/live-RFRZ2c/playwright.live.config.ts --project=maker RFRZ2c
import { test, expect, type Page } from "../live-DR/DR6/pw.js";
import fs from "node:fs";
import path from "node:path";
import { checkObserved } from "../live-DR/harness/money.js";
import { forbiddenCalls, type BetView } from "../live-DR/DR6/expected.js";
import { ESCROW, FEE, view, bal, nearBal, takerWallet, fundUsdc, fundNear, escrowMethods, sleep } from "../live-DR/DR6/chain.js";
import { expectedMoney, windowDeadlineUtc, storageLineIsReal, STAKE_TOKEN_ID, WINDOW_HOURS } from "./plan.js";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const RUN = path.join(DIR, "run");
fs.mkdirSync(RUN, { recursive: true });
const R: Record<string, any> = { txs: [], steps: [] };
const save = () => fs.writeFileSync(path.join(RUN, "results.json"), JSON.stringify(R, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
const step = (s: string, extra: Record<string, unknown> = {}) => { R.steps.push({ s, t: new Date().toISOString(), ...extra }); save(); };
const tx = (s: string, hash: string | null) => { R.txs.push({ step: s, hash, url: hash ? `https://testnet.nearblocks.io/txns/${hash}` : null }); save(); };
const EMAIL = process.env.PRIVY_TEST_EMAIL!, OTP = process.env.PRIVY_TEST_OTP!; // only to fill the form; never logged or stored
const NEAR1 = 10n ** 24n, STAKE = 3n * NEAR1;
interface Shot { screenshot(o: { path: string }): Promise<unknown> }

async function ready(p: Page) { await p.waitForFunction(() => (globalThis as { __e2e?: { ready?: boolean } }).__e2e?.ready === true, undefined, { timeout: 30_000 }); }
async function skipUsername(p: Page, name: string) {
  // first-login username step (real registry Worker, NEP-413 claim signed through the same wallet path)
  const input = p.getByTestId("username-input"), form = p.getByTestId("create-offer-form");
  await expect(input.or(form).or(p.getByTestId("nav-create")).or(p.getByTestId("bet-page")).or(p.getByTestId("take-section")).first()).toBeVisible({ timeout: 60_000 });
  if (await input.isVisible().catch(() => false)) {
    await input.fill(name);
    await expect(p.getByTestId("username-claim-btn")).toBeEnabled({ timeout: 30_000 });
    await p.getByTestId("username-claim-btn").click();
    await expect(input.or(p.getByTestId("username-error")).first()).toBeHidden({ timeout: 1 }).catch(() => {});
    await p.waitForTimeout(8000);
    if (await input.isVisible().catch(() => false)) {
      const err = await p.getByTestId("username-error").textContent().catch(() => null);
      const st = await p.getByTestId("username-status").textContent().catch(() => null);
      // FINDING (not an assertion DR6 depends on): the live registry refuses the claim (see R.registry_claim_response). DR6 needs no username,
      // so the app's own "Skip for now" path is used; the finding is recorded and reported.
      (R.findings ??= []).push({ who: name, claim_error: err, status: st, registry: R.registry_claim_response }); save();
      await p.getByTestId("username-skip").click();
    }
  }
}
async function createBet(p: Page): Promise<{ betId: number; link: string; terms_hash: string }> {
  await p.getByTestId("nav-create").click();
  await expect(p.getByTestId("create-offer-form")).toBeVisible();
  await p.getByTestId("bet-type-card-btc_touch").click();
  const deadline = windowDeadlineUtc(new Date());
  R.window = { hours: WINDOW_HOURS, deadline_utc: deadline }; save();
  await p.getByTestId("guided-direction").selectOption("at_or_above");
  await p.getByTestId("guided-x_usd").fill("1000000"); // far threshold: nobody expects a ruling
  await p.getByTestId("guided-deadline_utc").fill(deadline);
  await p.getByTestId("fill-next").click();
  await p.getByTestId("maker-amount").fill("3");
  await p.getByTestId("odds-input").fill("1");
  await p.getByTestId("invite-by-link").check();
  await p.getByTestId("review-offer").click();
  await expect(p.getByTestId("review-card")).toBeVisible();
  // storage line must be a real NEAR amount (STG1b); wait for the contract read, then screenshot the card
  const storageCell = p.getByTestId("review-pay-storage");
  for (let i = 0; i < 40; i++) { if (storageLineIsReal(((await storageCell.textContent()) ?? ""))) break; await p.waitForTimeout(1500); }
  R.review_storage_text = ((await storageCell.textContent()) ?? "").trim();
  R.review_pay_now_text = ((await p.getByTestId("review-pay-now").textContent()) ?? "").trim(); save();
  expect(storageLineIsReal(R.review_storage_text)).toBe(true);
  await (p.getByTestId("review-card") as unknown as Shot).screenshot({ path: path.join(RUN, "review_card_storage_line.png") });
  const terms_hash = ((await p.getByTestId("review-terms-hash").locator("code").textContent()) ?? "").trim();
  await p.getByTestId("check-sources-btn").click();
  await expect(p.getByTestId("source-check-status")).toContainText("The AI can read these sources.", { timeout: 240_000 });
  R.sourcecheck_status = ((await p.getByTestId("source-check-status").textContent()) ?? "").trim(); save();
  await expect(p.getByTestId("open-offer-btn")).toBeEnabled({ timeout: 30_000 });
  await p.getByTestId("open-offer-btn").click();
  await expect(p.getByTestId("share-screen")).toBeVisible({ timeout: 120_000 });
  const link = await p.getByTestId("share-link").inputValue();
  const betId = Number(link.match(/\/bet\/(\d+)/)![1]);
  return { betId, link, terms_hash };
}

test("RFRZ2c: AI wNEAR btc_touch bet, >5h window, frz3, taker concedes, no NEAR AI", async ({ browser }) => {
  test.setTimeout(1_500_000);
  const tw = takerWallet();
  const sinceNs = BigInt(Date.now() - 60_000) * 1_000_000n;
  R.escrow = ESCROW; R.taker = tw.address; save();

  // ---- maker: real Privy login
  const mctx = await browser.newContext();
  const maker = await mctx.newPage();
  maker.on("response", async (r) => { if (/registry|\/claim/.test(r.url()) && r.request().method() === "POST") R.registry_claim_response = { status: r.status(), body: (await r.text().catch(() => "")).slice(0, 300) }; save(); });
  maker.on("response", async (r) => { if (/workers\.dev/.test(r.url())) { (R.relayer_responses ??= []).push({ url: r.url().replace(/\?.*/, ""), method: r.request().method(), status: r.status(), body: (await r.text().catch(() => "")).slice(0, 400) }); save(); } });
  maker.on("requestfailed", (q) => { if (/workers\.dev/.test(q.url())) { (R.failed_requests ??= []).push({ url: q.url(), err: q.failure()?.errorText }); save(); } });
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
  await skipUsername(maker, `rf2cmk${Date.now().toString(36)}`);

  // ---- rehearsal faucet (mock USDC mint + a little tNEAR so the implicit accounts exist), outside the UI
  const needM = STAKE + NEAR1 / 10n; // one offer + storage headroom
  if (!process.env.RFRZ2C_RESUME_BET) tx("mint mock wNEAR (betting balance) to maker", await fundUsdc(makerAddr, needM));
  if (!process.env.RFRZ2C_RESUME_BET) tx("mint mock wNEAR (betting balance) to taker", await fundUsdc(tw.address, STAKE + NEAR1 / 10n));
  if ((await nearBal(makerAddr)) === "absent") tx("tNEAR to maker implicit", await fundNear(makerAddr, 100_000_000_000_000_000_000_000n));
  if ((await nearBal(tw.address)) === "absent") tx("tNEAR to taker implicit", await fundNear(tw.address, 100_000_000_000_000_000_000_000n));
  const b0 = process.env.RFRZ2C_RESUME_BET ? JSON.parse(fs.readFileSync(path.join(RUN, "results_run1_opened_bet3_take_selectors_stale.json"), "utf8")).balances_before : { maker: await bal(makerAddr), taker: await bal(tw.address), fee: await bal(FEE), escrow: await bal(ESCROW) };
  const before = { maker: BigInt(b0.maker), taker: BigInt(b0.taker), fee: BigInt(b0.fee), escrow: BigInt(b0.escrow) };
  R.balances_before = before; save();

  // ---- A1 maker opens (web)
  // RESUME: run 1 opened bet 3 on the live web (storage line + sourcecheck evidenced in run/results_run1_*.json) and then hit a stale take selector.
  const RESUME = process.env.RFRZ2C_RESUME_BET ? Number(process.env.RFRZ2C_RESUME_BET) : 0;
  const A = RESUME ? { betId: RESUME, link: `/bet/${RESUME}`, terms_hash: "" } : await createBet(maker);
  if (RESUME) { // the invite secret lives in the first run's browser localStorage, so the orphan bet is cancelled (untaken => full refund) and a fresh run is done
    await maker.goto(`/bet/${RESUME}`); await ready(maker);
    await expect(maker.getByTestId("cancel-bet")).toBeVisible({ timeout: 60_000 });
    await maker.getByTestId("cancel-bet").click(); await maker.getByTestId("cancel-confirm").click();
    await expect(maker.getByTestId("cancel-result")).toBeVisible({ timeout: 180_000 });
    tx(`cancel orphan bet ${RESUME} (web, maker)`, await maker.getByTestId("cancel-tx").textContent().catch(() => null));
    R.orphan_bet_final = await view("get_bet", { bet_id: RESUME }); R.balances_after_orphan_cancel = { maker: await bal(makerAddr) }; save();
    return;
  }
  R.A = A; step("A: maker opened via web", { betId: A.betId });
  const betOpen: BetView = await view("get_bet", { bet_id: A.betId });
  expect(betOpen.status).toBe("Open");
  R.A_bet_open = betOpen; save();

  // ---- A2 taker takes via the invite link. The invite link carries the personal signature (maker generates it on the bet page).
  const tctx = await browser.newContext();
  await tctx.exposeBinding("__drSign", (_s, _address: never, hashHex: never) => tw.sign(hashHex));
  await tctx.addInitScript(`(() => { window.__e2eTestWallet = { nearAddress: ${JSON.stringify(tw.address)}, signRawHash: (a, h) => window.__drSign(a, h) }; })();`);
  const taker = await tctx.newPage();
  taker.on("response", async (r) => { if (/registry|\/claim/.test(r.url()) && r.request().method() === "POST") R.registry_claim_response_taker = { status: r.status(), body: (await r.text().catch(() => "")).slice(0, 300) }; save(); });
  // maker generates the personal link for the taker on the bet page (IN1)
  if (!RESUME) await maker.getByTestId("share-view-bet").click();
  await expect(maker.getByTestId("invite-section")).toBeVisible({ timeout: 30_000 });
  await maker.getByTestId("invite-invitee-input").fill(tw.address);
  await maker.getByTestId("invite-make-link").click();
  await expect(maker.getByTestId("invite-link-output")).toBeVisible();
  const inviteLink = (await maker.getByTestId("invite-link-output").inputValue().catch(async () => (await maker.getByTestId("invite-link-output").textContent()) ?? "")).trim();
  R.invite_link_has_sig = /inv|sig/i.test(inviteLink); step("maker made the taker's invite link");
  await taker.goto(inviteLink); await ready(taker); await skipUsername(taker, `rf2ctk${Date.now().toString(36)}`);
  await expect(taker.getByTestId("take-open")).toBeEnabled({ timeout: 60_000 });
  await taker.getByTestId("take-open").click();
  await expect(taker.getByTestId("take-next")).toBeEnabled({ timeout: 60_000 });
  await taker.getByTestId("take-next").click();
  await expect(taker.getByTestId("take-confirm")).toBeEnabled({ timeout: 60_000 });
  await taker.getByTestId("take-confirm").click();
  await expect(taker.getByTestId("take-result")).toHaveAttribute("data-kind", "taken", { timeout: 120_000 });
  tx("take (web, taker)", (await taker.getByTestId("take-tx").textContent().catch(() => null)) );
  step("A: taker took via invite link");
  const betTaken: BetView = await view("get_bet", { bet_id: A.betId });
  expect(betTaken.status).toBe("Taken"); expect(betTaken.taker).toBe(tw.address);
  R.A_bet_taken = betTaken;

  // ---- ground truth BEFORE any outcome is read: far threshold, so the decisive truth is NO touch (Kraken/Coinbase high << $1,000,000)
  const gt = { written_at: new Date().toISOString(), bet_id: A.betId, claim: "BTC at_or_above 1000000 USD before the deadline", expected_by_ground_truth: "NO touch (BTC trades far below $1,000,000)",
    note: "Written before any outcome/ruling is read. DR6 expects no ruling at all: the taker concedes first.", outcome_read_before_this: false, bet_outcome_at_write: betTaken.outcome ?? null };
  fs.writeFileSync(path.join(RUN, "ground_truth.json"), JSON.stringify(gt, null, 2));
  const dTaker = before.taker, dMaker = before.maker; void dTaker; void dMaker;
  const mid = { maker: await bal(makerAddr), taker: await bal(tw.address), fee: await bal(FEE), escrow: await bal(ESCROW) };
  R.balances_after_take = mid; save();

  // ---- A3 taker (loser) concedes via S12 confirm
  await taker.goto(`/bet/${A.betId}`); await ready(taker);
  await expect(taker.getByTestId("concede-btn")).toBeEnabled({ timeout: 60_000 });
  let dialogMsg = "";
  taker.once("dialog", async (d) => { dialogMsg = d.message(); await d.accept(); });
  await taker.getByTestId("concede-btn").click();
  await expect(taker.getByTestId("concede-result")).toHaveAttribute("data-kind", "conceded", { timeout: 180_000 });
  R.concede_dialog = dialogMsg; step("A: taker conceded via S12 confirm", { dialog: dialogMsg });
  expect(dialogMsg).toContain("Your side loses");
  tx("concede (web, taker)", (await taker.getByTestId("concede-tx").textContent().catch(() => null)));
  for (let i = 0; i < 40 && !(await view("is_fully_paid", { bet_id: A.betId })); i++) await sleep(3000);
  const fin: BetView & Record<string, any> = await view("get_bet", { bet_id: A.betId });
  R.A_bet_final = fin; save();

  // ---- A4 money assertions from chain views
  const after = { maker: await bal(makerAddr), taker: await bal(tw.address), fee: await bal(FEE), escrow: await bal(ESCROW) };
  R.balances_after_concede = after;
  const exp = expectedMoney(betTaken as BetView);
  expect(exp.escrowResidue).toBe(0n);
  const deltas = { maker: after.maker - mid.maker, taker: after.taker - mid.taker, fee: after.fee - mid.fee };
  R.expected_money = exp; R.deltas = deltas;
  const bad: string[] = [];
  if (deltas.maker !== exp.maker) bad.push(`maker delta ${deltas.maker} != ${exp.maker}`);
  if (deltas.taker !== exp.taker) bad.push(`taker delta ${deltas.taker} != ${exp.taker}`);
  if (deltas.fee !== exp.fee) bad.push(`fee delta ${deltas.fee} != ${exp.fee}`);
  if (after.escrow !== before.escrow) bad.push(`escrow ${after.escrow} != before ${before.escrow}`);
  R.money_check = { mismatches: bad }; save();
  expect(bad).toEqual([]);
  expect(await view("is_fully_paid", { bet_id: A.betId })).toBe(true);
  expect(fin.status).toBe("Settled");
  expect(fin.outcome).toBe("YES"); // maker_side YES, taker conceded
  R.is_fully_paid = true; R.pending_payouts_final = await view("pending_payouts", { bet_id: A.betId });
  expect((await view("pending_payouts", { bet_id: A.betId })).filter((l: any) => !l.done)).toEqual([]);

  // ---- A5 tx list: no submit_outcome / request_resolution (no NEAR AI path)
  await sleep(4000);
  const hist = await escrowMethods(sinceNs);
  R.escrow_tx_methods = hist; save();
  expect(forbiddenCalls(hist.flatMap((h) => h.methods))).toEqual([]);
  expect(hist.flatMap((h) => h.methods)).toContain("concede");

  R.balances_final = { maker: await bal(makerAddr), taker: await bal(tw.address), fee: await bal(FEE), escrow: await bal(ESCROW) }; save();
  void STAKE_TOKEN_ID; void checkObserved; void nearBal;
  step("RFRZ2c live assertions passed");
});
