// usage: node 03_run_bet.mjs usdc|btc
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { account, recordTx, results, save, OUT } from "./lib.mjs";
import * as C from "./config.mjs";
const kind = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maker = await account(C.MAKER), taker = await account(C.TAKER), keeper = await account(C.KEEPER), anyone = await account(C.OPERATOR);
const view = (m, a) => keeper.viewFunction({ contractId: C.ESCROW, methodName: m, args: a });
const bal = async (acct, tok) => (await keeper.viewFunction({ contractId: C.INTENTS, methodName: "mt_balance_of", args: { account_id: acct, token_id: tok } }));
const snap = async () => { const o = {}; for (const a of [C.MAKER, C.TAKER, C.FEE, C.ESCROW]) for (const t of [C.USDC, C.BTC]) o[`${a.split(".")[0]}:${t}`] = await bal(a, t); return o; };
const r = results(); r.bets = r.bets ?? {};
const rec = (r.bets[kind] = { kind, steps: [] });

// 1. live sourcecheck of the new wasm on the Jason sheet (OutLayer testnet)
const U = `https://test.fastfs.io/praetorial-dev-1101.testnet/outlayer.testnet/${C.RESOLVER_WASM_SHA}.wasm`;
const OL = ((process.env.PRAETORIAL_CACHE_DIR ?? (() => { throw new Error("set PRAETORIAL_CACHE_DIR (operator cache dir)"); })()) + "/scratch/olbin/outlayer");
let out; for (let a = 0; a < 3 && !out; a++) { try { out = execFileSync("/bin/sh", ["-c", `${OL} run --wasm ${U} --input ${OUT}job_sourcecheck.json 2>&1`], { env: { ...process.env, OUTLAYER_HOME: ((process.env.PRAETORIAL_CACHE_DIR ?? (() => { throw new Error("set PRAETORIAL_CACHE_DIR (operator cache dir)"); })()) + "/scratch/olhome-escrow8") }, encoding: "utf8", timeout: 280000 }); } catch (e) { console.log("outlayer run attempt failed, retrying"); } }
fs.writeFileSync(OUT + `sourcecheck_${kind}.log`, out);
const scTx = out.match(/Tx: (\S+)/)[1];
const sc = JSON.parse(out.slice(out.indexOf("{", out.indexOf("Tx:"))));
if (!sc.ok || !sc.signing || sc.signing.pubkey_hex !== C.ATTEST_PUBKEY) throw new Error("sourcecheck not ok / pubkey mismatch: " + JSON.stringify(sc).slice(0, 300));
recordTx(`sourcecheck_${kind}`, scTx, { spec_hash: sc.spec_hash, checked_at: out.match(/"checked_at":\s*(\d+)/)[1], attest_pubkey: sc.signing.pubkey_hex });
const checkedAtExact = out.match(/"checked_at":\s*(\d+)/)[1]; // JS Number would print 1793936579696296000 (lossy)
const terms = JSON.parse(fs.readFileSync(OUT + "job_sourcecheck.json", "utf8")).terms;
if (crypto.createHash("sha256").update(terms).digest("hex") !== sc.spec_hash) throw new Error("spec_hash != sha256(terms)");

