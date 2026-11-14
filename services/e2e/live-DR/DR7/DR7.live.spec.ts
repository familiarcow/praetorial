import { test, expect, type Page, type Browser } from "./pw.js";
import fs from "node:fs";
import path from "node:path";
import { checkObserved, loadFeeConfig } from "../harness/money.js";
import { expectedDeadlineRefund, forbiddenCalls, paidTo, type BetView } from "./expected.js";
import { ESCROW, FEE, view, bal, nearBal, wallet, fundUsdc, fundNear, escrowMethods, sleep, lookupUsername, claimUsernameNode } from "./chain.js";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const RUN = path.join(DIR, "run");
fs.mkdirSync(RUN, { recursive: true });
const R: Record<string, any> = fs.existsSync(path.join(RUN, "results.json")) && (process.env.DR7_PHASE ?? "open") === "finish" ? JSON.parse(fs.readFileSync(path.join(RUN, "results.json"), "utf8")) : { txs: [], steps: [] };
const save = () => fs.writeFileSync(path.join(RUN, "results.json"), JSON.stringify(R, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
const step = (s: string, extra: Record<string, unknown> = {}) => { R.steps.push({ s, t: new Date().toISOString(), ...extra }); save(); };
const tx = (s: string, hash: string | null) => { R.txs.push({ step: s, hash, url: hash ? `https://testnet.nearblocks.io/txns/${hash}` : null }); save(); };
const EMAIL = process.env.PRIVY_TEST_EMAIL!, OTP = process.env.PRIVY_TEST_OTP!; // used only to fill the form; never logged or stored
const PHASE = process.env.DR7_PHASE ?? "open"; // "open": web flow up to the take + ground truth; "finish": after resolve_deadline (chain checks only)
const STATE = path.join(RUN, "state.json");
const NEAR1 = 10n ** 24n, STAKE = 3n * NEAR1; // 3 NEAR per side (testnet NEAR min stake 2.717); wNEAR betting balance
const LEAD_MIN = 9; // funding deadline = event deadline = now + LEAD_MIN (shortest the offer lifetime allows while the taker takes)

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
    // The app's own "Skip for now" is offered after the failure; DR7 needs the REFEREE findable, not the maker/taker, so that path is used.
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


test("DR7: human-mode bet, referee never rules, void_after_deadline refunds both bettors", async ({ browser }) => {
  test.setTimeout(PHASE === "finish" ? 3_600_000 : 900_000);
  const cfg = loadFeeConfig();
  const tw = wallet("taker"), rw = wallet("referee");

  if (PHASE === "finish") {
    // ================= phase 2: after resolve_deadline. Chain views only; the web offers no void button, so the keeper Worker voids.
    const st = JSON.parse(fs.readFileSync(STATE, "utf8")) as { betId: number; maker: string; resolveNs: string; sinceNs: string; mid: Record<string, string>; before: Record<string, string> };
    const betId = st.betId; const makerAddr = st.maker;
    const mid = Object.fromEntries(Object.entries(st.mid).map(([k, v]) => [k, BigInt(v)])) as Record<"maker" | "taker" | "referee" | "fee" | "escrow", bigint>;
    const before = Object.fromEntries(Object.entries(st.before).map(([k, v]) => [k, BigInt(v)])) as Record<"maker" | "taker" | "referee" | "fee" | "escrow", bigint>;
    const resolveNs = BigInt(st.resolveNs);
    while (BigInt(Date.now()) * 1_000_000n <= resolveNs + 5_000_000_000n) await sleep(15_000);
    step("resolve_deadline passed", { deadline_ns: st.resolveNs });
    // keeper fallback: wait for the Worker to void. >10 min after the deadline (+ keeper cadence) is a FINDING.
    const t0 = Date.now();
    let fin: BetView & Record<string, any> = await view("get_bet", { bet_id: betId });
    while (fin.status !== "Voided" && Date.now() - t0 < 12 * 60_000) { await sleep(15_000); fin = await view("get_bet", { bet_id: betId }); }
    R.void_path = "keeper Worker (the web UI offers no void_after_deadline control)"; R.void_wait_s = Math.round((Date.now() - t0) / 1000); save();
    expect(fin.status).toBe("Voided"); expect(fin.outcome).toBe("VOID");
    for (let i = 0; i < 200 && !(await view("is_fully_paid", { bet_id: betId })); i++) await sleep(3000); // keeper drains ~4/min
    R.bet_final = fin = await view("get_bet", { bet_id: betId });
    const after = { maker: await bal(makerAddr), taker: await bal(tw.address), referee: await bal(rw.address), fee: await bal(FEE), escrow: await bal(ESCROW) };
    R.balances_after = after;
    const betTaken = JSON.parse(fs.readFileSync(path.join(RUN, "bet_taken.json"), "utf8")) as BetView;
    const exp = expectedDeadlineRefund(betTaken, { tipMaker: false, tipTaker: false }, cfg.feeBps);
    const deltas = { maker: after.maker - mid.maker, taker: after.taker - mid.taker, referee: after.referee - mid.referee, fee: after.fee - mid.fee };
    const bad = checkObserved(exp, deltas, { escrowAfter: after.escrow - before.escrow });
    R.money_check = { expected: exp.lines, deltas, mismatches: bad }; save();
    expect(bad).toEqual([]);
    expect(paidTo(exp, "referee")).toBe(0n); expect(paidTo(exp, "fee")).toBe(0n);
    expect(await view("is_fully_paid", { bet_id: betId })).toBe(true);
    expect((await view("pending_payouts", { bet_id: betId })).filter((l: any) => !l.done)).toEqual([]);
    await sleep(4000);
    const hist = await escrowMethods(BigInt(st.sinceNs));
    R.escrow_tx_methods = hist; save();
    const all = hist.flatMap((h) => h.methods);
    expect(all).toContain("void_after_deadline");
    expect(forbiddenCalls(all)).toEqual([]); // referee never ruled; no resolution/NEAR AI path
    step("DR7 finish assertions passed");
    return;
  }

  // ================= phase 1: web flow
  const sinceNs = BigInt(Date.now() - 60_000) * 1_000_000n;
  R.escrow = ESCROW; R.taker = tw.address; R.referee = rw.address; save();
  const REF_NAME = `dr7ref${Date.now().toString(36)}`;
  const claim = await claimUsernameNode("referee", REF_NAME); // harness setup from Node (the web username-claim path is a known finding, see DR5)
  R.referee_username = REF_NAME; R.referee_claim = { status: claim.status }; save();
  const lk = await lookupUsername(REF_NAME);
  expect(lk.status).toBe(200); expect(lk.body.account_id).toBe(rw.address);

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
  tx("mint mock wNEAR (betting balance) to maker", await fundUsdc(makerAddr, STAKE + NEAR1 / 10n));
  tx("mint mock wNEAR (betting balance) to taker", await fundUsdc(tw.address, STAKE + NEAR1 / 10n));
  if ((await nearBal(makerAddr)) === "absent") tx("tNEAR to maker implicit", await fundNear(makerAddr, 100_000_000_000_000_000_000_000n));
  if ((await nearBal(tw.address)) === "absent") tx("tNEAR to taker implicit", await fundNear(tw.address, 100_000_000_000_000_000_000_000n));
  if ((await nearBal(rw.address)) === "absent") tx("tNEAR to referee implicit", await fundNear(rw.address, 100_000_000_000_000_000_000_000n));
  step("faucet done");
  await claimUsernameIfAsked(maker, `dr7mk${Date.now().toString(36)}`, "maker");
  step("maker: past the username step");
  const before = { maker: await bal(makerAddr), taker: await bal(tw.address), referee: await bal(rw.address), fee: await bal(FEE), escrow: await bal(ESCROW) };
  R.balances_before = before; save();

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
  await maker.getByTestId("referee-result-0").click();
  await expect(maker.getByTestId("referee-selected")).toContainText(REF_NAME, { timeout: 60_000 });
  // SHORTEST referee deadline the builder accepts (apps/web lib/stakeDeadlines.ts + offerExpiry.ts): the date input is day-granular (00:00 UTC),
  // must be after the event, AND after the offer expiry (expiryProblem), whose shortest option is 1d. So: expiry 1d, then the first UTC midnight after now + 1d.
  await maker.getByTestId("offer-expiry").selectOption("1d");
  const floor = new Date(Date.now() + 86_400_000 + 45 * 60_000); // 45 min margin for the rest of the form
  const resolveDay = new Date(Date.UTC(floor.getUTCFullYear(), floor.getUTCMonth(), floor.getUTCDate() + 1)).toISOString().slice(0, 10);
  await maker.getByTestId("resolve-deadline").fill(resolveDay);
  R.resolve_day_chosen = resolveDay; R.event_deadline_utc = dl.toISOString();
  step("maker picked the referee by username and set the shortest referee deadline", { referee_selected_text: await maker.getByTestId("referee-selected").textContent(), resolveDay });
  await maker.getByTestId("review-offer").click();
  await expect(maker.getByTestId("review-card")).toBeVisible();
  R.review_text = (await maker.getByTestId("review-card").innerText()).slice(0, 1500); save();
  await expect(maker.getByTestId("open-offer-btn")).toBeEnabled({ timeout: 60_000 }); // Human mode runs the live sourcecheck on the review card; a 429 here = stop and report
  await maker.getByTestId("open-offer-btn").click();
  await expect(maker.getByTestId("share-screen")).toBeVisible({ timeout: 120_000 });
  const link = await maker.getByTestId("share-link").inputValue();
  const betId = Number(link.match(/\/bet\/(\d+)/)![1]);
  R.betId = betId; step("maker opened the human bet via web", { betId });
  const betOpen: BetView = await view("get_bet", { bet_id: betId });
  expect(betOpen.status).toBe("Open");
  expect(betOpen.envelope.referee?.account).toBe(rw.address);
  expect(betOpen.envelope.referee?.mode).toBe("Human");
  R.bet_open = betOpen; save();
  const resolveNs = BigInt(betOpen.envelope.resolve_deadline ?? 0);
  expect(resolveNs).toBeGreaterThan(0n);
  R.resolve_deadline_ns = resolveNs.toString(); R.resolve_deadline_iso = new Date(Number(resolveNs / 1_000_000n)).toISOString(); save();

  await maker.getByTestId("share-view-bet").click();
  await expect(maker.getByTestId("invite-section")).toBeVisible({ timeout: 30_000 });
  await maker.getByTestId("invite-invitee-input").fill(tw.address);
  await maker.getByTestId("invite-make-link").click();
  await expect(maker.getByTestId("invite-link-output")).toBeVisible();
  const inviteLink = (await maker.getByTestId("invite-link-output").inputValue().catch(async () => (await maker.getByTestId("invite-link-output").textContent()) ?? "")).trim();
  step("maker made the taker's invite link");
  const tctx = await testWalletCtx(browser, tw);
  const taker = await tctx.newPage();
  await taker.goto(inviteLink); await ready(taker); await claimUsernameIfAsked(taker, `dr7tk${Date.now().toString(36)}`, "taker");
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
  expect(BigInt(betTaken.tip_taker ?? "0")).toBe(0n); expect(betTaken.envelope.tip_maker === true).toBe(false);
  fs.writeFileSync(path.join(RUN, "bet_taken.json"), JSON.stringify(betTaken, null, 2));
  const mid = { maker: await bal(makerAddr), taker: await bal(tw.address), referee: await bal(rw.address), fee: await bal(FEE), escrow: await bal(ESCROW) };
  R.balances_after_take = mid; save();

  // ground truth BEFORE any outcome is read
  const gt = { written_at: new Date().toISOString(), bet_id: betId, mode: "Human", claim: "BTC at_or_above 1000000 USD before the deadline (referee decides)",
    expected_by_scenario: "referee never rules; after resolve_deadline void_after_deadline voids the bet; both bettors refunded stake + own storage, no protocol fee, no tips (none ticked); fee account and referee get 0",
    resolve_deadline_iso: R.resolve_deadline_iso, outcome_read_before_this: false, bet_status_at_write: betTaken.status, bet_outcome_at_write: betTaken.outcome ?? null };
  fs.writeFileSync(path.join(RUN, "ground_truth.json"), JSON.stringify(gt, null, 2));

  for (const [who, page] of [["maker", maker], ["taker", taker]] as const) {
    await page.goto(`/bet/${betId}`); await ready(page);
    await expect(page.getByTestId("referee-waiting")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("challenge-btn")).toHaveCount(0);
    step(`${who}: waiting view, no challenge button`);
  }
  fs.writeFileSync(STATE, JSON.stringify({ betId, maker: makerAddr, resolveNs: resolveNs.toString(), sinceNs: sinceNs.toString(),
    mid: Object.fromEntries(Object.entries(mid).map(([k, v]) => [k, v.toString()])), before: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.toString()])) }, null, 2));
  step("DR7 phase 1 done; resume after resolve_deadline with DR7_PHASE=finish", { resolve_deadline_iso: R.resolve_deadline_iso });
});
