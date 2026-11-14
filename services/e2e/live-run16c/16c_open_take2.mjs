// PHASE 16: copy of D-DEMO1 Jason sheet (date-only diff), live sourcecheck signed by attest1, open + take one USDC-vs-USDC bet, then keeper request_resolution.
// usage: NEAR_RPC_URL=... node 16_open_take.mjs   (writes services/e2e/live-run16c/results.json; NEVER touches live-run8/results.json)
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { account, mk } from "../live-run16a/lib.mjs";
import * as C from "../live-run8/config.mjs";
const { load, save, recordTx } = mk("../live-run16c/results_try2.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIR = new URL(".", import.meta.url).pathname;
const ATTEST1 = "126d917e6e17661d7d4f34e9430b9db75a45ce531bb879b25e709c3d2aa7fe4d";
const maker = await account(C.MAKER), taker = await account(C.TAKER), keeper = await account(C.KEEPER);
const view = (m, a) => keeper.viewFunction({ contractId: C.ESCROW, methodName: m, args: a });
// --- terms: Jason sheet, only the 2028 -> 2025 year changed so the deadline is already passed
const orig = JSON.parse(fs.readFileSync(DIR + "../live-run8/job_sourcecheck.json", "utf8")).terms;
const terms = orig.replaceAll("2028-10-28", "2025-10-28").replaceAll("October 28, 2028", "October 28, 2025").replaceAll("2028-11-04T19:00:00Z", "2025-11-04T19:00:00Z").replaceAll("2028-11-06T19:00:00Z", "2025-11-06T19:00:00Z").replace("2026-11-04T00:00:00Z", "2025-10-01T00:00:00Z");
const diff = { replaced: ["2028-10-28 -> 2025-10-28 (deadline, window_end)", "October 28, 2028 -> October 28, 2025", "evidence_cutoff 2028-11-04T19:00:00Z -> 2025-11-04T19:00:00Z", "window_close 2028-11-06T19:00:00Z -> 2025-11-06T19:00:00Z", "window_start 2026-11-04T00:00:00Z -> 2025-10-01T00:00:00Z (keeps window_start < window_end)"], occurrences: (orig.match(/2028/g) || []).length, remaining_2028: (terms.match(/2028/g) || []).length, orig_sha256: crypto.createHash("sha256").update(orig).digest("hex"), new_sha256: crypto.createHash("sha256").update(terms).digest("hex") };
fs.writeFileSync(DIR + "job_sourcecheck.json", JSON.stringify({ mode: "sourcecheck", terms }));
// keep job shape identical to live-run8's job file
const j8 = JSON.parse(fs.readFileSync(DIR + "../live-run8/job_sourcecheck.json", "utf8")); fs.writeFileSync(DIR + "job_sourcecheck.json", JSON.stringify({ ...j8, terms }));
let r = load(); r.txs = r.txs ?? []; r.terms_diff = diff; save(r);
console.log(JSON.stringify(diff));
// --- 1. live sourcecheck (attest1 is the signer)
const U = `https://test.fastfs.io/praetorial-dev-1101.testnet/outlayer.testnet/${C.RESOLVER_WASM_SHA}.wasm`;
const OL = ((process.env.PRAETORIAL_CACHE_DIR ?? (() => { throw new Error("set PRAETORIAL_CACHE_DIR (operator cache dir)"); })()) + "/scratch/olbin/outlayer");
let out; for (let a = 0; a < 3 && !out; a++) { try { out = execFileSync("/bin/sh", ["-c", `${OL} run --wasm ${U} --input ${DIR}job_sourcecheck.json 2>&1`], { env: { ...process.env, OUTLAYER_HOME: ((process.env.PRAETORIAL_CACHE_DIR ?? (() => { throw new Error("set PRAETORIAL_CACHE_DIR (operator cache dir)"); })()) + "/scratch/olhome-attest11b") }, encoding: "utf8", timeout: 280000 }); } catch (e) { console.log("outlayer run attempt failed, retrying"); } }
fs.writeFileSync(DIR + "sourcecheck.log", out);
const scTx = out.match(/Tx: (\S+)/)[1];
const sc = JSON.parse(out.slice(out.indexOf("{", out.indexOf("Tx:"))));
if (!sc.ok || !sc.signing || sc.signing.pubkey_hex !== ATTEST1) throw new Error("sourcecheck not ok / pubkey mismatch: " + JSON.stringify(sc).slice(0, 300));
recordTx("sourcecheck_attest1", scTx, { spec_hash: sc.spec_hash, checked_at: out.match(/"checked_at":\s*(\d+)/)[1], attest_pubkey: sc.signing.pubkey_hex, status: "Success" });
const checkedAtExact = out.match(/"checked_at":\s*(\d+)/)[1];
if (crypto.createHash("sha256").update(terms).digest("hex") !== sc.spec_hash) throw new Error("spec_hash != sha256(terms)");
// --- 2. mint, open, take
const makerAsset = C.USDC, takerAsset = C.USDC, stake = 10_000_000n, storage = 8000n, req = stake + storage;
const mint = async (to) => recordTx(`mint_usdc_${to.split(".")[0]}`, (await keeper.functionCall({ contractId: C.INTENTS, methodName: "mint", args: { account_id: to, token_id: C.USDC, amount: req.toString() }, gas: 30_000_000_000_000n })).transaction.hash, { status: "Success" });
await mint(C.MAKER); await mint(C.TAKER);
const now = Date.now() * 1e6;
const envelope = {
  bet_id: 0, version: 1, maker: C.MAKER, taker_allow: { Any: {} }, terms_hash: sc.spec_hash,
  models_snapshot_hash: "item16c-testnet-e2e", outcomes: ["YES", "NO"], maker_side: "YES",
  maker_asset: makerAsset, taker_asset: takerAsset, stake_maker: stake.toString(), stake_taker: stake.toString(), fee_bps: 100,
  storage_charge_per_side: storage.toString(), keep_terms: true, terms, max_paid_runs: 3, tier: 1,
  funding_deadline: now + 150e9, early_settle_outcome: null, finality_delay: 0,
  settlement_period: 3600e9, resolve_deadline: now + 30 * 86400e9, consent_party_controlled: false,
};
const { buildOpenMsg } = await import(new URL("../../common/src/openMsg.ts", import.meta.url).href);
const msg = buildOpenMsg(envelope, { checked_at: checkedAtExact, signature_hex: sc.signing.signature_hex });
const open = await maker.functionCall({ contractId: C.INTENTS, methodName: "transfer_with_msg", args: { receiver_id: C.ESCROW, token_id: makerAsset, amount: req.toString(), msg }, gas: 80_000_000_000_000n });
recordTx("open_usdc", open.transaction.hash);
let bet;
for (let i = 0; i < 20 && !bet; i++) { if (i) await sleep(1500); const offers = await view("open_offers", { from: 0, limit: 200 }); bet = offers.filter((b) => b.envelope.maker === C.MAKER && b.envelope.terms_hash === sc.spec_hash).pop(); }
if (!bet) throw new Error("open did not create an offer");
const betId = bet.envelope.bet_id;
r = load(); r.bet_id = betId; r.envelope_settlement_period_s = 3600; save(r);
const take = await taker.functionCall({ contractId: C.INTENTS, methodName: "transfer_with_msg", args: { receiver_id: C.ESCROW, token_id: takerAsset, amount: req.toString(), msg: JSON.stringify({ kind: "Take", bet_id: betId, invite_sig: null }) }, gas: 80_000_000_000_000n });
recordTx("take_usdc", take.transaction.hash);
await sleep(3000);
r = load(); r.status_after_take = (await view("get_bet", { bet_id: betId })).status; save(r);
console.log("bet", betId, "status", r.status_after_take);