// 2. mint test tokens, open, take
const makerAsset = kind === "btc" ? C.BTC : C.USDC, takerAsset = C.USDC;
const stakeMaker = kind === "btc" ? 10000n : 10_000_000n, stakeTaker = 10_000_000n, storage = 8000n;
const mReq = stakeMaker + storage, tReq = stakeTaker + storage;
rec.before = await snap();
const mint = async (to, tok, amt) => recordTx(`mint_${kind}_${tok}_${to.split(".")[0]}`, (await keeper.functionCall({ contractId: C.INTENTS, methodName: "mint", args: { account_id: to, token_id: tok, amount: amt.toString() }, gas: 30_000_000_000_000n })).transaction.hash);
await mint(C.MAKER, makerAsset, mReq); await mint(C.TAKER, takerAsset, tReq);
const now = Date.now() * 1e6;
const envelope = {
  bet_id: 0, version: 1, maker: C.MAKER, taker_allow: { Any: {} }, terms_hash: sc.spec_hash,
  models_snapshot_hash: "item8-testnet-e2e", outcomes: ["YES", "NO"], maker_side: "YES",
  maker_asset: makerAsset, taker_asset: takerAsset,
  stake_maker: stakeMaker.toString(), stake_taker: stakeTaker.toString(), fee_bps: 100,
  storage_charge_per_side: storage.toString(), keep_terms: true, terms, max_paid_runs: 3, tier: 1,
  funding_deadline: now + 900e9, early_settle_outcome: null, finality_delay: 0,
  settlement_period: 3600e9, resolve_deadline: now + 30 * 86400e9, consent_party_controlled: false,
};
const { buildOpenMsg } = await import(new URL("../../common/src/openMsg.ts", import.meta.url).href);
const msg = buildOpenMsg(envelope, { checked_at: checkedAtExact, signature_hex: sc.signing.signature_hex });
const open = await maker.functionCall({ contractId: C.INTENTS, methodName: "transfer_with_msg", args: { receiver_id: C.ESCROW, token_id: makerAsset, amount: mReq.toString(), msg }, gas: 80_000_000_000_000n });
recordTx(`open_${kind}`, open.transaction.hash);
let bet;
for (let i = 0; i < 20 && !bet; i++) { if (i) await sleep(1500); const offers = await view("open_offers", { from: 0, limit: 200 }); bet = offers.filter((b) => b.envelope.maker === C.MAKER && b.envelope.maker_asset === makerAsset && b.envelope.terms_hash === sc.spec_hash).pop(); }
if (!bet) throw new Error("open did not create an offer (see open tx logs)");
const betId = bet.envelope.bet_id; rec.bet_id = betId;
const take = await taker.functionCall({ contractId: C.INTENTS, methodName: "transfer_with_msg", args: { receiver_id: C.ESCROW, token_id: takerAsset, amount: tReq.toString(), msg: JSON.stringify({ kind: "Take", bet_id: betId, invite_sig: null }) }, gas: 80_000_000_000_000n });
recordTx(`take_${kind}`, take.transaction.hash);
await sleep(2000); rec.status_after_take = (await view("get_bet", { bet_id: betId })).status;

// 3. mutual settle (50/50), both parties
const ms1 = await maker.functionCall({ contractId: C.ESCROW, methodName: "mutual_settle", args: { bet_id: betId, split_maker_bps: 5000 }, gas: 100_000_000_000_000n });
recordTx(`mutual_settle_maker_${kind}`, ms1.transaction.hash);
const ms2 = await taker.functionCall({ contractId: C.ESCROW, methodName: "mutual_settle", args: { bet_id: betId, split_maker_bps: 5000 }, gas: 200_000_000_000_000n });
recordTx(`mutual_settle_taker_${kind}`, ms2.transaction.hash);
await sleep(3000);
rec.status_after_settle = (await view("get_bet", { bet_id: betId })).status;
// 4. payout
for (let i = 0; i < 4; i++) {
  const b = await view("get_bet", { bet_id: betId }); if (b.status === "Settled") break;
  const d = await anyone.functionCall({ contractId: C.ESCROW, methodName: "drain_payouts", args: { bet_id: betId, limit: 20 }, gas: 300_000_000_000_000n });
  recordTx(`drain_payouts_${kind}_${i}`, d.transaction.hash); await sleep(4000);
}
const fin = await view("get_bet", { bet_id: betId });
rec.final_status = fin.status; rec.outcome = fin.outcome; rec.after = await snap();
rec.pending_payouts = (await view("pending_payouts_view", { from: 0, limit: 50 })).filter((p) => p.bet_id === betId).map((p) => ({ receiver: p.receiver, token: p.token_id, amount: p.amount, reason: p.reason, done: p.done }));
save({ ...results(), bets: { ...results().bets, [kind]: rec } });
console.log(JSON.stringify({ kind, betId, final: fin.status, payouts: rec.pending_payouts }, null, 1));
