// DRILL1 step 1: open bets A (stays Open), B (Taken), C (Taken) on the throwaway escrow. Mock-intents USDC (the asset in the FRZ1b asset table; see README: no wNEAR asset in FRZ1b config).
// usage (from services/): NEAR_RPC_URL=... node --import tsx e2e/live-DRILL1/1_bets.mjs
import fs from "node:fs"; import crypto from "node:crypto"; import { execFileSync } from "node:child_process";
import { account, viewer, load, save, recordTx, observe, MAKER, TAKER, KEEPER, FEE, INTENTS, USDC, DIR, bal, sleep } from "./lib.mjs";
import { buildOpenMsg } from "../../common/src/openMsg.ts";
import { estimatedStorageBytes, storageForRate } from "../../common/src/storageCharge.ts";
const S = ((process.env.PRAETORIAL_CACHE_DIR ?? (() => { throw new Error("set PRAETORIAL_CACHE_DIR (operator cache dir)"); })()) + "/scratch");
const R0 = load(); const ESC = R0.escrow; const args = R0.new_args;
const maker = await account(MAKER), taker = await account(TAKER), keeper = await account(KEEPER), v = await viewer();
const view = (m, a = {}) => v.viewFunction({ contractId: ESC, methodName: m, args: a });
const url = `${args.outlayer_config.wasm_base_url}/${args.resolver_wasm_hash}.wasm`;
const baseTerms = JSON.parse(fs.readFileSync(DIR + "../live-run16/job_sourcecheck.json", "utf8")).terms;
const stake = 10_000_000n;
const rate = (await view("asset_limit", { asset_id: USDC })).storage_per_kib;
async function sourcecheck(label) {
  const terms = baseTerms.replace("Canonical Jason-bet term sheet", `DRILL1 bet ${label} on ${ESC}`);
  const file = `${DIR}job_sourcecheck_${label}.json`;
  const j8 = JSON.parse(fs.readFileSync(DIR + "../live-run16/job_sourcecheck.json", "utf8")); fs.writeFileSync(file, JSON.stringify({ ...j8, terms }));
  let out; for (let a = 0; a < 3 && !out; a++) { try { out = execFileSync("/bin/sh", ["-c", `outlayer run --wasm ${url} --input ${file} 2>&1`], { env: { ...process.env, OUTLAYER_HOME: `${S}/olhome-frz1b-attest` }, encoding: "utf8", timeout: 280000 }); } catch (e) { console.log("outlayer retry"); } }
  fs.writeFileSync(`${DIR}sourcecheck_${label}.log`, out);
  const tx = out.match(/Tx: (\S+)/)[1]; const sc = JSON.parse(out.slice(out.indexOf("{", out.indexOf("Tx:"))));
  if (!sc.ok || sc.signing.pubkey_hex !== args.attest_pubkey) throw new Error("sourcecheck not ok / attest pubkey mismatch");
  if (crypto.createHash("sha256").update(terms).digest("hex") !== sc.spec_hash) throw new Error("spec_hash != sha256(terms)");
  recordTx(`sourcecheck_${label}`, tx, { spec_hash: sc.spec_hash });
  return { terms, sc, checkedAt: out.match(/"checked_at":\s*(\d+)/)[1] };
}
{ const r = load(); r.balances = r.balances ?? {}; r.balances.before = {}; for (const a of [MAKER, TAKER, FEE]) r.balances.before[a] = (await bal(v, a)).toString(); r.escrow_balance = { before: (await bal(v, ESC)).toString() }; save(r); }
const bets = {}; const ids = new Set();
const mintAmt = {};
for (const label of ["A", "B", "C"]) {
  const { terms, sc, checkedAt } = await sourcecheck(label);
  const bytes = estimatedStorageBytes(terms, sc.spec_hash, "drill1-testnet");
  const storage = storageForRate(bytes, rate); const req = stake + storage;
  bets[label] = { storage: storage.toString(), req: req.toString(), spec_hash: sc.spec_hash };
  // mint exactly what this bet needs (maker always; taker only for B, C)
  for (const who of label === "A" ? [MAKER] : [MAKER, TAKER]) {
    const r = await keeper.functionCall({ contractId: INTENTS, methodName: "mint", args: { account_id: who, token_id: USDC, amount: req.toString() }, gas: 30_000_000_000_000n });
    recordTx(`mint_${label}_${who.split(".")[0]}`, r.transaction.hash);
  }
  if (label === "A") { // record before-balances once, after the first mint but before any deposit
    // maker was just minted req_A; subtract it so "before" is the pre-drill balance
  }
  const now = Date.now() * 1e6;
  const envelope = { bet_id: 0, version: 1, maker: MAKER, taker_allow: { Any: {} }, terms_hash: sc.spec_hash, models_snapshot_hash: "drill1-testnet", outcomes: ["YES", "NO"], maker_side: "YES", maker_asset: USDC, taker_asset: USDC, stake_maker: stake.toString(), stake_taker: stake.toString(), fee_bps: 100, storage_charge_per_side: "0", keep_terms: true, terms, max_paid_runs: 3, tier: 1, funding_deadline: now + 7200e9, early_settle_outcome: null, finality_delay: 0, settlement_period: 3600e9, resolve_deadline: now + 30 * 86400e9, consent_party_controlled: false };
  const before = await view("bet_count");
  const open = await maker.functionCall({ contractId: INTENTS, methodName: "transfer_with_msg", args: { receiver_id: ESC, token_id: USDC, amount: req.toString(), msg: buildOpenMsg(envelope, { checked_at: checkedAt, signature_hex: sc.signing.signature_hex }) }, gas: 80_000_000_000_000n });
  recordTx(`open_${label}`, open.transaction.hash);
  let id = null; for (let i = 0; i < 20 && id === null; i++) { if (i) await sleep(1500); if ((await view("bet_count")) > before) id = Number(before) + 0; }
  const all = await view("open_offers", { from: 0, limit: 200 }); const mine = all.filter((b) => b.envelope.terms_hash === sc.spec_hash).pop();
  if (!mine) throw new Error(`open ${label} did not create an offer`);
  bets[label].id = mine.envelope.bet_id; bets[label].terms = terms;
  if (label !== "A") {
    const t = await taker.functionCall({ contractId: INTENTS, methodName: "transfer_with_msg", args: { receiver_id: ESC, token_id: USDC, amount: req.toString(), msg: JSON.stringify({ kind: "Take", bet_id: mine.envelope.bet_id, invite_sig: null }) }, gas: 80_000_000_000_000n });
    recordTx(`take_${label}`, t.transaction.hash);
  }
  await sleep(3000);
  const b = await view("get_bet", { bet_id: mine.envelope.bet_id });
  bets[label].status_after = b.status; bets[label].storage_maker_view = b.storage_maker; bets[label].storage_taker_view = b.storage_taker; bets[label].fee_min_maker = b.fee_min_maker; bets[label].fee_min_taker = b.fee_min_taker;
  console.log(label, mine.envelope.bet_id, b.status);
}
const r = load(); r.bets = Object.fromEntries(Object.entries(bets).map(([k, x]) => { const { terms, ...rest } = x; return [k, rest]; })); r.stake = stake.toString(); save(r);
console.log(JSON.stringify(r.bets));
