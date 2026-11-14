// DR5 LIVE (testnet, real web UI, real Privy maker login, no mocks, no route interception, NO NEAR AI):
//  Human-mode btc_touch bet. Referee = a third harness test account picked BY USERNAME in the maker's referee picker (registry lookup,
//  WEBREG1). Maker ticks the tip, taker does not. Taker takes through the maker's personal invite link (IN1/TK1). After the funding
//  deadline the referee opens the bet in the web app and rules YES on the referee screen (relayer referee_rule, D-REFREL1).
//  Expected: maker paid at once (no settlement window), referee gets exactly the maker's side_fee tip (taker did not tick), no challenge button.
//  Money is asserted from chain views (get_bet + side_fee via harness money.ts), never from the UI. ground_truth.json is written
//  BEFORE the ruling/outcome is read. Run (from apps/web, dev server on :3000):
//    DR5_REF_USERNAME=<name> npx playwright test -c ../../services/e2e/live-DR/harness/playwright.live.config.ts --project maker DR5
import { test, expect, type Page, type Browser } from "./pw.js";
import fs from "node:fs";
import path from "node:path";
import { checkObserved, loadFeeConfig } from "../harness/money.js";
import { expectedRefereeYes, forbiddenCalls, paidTo, escrowBaseline, functionCallGas, REQUIRED_METHODS, type BetView } from "./expected.js";
import { ESCROW, FEE, view, bal, nearBal, wallet, fundUsdc, fundNear, escrowMethods, sleep, lookupUsername } from "./chain.js";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const RUN = path.join(DIR, "run");
fs.mkdirSync(RUN, { recursive: true });
const R: Record<string, any> = { txs: [], steps: [] };
const save = () => fs.writeFileSync(path.join(RUN, "results.json"), JSON.stringify(R, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
const step = (s: string, extra: Record<string, unknown> = {}) => { R.steps.push({ s, t: new Date().toISOString(), ...extra }); save(); };
const tx = (s: string, hash: string | null) => { R.txs.push({ step: s, hash, url: hash ? `https://testnet.nearblocks.io/txns/${hash}` : null }); save(); };
const EMAIL = process.env.PRIVY_TEST_EMAIL!, OTP = process.env.PRIVY_TEST_OTP!; // used only to fill the form; never logged or stored
const REF_NAME = process.env.DR5_REF_USERNAME!;
const NEAR1 = 10n ** 24n, STAKE = 3n * NEAR1; // 3 NEAR per side (testnet NEAR min stake 2.717); wNEAR betting balance
const LEAD_MIN = 9; // funding deadline = event deadline = now + LEAD_MIN (referee_rule needs now >= funding_deadline)

async function ready(p: Page) { await p.waitForFunction(() => (globalThis as { __e2e?: { ready?: boolean } }).__e2e?.ready === true, undefined, { timeout: 30_000 }); }
async function claimUsernameIfAsked(p: Page, name: string, who: string) {
  const input = p.getByTestId("username-input");
  await expect(input.or(p.getByTestId("create-offer-form")).or(p.getByTestId("nav-create")).or(p.getByTestId("bet-page")).or(p.getByTestId("take-section")).first()).toBeVisible({ timeout: 60_000 });
  if (!(await input.isVisible().catch(() => false))) return;
  let resp: unknown = null;
  p.on("response", async (r) => { if (/\/claim$/.test(r.url()) && r.request().method() === "POST") resp = { status: r.status(), body: (await r.text().catch(() => "")).slice(0, 300), url: r.url() }; });
  await input.fill(name);
  await expect(p.getByTestId("username-claim-btn")).toBeEnabled({ timeout: 30_000 });
  await p.getByTestId("username-claim-btn").click();
  await p.waitForTimeout(10_000);
  if (await input.isVisible().catch(() => false)) {
    const err = await p.getByTestId("username-error").textContent().catch(() => null);
    (R.findings ??= []).push({ who, step: "first-login username claim through the web UI", ui_error: err, registry_response: resp, skip_button_present: await p.getByTestId("username-skip").count() });
    save();
    // FINDING recorded (web: UsernameStep sends publicKey = raw account hex, registry wants "ed25519:<base58>"; REGISTRY_ID may also differ from the Worker's).
    // The app's own "Skip for now" is offered after the failure; DR5 needs the REFEREE findable, not the maker/taker, so that path is used.
    await expect(p.getByTestId("username-skip")).toBeVisible({ timeout: 10_000 });
    await p.getByTestId("username-skip").click();
  }
  R.username_claimed = { ...(R.username_claimed ?? {}), [who]: { name, registry_response: resp } }; save();
}
const testWalletCtx = async (browser: Browser, w: ReturnType<typeof wallet>) => {
  const ctx = await browser.newContext();
  await ctx.exposeBinding("__drSign", (_s, _address: never, hashHex: never) => w.sign(hashHex));
  await ctx.addInitScript(`(() => { window.__e2eTestWallet = { nearAddress: ${JSON.stringify(w.address)}, signRawHash: (a, h) => window.__drSign(a, h) }; })();`);
  return ctx;
};

const RESUME = process.env.DR5_PHASE === "rule";
if (!RESUME) test("DR5: human-mode bet, referee picked by username rules YES through the web referee screen", async ({ browser }) => {
  test.setTimeout(1_800_000);
  if (!REF_NAME) throw new Error("DR5_REF_USERNAME must name the referee's registered username");
  const cfg = loadFeeConfig();
  const tw = wallet("taker"), rw = wallet("referee");
  const sinceNs = BigInt(Date.now() - 60_000) * 1_000_000n;
  R.escrow = ESCROW; R.taker = tw.address; R.referee = rw.address; R.referee_username = REF_NAME; save();

  // referee must be findable by username in the live registry (harness setup claimed it from Node with the harness wallet)
  const lk = await lookupUsername(REF_NAME);
  R.registry_lookup = lk; save();
  expect(lk.status).toBe(200); expect(lk.body.account_id).toBe(rw.address);

  // ---- maker: real Privy login
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
  // ---- rehearsal faucet (mock USDC mints, tNEAR so implicit accounts exist), outside the UI
  tx("mint mock wNEAR (betting balance) to maker", await fundUsdc(makerAddr, STAKE + NEAR1 / 10n));
  tx("mint mock wNEAR (betting balance) to taker", await fundUsdc(tw.address, STAKE + NEAR1 / 10n));
  if ((await nearBal(makerAddr)) === "absent") tx("tNEAR to maker implicit", await fundNear(makerAddr, 100_000_000_000_000_000_000_000n));
  if ((await nearBal(tw.address)) === "absent") tx("tNEAR to taker implicit", await fundNear(tw.address, 100_000_000_000_000_000_000_000n));
  if ((await nearBal(rw.address)) === "absent") tx("tNEAR to referee implicit", await fundNear(rw.address, 100_000_000_000_000_000_000_000n));
  step("faucet done");
  await claimUsernameIfAsked(maker, `dr5mk${Date.now().toString(36)}`, "maker");
  step("maker: past the username step");

  const before = { maker: await bal(makerAddr), taker: await bal(tw.address), referee: await bal(rw.address), fee: await bal(FEE), escrow: await bal(ESCROW) };
  R.balances_before = before; save();

  // ---- maker creates the human-mode offer in the web UI
  await maker.getByTestId("nav-create").click();
  await expect(maker.getByTestId("create-offer-form")).toBeVisible();
  await maker.getByTestId("bet-type-card-btc_touch").click();
  const dl = new Date(Date.now() + LEAD_MIN * 60_000); dl.setUTCSeconds(0, 0);
  await maker.getByTestId("guided-direction").selectOption("at_or_above");
  await maker.getByTestId("guided-x_usd").fill("1000000");
  await maker.getByTestId("guided-deadline_utc").fill(dl.toISOString().slice(0, 16));
  await maker.getByTestId("fill-next").click();
  await maker.getByTestId("maker-amount").fill("3");
  await maker.getByTestId("odds-input").fill("1");
  await maker.getByTestId("invite-by-link").check();
  await maker.getByTestId("decider-person").check();
  await maker.getByTestId("referee-search").fill(REF_NAME);
  await expect(maker.getByTestId("referee-results")).toBeVisible({ timeout: 60_000 });
  await maker.getByTestId("referee-result-0").click(); // picked by username: registry search + lookupUsername resolve the account
  await expect(maker.getByTestId("referee-selected")).toContainText(REF_NAME, { timeout: 60_000 });
  await maker.getByTestId("tip-maker-checkbox").check();
  step("maker picked the referee by username and ticked the tip", { referee_selected_text: await maker.getByTestId("referee-selected").textContent() });
  await maker.getByTestId("review-offer").click();
  await expect(maker.getByTestId("review-card")).toBeVisible();
  const reviewText = await maker.getByTestId("review-card").innerText();
  R.review_human_sentence = await maker.getByTestId("review-human-sentence").textContent().catch(() => null);
  R.review_mentions_referee = reviewText.includes(REF_NAME); save();
  await expect(maker.getByTestId("open-offer-btn")).toBeEnabled({ timeout: 60_000 }); // Human mode still runs the (live) sourcecheck on the review card for the attestation (D-FE6B1); no AI call
  await maker.getByTestId("open-offer-btn").click();
  await expect(maker.getByTestId("share-screen")).toBeVisible({ timeout: 120_000 });
  const link = await maker.getByTestId("share-link").inputValue();
  const betId = Number(link.match(/\/bet\/(\d+)/)![1]);
  R.betId = betId; step("maker opened the human bet via web", { betId });
  const betOpen: BetView = await view("get_bet", { bet_id: betId });
  expect(betOpen.status).toBe("Open");
  expect(betOpen.envelope.referee?.account).toBe(rw.address);
  expect(betOpen.envelope.referee?.mode).toBe("Human");
  expect(betOpen.envelope.tip_maker).toBe(true);
  R.bet_open = betOpen; save();
  const fundingNs = BigInt(betOpen.envelope.funding_deadline ?? 0);

  // ---- taker takes via the maker's personal invite link (IN1/TK1); does NOT tick the tip
  await maker.getByTestId("share-view-bet").click();
  await expect(maker.getByTestId("invite-section")).toBeVisible({ timeout: 30_000 });
  await maker.getByTestId("invite-invitee-input").fill(tw.address);
  await maker.getByTestId("invite-make-link").click();
  await expect(maker.getByTestId("invite-link-output")).toBeVisible();
  const inviteLink = (await maker.getByTestId("invite-link-output").inputValue().catch(async () => (await maker.getByTestId("invite-link-output").textContent()) ?? "")).trim();
  step("maker made the taker's invite link");
  const tctx = await testWalletCtx(browser, tw);
  const taker = await tctx.newPage();
  await taker.goto(inviteLink); await ready(taker); await claimUsernameIfAsked(taker, `dr5tk${Date.now().toString(36)}`, "taker");
  await expect(taker.getByTestId("take-referee-line")).toBeVisible({ timeout: 60_000 });
  R.take_referee_line = await taker.getByTestId("take-referee-line").textContent();
  const tipBox = taker.getByTestId("take-tip-checkbox");
  if (await tipBox.count()) expect(await tipBox.isChecked()).toBe(false);
  await expect(taker.getByTestId("take-confirm")).toBeEnabled({ timeout: 60_000 });
  await taker.getByTestId("take-confirm").click();
  await expect(taker.getByTestId("take-result")).toHaveAttribute("data-kind", "taken", { timeout: 120_000 });
  tx("take (web, taker)", await taker.getByTestId("take-tx").textContent().catch(() => null));
  step("taker took via invite link");
  const betTaken: BetView = await view("get_bet", { bet_id: betId });
  expect(betTaken.status).toBe("Taken"); expect(betTaken.taker).toBe(tw.address);
  expect(BigInt(betTaken.tip_taker ?? "0")).toBe(0n);
  R.bet_taken = betTaken;
  const mid = { maker: await bal(makerAddr), taker: await bal(tw.address), referee: await bal(rw.address), fee: await bal(FEE), escrow: await bal(ESCROW) };
  R.balances_after_take = mid; save();

  // ---- ground truth BEFORE any ruling/outcome is read. Human mode has no independent source: the ground truth is the stated scenario
  // plus the public market fact the bet is about (BTC far below the threshold), recorded so the README can compare it with the ruling.
  const gt = { written_at: new Date().toISOString(), bet_id: betId, mode: "Human", claim: "BTC at_or_above 1000000 USD before the deadline (referee decides, not a source)",
    expected_by_scenario: "referee rules YES; maker_side=YES so the maker wins; maker paid at once; tip only because the maker ticked it",
    market_note: "the real-world answer would be NO; the referee's ruling is by definition authoritative in Human mode (that is what the scenario exercises)",
    outcome_read_before_this: false, bet_status_at_write: betTaken.status, bet_outcome_at_write: betTaken.outcome ?? null };
  fs.writeFileSync(path.join(RUN, "ground_truth.json"), JSON.stringify(gt, null, 2));

  // ---- bettors see the waiting view and NO challenge button while the referee has not ruled (UX-19/UX-20)
  for (const [who, page] of [["maker", maker], ["taker", taker]] as const) {
    await page.goto(`/bet/${betId}`); await ready(page);
    await expect(page.getByTestId("referee-waiting")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("challenge-btn")).toHaveCount(0);
    step(`${who}: waiting view, no challenge button`);
  }

  await ruleAndVerify({ browser, betId, betTaken, makerAddr, mid, before, sinceNs, pages: [["maker", maker], ["taker", taker]] });
});

type Bal = { maker: bigint; taker: bigint; referee: bigint; fee: bigint; escrow: bigint };
interface RuleState { browser: Browser; betId: number; betTaken: BetView; makerAddr: string; mid: Bal; before: Bal; sinceNs: bigint; pages: (readonly [string, Page])[]; }

/** The ruling through the web referee screen (real relayer referee_rule), then every money/tx assertion. Shared by the full run and the resume (DR5_PHASE=rule). */
async function ruleAndVerify(st: RuleState): Promise<void> {
  const { browser, betId, betTaken, makerAddr, mid, before, sinceNs } = st;
  const cfg = loadFeeConfig();
  const tw = wallet("taker"), rw = wallet("referee");
  const fundingNs = BigInt(betTaken.envelope.funding_deadline ?? 0);
  // ---- wait for the funding deadline (referee_rule: now >= funding_deadline)
  while (BigInt(Date.now()) * 1_000_000n < fundingNs + 20_000_000_000n) await sleep(5000);
  const rctx = await testWalletCtx(browser, rw);
  const referee = await rctx.newPage();
  const relayResp: { status: number; body: string }[] = [];
  referee.on("response", async (r) => { if (/\/relay$/.test(r.url()) && r.request().method() === "POST") relayResp.push({ status: r.status(), body: (await r.text().catch(() => "")).slice(0, 600) }); });
  await referee.goto(`/bet/${betId}`); await ready(referee);
  await expect(referee.getByTestId("referee-banner")).toContainText("You're the referee", { timeout: 60_000 });
  await expect(referee.getByTestId("referee-btn-YES")).toBeVisible({ timeout: 90_000 });
  await expect(referee.getByTestId("challenge-btn")).toHaveCount(0);
  await referee.getByTestId("referee-btn-YES").click();
  R.referee_confirm_text = await referee.getByTestId("referee-confirm-text").textContent(); save();
  await referee.getByTestId("referee-confirm-btn").click();
  await expect(referee.getByTestId("referee-result")).toHaveAttribute("data-kind", /.+/, { timeout: 180_000 });
  R.referee_result = { kind: await referee.getByTestId("referee-result").getAttribute("data-kind"), text: await referee.getByTestId("referee-result").textContent() };
  step("referee ruled YES through the web referee screen", R.referee_result);
  R.relay_responses = relayResp; save();
  const ruleHash = relayResp.map((x) => { try { return (JSON.parse(x.body) as { txHash?: string }).txHash ?? null; } catch { return null; } }).find((h) => !!h) ?? null;
  tx("referee_rule (web referee screen, relayer)", ruleHash);
  if (ruleHash) {
    const full = (await (await fetch("https://tx.test.fastnear.com/v0/transactions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx_hashes: [ruleHash] }) })).json()) as unknown;
    R.referee_rule_gas = (functionCallGas(full, "referee_rule") ?? "unknown").toString(); save();
  }
  if (R.referee_result.kind !== "ruled") throw new Error(`referee screen result ${R.referee_result.kind}: ${R.referee_result.text}`); // FINDING guard: a refused/pending ruling is a failure, reported before any money check
  for (let i = 0; i < 40 && !(await view("is_fully_paid", { bet_id: betId })); i++) await sleep(3000);
  const fin: BetView & Record<string, any> = await view("get_bet", { bet_id: betId });
  R.bet_final = fin; save();

  // ---- money assertions from chain views
  const after = { maker: await bal(makerAddr), taker: await bal(tw.address), referee: await bal(rw.address), fee: await bal(FEE), escrow: await bal(ESCROW) };
  R.balances_after = after;
  const exp = expectedRefereeYes(betTaken, { tipMaker: true, tipTaker: false }, cfg.feeBps);
  const deltas = { maker: after.maker - mid.maker, taker: after.taker - mid.taker, referee: after.referee - mid.referee, fee: after.fee - mid.fee };
  const bad = checkObserved(exp, deltas, { escrowAfter: after.escrow - before.escrow });
  R.money_check = { expected: exp.lines, deltas, mismatches: bad }; save();
  expect(bad).toEqual([]);
  expect(paidTo(exp, "referee")).toBeGreaterThan(0n); // the tip WAS ticked by the maker...
  expect(BigInt(fin.tip_taker ?? "0")).toBe(0n);        // ...and the taker did not tick one
  expect(fin.status).toBe("Settled"); // referee_rule sets Finalized; drain_payouts promotes to Settled once every line is paid (asserted after the drain wait)
  expect(fin.outcome).toBe("YES");
  expect(await view("is_fully_paid", { bet_id: betId })).toBe(true);
  expect((await view("pending_payouts", { bet_id: betId })).filter((l: any) => !l.done)).toEqual([]);

  // ---- UI after: nobody sees a challenge button; the payout screen shows
  for (const [who, page] of [...st.pages, ["referee", referee] as const]) {
    await page.goto(`/bet/${betId}`); await ready(page);
    await expect(page.getByTestId("challenge-btn")).toHaveCount(0);
    step(`${who}: no challenge button after the ruling`);
  }

  // ---- tx list: referee_rule present, no AI path
  await sleep(4000);
  const hist = await escrowMethods(sinceNs);
  R.escrow_tx_methods = hist; save();
  const all = hist.flatMap((h) => h.methods);
  for (const m of REQUIRED_METHODS) expect(all).toContain(m);
  expect(forbiddenCalls(all)).toEqual([]);
  R.balances_final = { maker: await bal(makerAddr), taker: await bal(tw.address), referee: await bal(rw.address), fee: await bal(FEE), escrow: await bal(ESCROW) }; save();
  step("DR5 live assertions passed");
}

// RESUME (DR5_PHASE=rule, DR5_BET_ID=<n>): the bet was opened and taken through the web in an earlier run (evidence in run/), the first ruling
// attempt failed on chain (prepaid gas, fixed by REFGAS1). Drives ONLY the referee's ruling via the web referee screen, then the same assertions.
// ground_truth.json must already exist (written before any outcome); open/take are not repeated.
if (RESUME) test("DR5 resume: referee rules YES on the already-taken bet through the web referee screen", async ({ browser }) => {
  test.setTimeout(1_800_000);
  const betId = Number(process.env.DR5_BET_ID);
  if (!Number.isInteger(betId)) throw new Error("DR5_BET_ID must name the taken bet");
  if (!fs.existsSync(path.join(RUN, "ground_truth.json"))) throw new Error("run/ground_truth.json must exist before ruling (written before any outcome)");
  const tw = wallet("taker"), rw = wallet("referee");
  const betTaken: BetView = await view("get_bet", { bet_id: betId });
  expect(betTaken.status).toBe("Taken"); expect(betTaken.taker).toBe(tw.address);
  expect(betTaken.envelope.referee?.account).toBe(rw.address); expect(betTaken.envelope.referee?.mode).toBe("Human");
  expect(betTaken.envelope.tip_maker).toBe(true); expect(BigInt(betTaken.tip_taker ?? "0")).toBe(0n);
  const makerAddr = betTaken.envelope.maker;
  const mid = { maker: await bal(makerAddr), taker: await bal(tw.address), referee: await bal(rw.address), fee: await bal(FEE), escrow: await bal(ESCROW) };
  const before = { ...mid, escrow: escrowBaseline(betTaken, mid.escrow) };
  expect(before.escrow >= 0n).toBe(true);
  R.resume = { phase: "rule", betId, gas_before_resume_note: "first attempt FqawWQJpM67YzBKEutNStjQcqfRiB3bdMkk3NPCgsfyJ failed at 80 Tgas" };
  R.betId = betId; R.escrow = ESCROW; R.taker = tw.address; R.referee = rw.address; R.maker = makerAddr; R.bet_taken = betTaken;
  R.balances_before_ruling = mid; R.escrow_baseline_other_bets = before.escrow; save();
  const tctx = await testWalletCtx(browser, tw);
  const taker = await tctx.newPage();
  await taker.goto(`/bet/${betId}`); await ready(taker);
  await expect(taker.getByTestId("referee-waiting")).toBeVisible({ timeout: 60_000 });
  await expect(taker.getByTestId("challenge-btn")).toHaveCount(0);
  step("taker: waiting view, no challenge button (before the ruling)");
  await ruleAndVerify({ browser, betId, betTaken, makerAddr, mid, before, sinceNs: BigInt(Date.now() - 120_000) * 1_000_000n, pages: [["taker", taker]] });
});
