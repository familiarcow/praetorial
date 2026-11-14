// DR6 LIVE (testnet, real web UI, real Privy maker login, no mocks, no route interception, NO NEAR AI):
//  A. maker opens an AI btc_touch bet (far threshold) via the web, taker takes it via the invite link, the taker (loser) concedes
//     via the S12 confirm before any resolution request. Money asserted from chain views (get_bet + side_fee), tx list asserted
//     to contain no submit_outcome / request_resolution. ground_truth.json is written before any outcome is read.
//  B. maker opens a second offer and cancels it untaken: full refund incl. storage.
// Run (from apps/web): npx playwright test -c ../../services/e2e/live-DR/harness/playwright.live.config.ts --project maker DR6
import { test, expect, type Page } from "./pw.js";
import fs from "node:fs";
import path from "node:path";
import { checkObserved, loadFeeConfig, sideFee } from "../harness/money.js";
import { expectedConcedeByTaker, expectedCancelRefund, forbiddenCalls, paidTo, type BetView } from "./expected.js";
import { ESCROW, FEE, view, bal, nearBal, takerWallet, fundUsdc, fundNear, escrowMethods, sleep } from "./chain.js";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const RUN = path.join(DIR, "run");
fs.mkdirSync(RUN, { recursive: true });
const R: Record<string, any> = { txs: [], steps: [] };
const save = () => fs.writeFileSync(path.join(RUN, "results.json"), JSON.stringify(R, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
const step = (s: string, extra: Record<string, unknown> = {}) => { R.steps.push({ s, t: new Date().toISOString(), ...extra }); save(); };
const tx = (s: string, hash: string | null) => { R.txs.push({ step: s, hash, url: hash ? `https://testnet.nearblocks.io/txns/${hash}` : null }); save(); };
const EMAIL = process.env.PRIVY_TEST_EMAIL!, OTP = process.env.PRIVY_TEST_OTP!; // used only to fill the form; never logged or stored
const NEAR1 = 10n ** 24n, STAKE = 3n * NEAR1; // 3 NEAR per side (testnet NEAR min stake is 2.717) (UI offers NEAR only, see chain.ts)

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
async function createFarBtcTouch(p: Page): Promise<{ betId: number; link: string; terms_hash: string }> {
  await p.getByTestId("nav-create").click();
  await expect(p.getByTestId("create-offer-form")).toBeVisible();
  await p.getByTestId("bet-type-card-btc_touch").click();
  const dl = new Date(Date.now() + 4 * 3_600_000); dl.setUTCSeconds(0, 0);
  await p.getByTestId("guided-direction").selectOption("at_or_above");
  await p.getByTestId("guided-x_usd").fill("1000000"); // far threshold: nobody expects a ruling
  await p.getByTestId("guided-deadline_utc").fill(dl.toISOString().slice(0, 16));
  await p.getByTestId("fill-next").click();
  await p.getByTestId("maker-amount").fill("3");
  await p.getByTestId("odds-input").fill("1");
  await p.getByTestId("invite-by-link").check();
  await p.getByTestId("review-offer").click();
  await expect(p.getByTestId("review-card")).toBeVisible();
  const terms_hash = ((await p.getByTestId("review-terms-hash").locator("code").textContent()) ?? "").trim();
  await p.getByTestId("check-sources-btn").click();
  await expect(p.getByTestId("source-check-status")).toContainText("The AI can read these sources.", { timeout: 240_000 });
  await expect(p.getByTestId("open-offer-btn")).toBeEnabled({ timeout: 30_000 });
  await p.getByTestId("open-offer-btn").click();
  await expect(p.getByTestId("share-screen")).toBeVisible({ timeout: 120_000 });
  const link = await p.getByTestId("share-link").inputValue();
  const betId = Number(link.match(/\/bet\/(\d+)/)![1]);
  return { betId, link, terms_hash };
}

test("DR6: AI bet, loser concedes, no ruling, no NEAR AI; plus untaken cancel refund", async ({ browser }) => {
  test.setTimeout(1_500_000);
  const cfg = loadFeeConfig();
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
  await skipUsername(maker, `dr6mk${Date.now().toString(36)}`);

  // ---- rehearsal faucet (mock USDC mint + a little tNEAR so the implicit accounts exist), outside the UI
  const needM = 2n * (STAKE + NEAR1 / 10n); // two offers + storage headroom
  tx("mint mock wNEAR (betting balance) to maker", await fundUsdc(makerAddr, needM));
  tx("mint mock wNEAR (betting balance) to taker", await fundUsdc(tw.address, STAKE + NEAR1 / 10n));
  if ((await nearBal(makerAddr)) === "absent") tx("tNEAR to maker implicit", await fundNear(makerAddr, 100_000_000_000_000_000_000_000n));
  if ((await nearBal(tw.address)) === "absent") tx("tNEAR to taker implicit", await fundNear(tw.address, 100_000_000_000_000_000_000_000n));
  const before = { maker: await bal(makerAddr), taker: await bal(tw.address), fee: await bal(FEE), escrow: await bal(ESCROW) };
  R.balances_before = before; save();

  // ---- A1 maker opens (web)
  const A = await createFarBtcTouch(maker);
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
  await maker.getByTestId("share-view-bet").click();
  await expect(maker.getByTestId("invite-section")).toBeVisible({ timeout: 30_000 });
  await maker.getByTestId("invite-invitee-input").fill(tw.address);
  await maker.getByTestId("invite-make-link").click();
  await expect(maker.getByTestId("invite-link-output")).toBeVisible();
  const inviteLink = (await maker.getByTestId("invite-link-output").inputValue().catch(async () => (await maker.getByTestId("invite-link-output").textContent()) ?? "")).trim();
  R.invite_link_has_sig = /inv|sig/i.test(inviteLink); step("maker made the taker's invite link");
  await taker.goto(inviteLink); await ready(taker); await skipUsername(taker, `dr6tk${Date.now().toString(36)}`);
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
  const exp = expectedConcedeByTaker(betTaken as BetView, cfg.feeBps, undefined);
  const f = sideFee(STAKE, cfg.feeBps, BigInt(betTaken.fee_min_maker));
  expect(paidTo(exp, "maker")).toBe(2n * STAKE - 2n * f);
  // deltas relative to the post-take balances (what the payout moved)
  const deltas = { maker: after.maker - mid.maker, taker: after.taker - mid.taker, fee: after.fee - mid.fee };
  const bad = checkObserved(exp, deltas, { escrowAfter: after.escrow - before.escrow });
  R.money_check = { expected: exp.lines, deltas, mismatches: bad }; save();
  expect(bad).toEqual([]);
  expect(await view("is_fully_paid", { bet_id: A.betId })).toBe(true);
  expect(fin.status).toBe("Settled");
  expect(fin.outcome).toBe("YES"); // maker_side YES, taker conceded
  expect((await view("pending_payouts", { bet_id: A.betId })).filter((l: any) => !l.done)).toEqual([]);

  // ---- A5 tx list: no submit_outcome / request_resolution (no NEAR AI path)
  await sleep(4000);
  const hist = await escrowMethods(sinceNs);
  R.escrow_tx_methods = hist; save();
  expect(forbiddenCalls(hist.flatMap((h) => h.methods))).toEqual([]);
  expect(hist.flatMap((h) => h.methods)).toContain("concede");

  // ---- B maker opens a second offer and cancels it untaken
  const mBeforeB = await bal(makerAddr);
  await maker.getByTestId("nav-create").click();
  const B = await createFarBtcTouch(maker);
  R.B = B; step("B: maker opened second offer", { betId: B.betId });
  const betB: BetView = await view("get_bet", { bet_id: B.betId });
  expect(betB.status).toBe("Open");
  const mOpenB = await bal(makerAddr);
  const refund = expectedCancelRefund(betB);
  expect(mBeforeB - mOpenB).toBe(refund.maker); // the deposit taken at open = stake + storage
  await maker.getByTestId("share-view-bet").click();
  await expect(maker.getByTestId("cancel-bet")).toBeVisible({ timeout: 30_000 });
  await maker.getByTestId("cancel-bet").click();
  await maker.getByTestId("cancel-confirm").click();
  await expect(maker.getByTestId("cancel-result")).toBeVisible({ timeout: 180_000 });
  tx("cancel (web, maker)", await maker.getByTestId("cancel-tx").textContent().catch(() => null));
  for (let i = 0; i < 40 && !(await view("is_fully_paid", { bet_id: B.betId })); i++) await sleep(3000);
  const finB: BetView = await view("get_bet", { bet_id: B.betId });
  const mAfterB = await bal(makerAddr);
  R.B_bet_final = finB; R.B_money = { before_open: mBeforeB, after_open: mOpenB, after_cancel: mAfterB, expected_refund: refund.maker }; save();
  expect(finB.status).toBe("Cancelled");
  expect(mAfterB).toBe(mBeforeB); // full refund incl. storage
  expect(await view("is_fully_paid", { bet_id: B.betId })).toBe(true);
  expect(await bal(FEE)).toBe(after.fee); // cancel paid the fee account nothing
  R.balances_final = { maker: await bal(makerAddr), taker: await bal(tw.address), fee: await bal(FEE), escrow: await bal(ESCROW) }; save();
  step("DR6 live assertions passed");
});
