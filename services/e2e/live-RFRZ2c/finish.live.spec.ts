// RFRZ2c LIVE (testnet, frz3 escrow, deployed web, real Privy maker login, NO NEAR AI): ONE AI btc_touch bet, event window > 5 h,
// staked in nep141:wrap.testnet. Live sourcecheck must pass, review card must show a real storage line (screenshot),
// taker takes via invite link, taker concedes (S12). Money asserted from chain views; tx list must hold no request_resolution/submit_outcome.
// Run (from apps/web): PLAYWRIGHT_BASE_URL=https://praetorial-web-testnet.familiarcow.workers.dev npx playwright test -c ../../services/e2e/live-RFRZ2c/playwright.live.config.ts --project=maker RFRZ2c
import { test, expect, type Page, type Locator } from "../live-DR/DR6/pw.js";
import fs from "node:fs";
import path from "node:path";
import { checkObserved } from "../live-DR/harness/money.js";
import { forbiddenCalls, type BetView } from "../live-DR/DR6/expected.js";
import { ESCROW, FEE, view, bal, nearBal, takerWallet, fundUsdc, fundNear, escrowMethods, sleep } from "../live-DR/DR6/chain.js";
import { findTxByMethod, expectedMoney, windowDeadlineUtc, storageLineIsReal, STAKE_TOKEN_ID, WINDOW_HOURS } from "./plan.js";

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
// FINISH run: bet opened + taken by RFRZ2c.live.spec.ts run 3 (bet 5); the concede confirm is now an in-app modal, not window.confirm.
const PREV = JSON.parse(fs.readFileSync(path.join(RUN, "results_run3_bet5_taken_concede_modal_selector_stale.json"), "utf8"));
test("RFRZ2c finish: taker concedes taken bet via the S12 modal, money + payout checks", async ({ browser }) => {
  test.setTimeout(900_000);
  const tw = takerWallet(); const sinceNs = BigInt(Date.parse(PREV.steps[0].t) - 60_000) * 1_000_000n;
  Object.assign(R, { escrow: ESCROW, taker: tw.address, maker: PREV.maker, A: PREV.A, txs: PREV.txs, steps: PREV.steps, A_bet_open: PREV.A_bet_open, A_bet_taken: PREV.A_bet_taken, balances_before: PREV.balances_before, balances_after_take: PREV.balances_after_take, review_storage_text: PREV.review_storage_text, review_pay_now_text: PREV.review_pay_now_text, sourcecheck_status: PREV.sourcecheck_status, window: PREV.window });
  const A = PREV.A, makerAddr: string = PREV.maker;
  const before = Object.fromEntries(Object.entries(PREV.balances_before).map(([k, v]) => [k, BigInt(v as string)])) as Record<"maker" | "taker" | "fee" | "escrow", bigint>;
  const mid = Object.fromEntries(Object.entries(PREV.balances_after_take).map(([k, v]) => [k, BigInt(v as string)])) as Record<"maker" | "taker" | "fee" | "escrow", bigint>;
  const betTaken: BetView = await view("get_bet", { bet_id: A.betId });
  expect(betTaken.status).toBe("Taken");
  const tctx = await browser.newContext();
  await tctx.exposeBinding("__drSign", (_s, _address: never, hashHex: never) => tw.sign(hashHex));
  await tctx.addInitScript(`(() => { window.__e2eTestWallet = { nearAddress: ${JSON.stringify(tw.address)}, signRawHash: (a, h) => window.__drSign(a, h) }; })();`);
  const taker = await tctx.newPage();
  await taker.goto(`/bet/${A.betId}`); await ready(taker);
  await expect(taker.getByTestId("concede-btn")).toBeEnabled({ timeout: 60_000 });
  await taker.getByTestId("concede-btn").click();
  const dlg = (taker as unknown as { getByRole(r: string, o: object): Locator & { getByRole(r: string, o: object): Locator } }).getByRole("dialog", { name: "Concede this bet" });
  await expect(dlg).toBeVisible();
  const dialogMsg = ((await dlg.textContent()) ?? "").replace(/\s+/g, " "); R.concede_dialog = dialogMsg;
  expect(dialogMsg).toContain("Your side loses");
  await dlg.getByRole("button", { name: /Concede and pay/ }).click();
  await expect(taker.getByTestId("concede-result")).toHaveAttribute("data-kind", "conceded", { timeout: 180_000 });
  step("A: taker conceded via S12 modal");
  // the web renders no concede-tx element (RFRZ2d): the hash is read from chain history below via findTxByMethod

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
  tx("concede (web, taker)", findTxByMethod(hist, "concede") ?? null);

  R.balances_final = { maker: await bal(makerAddr), taker: await bal(tw.address), fee: await bal(FEE), escrow: await bal(ESCROW) }; save();
  void STAKE_TOKEN_ID; void checkObserved; void nearBal;
  step("RFRZ2c live assertions passed");
});
