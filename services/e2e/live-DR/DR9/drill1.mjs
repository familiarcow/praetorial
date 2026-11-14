// DR9 drill 1 (frz3 rehearsal escrow): guardian pause_new_offers while a bet is Taken. New Open refused (paused banner in the web UI + contract refuses the
// deposit), a Taken bet created by this script settles by concede (free, no NEAR AI) WHILE PAUSED, then unpause (finally path), verified by view.
// Never touches bets 33/35/42. Keep pause < 10 min: all attestations are prepared BEFORE the pause.
import { account, store, view, bal, tryCall, prepareOpen, buildTakeMsg, KEEPER, FEE, USDC, DIR, sleep } from "./lib.mjs";
import { concedeCredits } from "../../live-DRILL1/assertions.mjs";
import { pauseWindowProblems } from "./expected.ts";
const ESC = "praetorial-frz3-2611100414.praetorial-dev-1101.testnet", INTENTS = "intents-mock.praetorial-dev-1101.testnet";
const MAKER = "maker1.praetorial-dev-1101.testnet", TAKER = "taker1.praetorial-dev-1101.testnet", GUARD = "arbiter1.praetorial-dev-1101.testnet";
const WEB = "https://praetorial-web-testnet.familiarcow.workers.dev";
const { load, save, rec } = store("run/drill1_results.json");
const R = load(); R.escrow = ESC; R.checks = {};
const maker = await account(MAKER), taker = await account(TAKER), guardian = await account(GUARD), keeper = await account(KEEPER);
const v = (m, a) => view(ESC, m, a);
const keys = await v("resolver_keys"); const cfg = await v("outlayer_config");
if (await v("is_new_offers_paused")) throw new Error("already paused; refusing to start");
// ---- prepare everything needed BEFORE pausing
const X = prepareOpen({ escrow: ESC, keys, wasmBase: cfg.wasm_base_url, maker: MAKER, tag: "d1x" });
const P = prepareOpen({ escrow: ESC, keys, wasmBase: cfg.wasm_base_url, maker: MAKER, tag: "d1p" });
const mint = async (who, amt, step) => { const r = await keeper.functionCall({ contractId: INTENTS, methodName: "mint", args: { account_id: who, token_id: USDC, amount: amt }, gas: 30_000_000_000_000n }); rec(step, r.transaction.hash); };
await mint(MAKER, X.dep, "mint_maker_X"); await mint(TAKER, X.dep, "mint_taker_X"); await mint(MAKER, P.dep, "mint_maker_P");
const t = async (acc, args, step) => { const r = await acc.functionCall({ contractId: INTENTS, methodName: "transfer_with_msg", args, gas: 80_000_000_000_000n }); rec(step, r.transaction.hash); };
await t(maker, { receiver_id: ESC, token_id: USDC, amount: X.dep, msg: X.msg }, "open_X"); await sleep(4000);
const offers = await v("open_offers", { from: 0, limit: 500 });
const bx = offers.filter((o) => o.envelope.terms_hash === X.built.terms_hash).pop(); if (!bx) throw new Error("open X not created");
const BET = bx.envelope.bet_id; R.bet_id = BET; save(R);
await t(taker, { receiver_id: ESC, token_id: USDC, amount: X.dep, msg: buildTakeMsg(BET, null) }, "take_X"); await sleep(4000);
let b = await v("get_bet", { bet_id: BET }); if (b.status !== "Taken") throw new Error("X not Taken: " + b.status);
R.checks.taken_before_pause = true; save(R);
const snap = async () => ({ maker: await bal(INTENTS, MAKER), taker: await bal(INTENTS, TAKER), fee: await bal(INTENTS, FEE), esc: await bal(INTENTS, ESC) });
let pausedAt = 0, unpausedAt = 0, pauseTx = "", unpauseTx = "", failure = null;
try {
  const p = await tryCall(guardian, ESC, "pause_new_offers", {}, { deposit: 1n }); if (!p.ok) throw new Error("pause failed " + p.failure);
  pausedAt = Date.now(); pauseTx = p.hash; rec("pause_new_offers", p.hash);
  await sleep(2500); R.checks.paused_view = await v("is_new_offers_paused"); if (R.checks.paused_view !== true) throw new Error("pause did not land");
  // UI: paused banner on the deployed web
  try {
    const { chromium } = await import("playwright");
    const br = await chromium.launch(); const pg = await (await br.newContext()).newPage();
    await pg.goto(WEB + "/", { waitUntil: "domcontentloaded" });
    await pg.getByTestId("banner-paused").waitFor({ timeout: 45_000 });
    R.checks.ui_banner_paused_text = (await pg.getByTestId("banner-paused").textContent())?.trim();
    await pg.screenshot({ path: DIR + "run/drill1_paused_banner.png" });
    await br.close();
  } catch (e) { R.checks.ui_banner_error = String(e?.message ?? e).slice(0, 300); }
  save(R);
  // contract refuses a new Open (silent full refund) while paused
  const s0 = await snap(), c0 = Number(await v("bet_count"));
  await t(maker, { receiver_id: ESC, token_id: USDC, amount: P.dep, msg: P.msg }, "open_while_paused"); await sleep(4000);
  const s1 = await snap(), c1 = Number(await v("bet_count"));
  R.checks.open_refused = { count: [c0, c1], maker: [s0.maker.toString(), s1.maker.toString()], esc: [s0.esc.toString(), s1.esc.toString()], ok: c0 === c1 && s0.maker === s1.maker && s0.esc === s1.esc }; save(R);
  // Taken bet X settles while paused (concede by the maker => taker wins)
  b = await v("get_bet", { bet_id: BET });
  const stakeM = BigInt(b.envelope.stake_maker), stakeT = BigInt(b.envelope.stake_taker);
  const exp = concedeCredits({ maker: MAKER, taker: TAKER, conceder: MAKER, stakeM, stakeT, feeBps: BigInt(b.envelope.fee_bps), minFeeM: BigInt(b.fee_min_maker), minFeeT: BigInt(b.fee_min_taker), storageM: BigInt(b.storage_maker), storageT: BigInt(b.storage_taker), feeAccount: FEE });
  const s2 = await snap();
  const c = await tryCall(maker, ESC, "concede", { bet_id: BET }, { deposit: 0n, gas: 200_000_000_000_000n }); if (!c.ok) throw new Error("concede failed " + c.failure);
  rec("concede_while_paused", c.hash);
  let s3; for (let i = 0; i < 20; i++) { await sleep(3000); s3 = await snap(); if (s3.taker - s2.taker === (exp.get(TAKER) ?? 0n) && s3.fee - s2.fee === (exp.get(FEE) ?? 0n)) break; }
  b = await v("get_bet", { bet_id: BET });
  R.checks.settles_while_paused = { status: b.status, taker_delta: (s3.taker - s2.taker).toString(), taker_expected: (exp.get(TAKER) ?? 0n).toString(), fee_delta: (s3.fee - s2.fee).toString(), fee_expected: (exp.get(FEE) ?? 0n).toString(), ok: s3.taker - s2.taker === exp.get(TAKER) && s3.fee - s2.fee === exp.get(FEE) };
  save(R);
} catch (e) { failure = String(e?.message ?? e); R.failure = failure; save(R); }
finally {
  if (pausedAt) {
    for (let i = 0; i < 4 && !unpauseTx; i++) { const u = await tryCall(guardian, ESC, "unpause_new_offers", {}, { deposit: 1n }); if (u.ok) { unpauseTx = u.hash; unpausedAt = Date.now(); rec("unpause_new_offers", u.hash); } else { console.log("unpause retry", u.failure); await sleep(3000); } }
    await sleep(2500); const stillPaused = await v("is_new_offers_paused");
    R.checks.unpaused_view = !stillPaused; R.window = { pausedAt: new Date(pausedAt).toISOString(), unpausedAt: unpausedAt ? new Date(unpausedAt).toISOString() : null, seconds: unpausedAt ? (unpausedAt - pausedAt) / 1000 : null };
    R.window_problems = pauseWindowProblems({ pausedAtMs: pausedAt, unpausedAtMs: unpausedAt || Date.now(), pausedAfterUnpause: stillPaused, pauseTx, unpauseTx });
    save(R); console.log(JSON.stringify(R.checks), JSON.stringify(R.window), JSON.stringify(R.window_problems));
  }
}
const ok = !failure && R.checks.open_refused?.ok && R.checks.settles_while_paused?.ok && R.window_problems?.length === 0;
R.verdict = ok ? "PASS" : "FAIL"; save(R); console.log("DRILL1", R.verdict, failure ?? "");
process.exit(ok ? 0 : 1);
