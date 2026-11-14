// RLYDEP1 / RELAYREF1 live testnet proof through the DEPLOYED relayer Worker (testnet only; never prints keys).
// (a) fresh maker opens a Person-referee USDC bet on the frz1b escrow, (b) amend_referee relayed (deposit 0) -> get_bet referee changed,
// (c) bad-args amend_referee (extra key) -> HTTP 400 PolicyViolation, no tx broadcast, (d) cancel relayed -> maker refunded, escrow holds 0 for the bet.
// usage (from services/): NEAR_RPC_URL=<testnet rpc> [RELAYER_URL=...] node --import tsx relayer/scripts/relayref1_proof.ts
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { KeyPair, connect, keyStores } from "near-api-js";
import { actionCreators, buildDelegateAction, Signature, SCHEMA, encodeDelegateAction } from "@near-js/transactions";
import * as borsh from "borsh";
import { buildOpenEnvelope, makerDeposit } from "../../../apps/web/lib/openEnvelope";
import { fieldsFromForm } from "../../../apps/web/lib/guidedFields";
import { checkOpenPins } from "../../../apps/web/lib/openPins";
import { buildOpenMsg } from "../../../apps/web/lib/escrowAdapter";
import { lintAnySheet } from "../../../apps/web/lib/templates";
import { amendRefereeArgs, badAmendRefereeArgs, checkRefundSettled } from "../src/relayref1Proof.js";

const HOME = process.env.HOME!, CRED = `${HOME}/.near-credentials/testnet`;
const RPC = process.env.NEAR_RPC_URL; if (!RPC) throw new Error("set NEAR_RPC_URL (testnet)");
const WORKER = process.env.RELAYER_URL ?? "https://praetorial-relayer-testnet.familiarcow.workers.dev";
const ESCROW = "praetorial-frz1b-2611081810.praetorial-dev-1101.testnet", INTENTS = "intents-mock.praetorial-dev-1101.testnet";
const FUNDER = process.env.FUNDER ?? "praetorial-dev-1101.testnet", KEEPER = "keeper.praetorial-dev-1101.testnet";
const REF_A = "arbiter1.praetorial-dev-1101.testnet", REF_B = "keeper.praetorial-dev-1101.testnet"; // existing testnet accounts (fee_account is fee.*, excluded)
const USDC = "nep141:usdc.testnet", ATTEST1 = "b0bd538e5a1cc4a31216a8020f992b3f9dcde612bc9889c7a828dc697abf8e9f";
const OUT = new URL("../../e2e/live-RLYDEP1/results.json", import.meta.url).pathname;
fs.mkdirSync(new URL("../../e2e/live-RLYDEP1/", import.meta.url).pathname, { recursive: true });
const res: any = { network: "testnet", worker: WORKER, escrow: ESCROW, txs: [], checks: {} };
const save = () => fs.writeFileSync(OUT, JSON.stringify(res, null, 2));
const rec = (step: string, hash: string, extra: any = {}) => { res.txs.push({ step, hash, url: `https://testnet.nearblocks.io/txns/${hash}`, ...extra }); save(); console.log("tx", step, hash); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (m: string) => { res.failed = m; save(); console.log("PROOF FAILED:", m); process.exit(1); };

const ks = new keyStores.InMemoryKeyStore();
const near = await connect({ networkId: "testnet", nodeUrl: RPC, keyStore: ks });
const load = async (id: string) => { await ks.setKey("testnet", id, KeyPair.fromString(JSON.parse(fs.readFileSync(`${CRED}/${id}.json`, "utf8")).private_key)); return near.account(id); };
const funder: any = await load(FUNDER), keeper: any = await load(KEEPER);
const provider: any = (near.connection as any).provider;
const view = (contractId: string, methodName: string, args: any = {}) => funder.viewFunction({ contractId, methodName, args });

// fresh maker: implicit account (key never leaves memory), funded by the testnet funder.
const makerKey = KeyPair.fromRandom("ed25519");
const pub: any = makerKey.getPublicKey();
const MAKER = Buffer.from(pub.data).toString("hex");
await ks.setKey("testnet", MAKER, makerKey);
res.maker = MAKER; res.refereeA = REF_A; res.refereeB = REF_B;
const fund: any = await funder.sendMoney(MAKER, 300_000_000_000_000_000_000_000n);
rec("setup: fund fresh maker 0.3 NEAR (direct)", fund.transaction.hash);
await sleep(3000);
const maker: any = await near.account(MAKER);

// (a) open a Person-referee bet (web's own builders; real pins; fresh sourcecheck attestation).
const nowMs = Date.now();
const tMs = Math.ceil((nowMs + 65 * 60_000) / 60_000) * 60_000;
const form = { t_utc: new Date(tMs).toISOString().slice(0, 16), op: ">=", x_usd: "75900" };
const sheet = { template: { id: "btc_close_at_t", version: 1 }, fields: fieldsFromForm("btc_close_at_t", form, nowMs) };
const lint = lintAnySheet(sheet); if (lint.length) fail("web lint refused the sheet: " + lint.join("; "));
const keys = await view(ESCROW, "resolver_keys");
const pinErr = await checkOpenPins(async () => keys); if (pinErr) fail("checkOpenPins refused: " + pinErr);
const built: any = buildOpenEnvelope({ maker: MAKER, sheet, makerAsset: USDC, takerAsset: USDC, stakeMaker: "10000000", stakeTaker: "10000000", takerAccount: null, referee: { account: REF_A, mode: "Human" }, nowMs });
const work = `${process.env.TMPDIR ?? "/tmp"}/relayref1_${Date.now()}`; fs.mkdirSync(work, { recursive: true });
fs.writeFileSync(`${work}/job.json`, JSON.stringify({ mode: "sourcecheck", terms: built.terms }));
const wasm = `https://test.fastfs.io/praetorial-dev-1101.testnet/outlayer.testnet/${keys[2]}.wasm`;
let out = "";
for (let a = 0; a < 3 && !out; a++) {
  try { out = execFileSync("/bin/sh", ["-c", `${HOME}/.local/bin/outlayer run --wasm ${wasm} --input ${work}/job.json 2>&1`], { env: { ...process.env, OUTLAYER_HOME: `${(process.env.PRAETORIAL_CACHE_DIR ?? (() => { throw new Error("set PRAETORIAL_CACHE_DIR (operator cache dir)"); })())}/scratch/olhome-frz1b-attest` }, encoding: "utf8", timeout: 280000 }); }
  catch { console.log("outlayer attempt failed, retrying"); }
}
if (!out) fail("outlayer sourcecheck produced no output");
const sc = JSON.parse(out.slice(out.indexOf("{", out.indexOf("Tx:"))));
if (!sc.ok || sc.signing?.pubkey_hex !== ATTEST1 || sc.spec_hash !== built.terms_hash) fail("sourcecheck not ok / pubkey or spec_hash mismatch");
rec("sourcecheck_attest1", out.match(/Tx: (\S+)/)![1], { status: "Success" });
const msg = buildOpenMsg(built, { checked_at: out.match(/"checked_at":\s*(\d+)/)![1] as any, signature_hex: sc.signing.signature_hex }, null);
const dep = makerDeposit(built, "37684");
const escrowBefore = await view(INTENTS, "mt_balance_of", { account_id: ESCROW, token_id: USDC });
const mint: any = await keeper.functionCall({ contractId: INTENTS, methodName: "mint", args: { account_id: MAKER, token_id: USDC, amount: dep }, gas: 30_000_000_000_000n });
rec("mint mock USDC to maker (keeper, direct)", mint.transaction.hash, { amount: dep });
const open: any = await maker.functionCall({ contractId: INTENTS, methodName: "transfer_with_msg", args: { receiver_id: ESCROW, token_id: USDC, amount: dep, msg }, gas: 80_000_000_000_000n });
rec("open Person-referee bet (maker direct)", open.transaction.hash, { amount: dep });
let bet: any;
for (let i = 0; i < 25 && !bet; i++) { if (i) await sleep(1500); bet = (await view(ESCROW, "open_offers", { from: 0, limit: 500 })).filter((b: any) => b.envelope.maker === MAKER).pop(); }
if (!bet) fail("open created no offer (tx " + open.transaction.hash + ")");
const betId = bet.envelope.bet_id; res.bet_id = betId;
res.checks.referee_initial = bet.envelope.referee;
if (bet.envelope.referee?.account !== REF_A) fail("initial referee not " + REF_A);

// relay helper: maker-signed NEP-366 delegate POSTed to the DEPLOYED Worker.
async function relay(method: string, args: any) {
  const ak: any = await provider.query({ request_type: "view_access_key", finality: "final", account_id: MAKER, public_key: pub.toString() });
  const blk: any = await provider.block({ finality: "final" });
  const da = buildDelegateAction({ senderId: MAKER, receiverId: ESCROW, actions: [actionCreators.functionCall(method, args, 100_000_000_000_000n, 0n)], nonce: BigInt(ak.nonce) + 1n, maxBlockHeight: BigInt(blk.header.height) + 100n, publicKey: pub });
  const hash = createHash("sha256").update(Buffer.from(encodeDelegateAction(da))).digest();
  const sig = new Signature({ keyType: 0, data: makerKey.sign(hash).signature });
  const b64 = Buffer.from(borsh.serialize(SCHEMA.SignedDelegate, { delegateAction: da, signature: sig })).toString("base64");
  const r = await fetch(`${WORKER}/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signedDelegate: b64 }) });
  return { status: r.status, body: await r.json().catch(() => ({})) as any };
}
const relayerNonce = async () => (await provider.query({ request_type: "view_access_key_list", finality: "final", account_id: "relayer.praetorial-dev-1101.testnet" })).keys.map((k: any) => k.access_key.nonce).sort().pop();

// (b) relayed amend_referee A -> B, deposit 0.
const rb = await relay("amend_referee", amendRefereeArgs(betId, { account: REF_B, mode: "Human" }));
res.checks.amend_http = { status: rb.status, body: rb.body };
const amendHash = rb.body.txHash ?? rb.body.tx_hash ?? rb.body.hash;
if (rb.status !== 200 || !amendHash) fail("relayed amend_referee failed: " + JSON.stringify(rb));
rec("relayed amend_referee (deployed Worker, deposit 0)", amendHash);
await sleep(3000);
const after = await view(ESCROW, "get_bet", { bet_id: betId });
res.checks.referee_after_amend = after.envelope.referee;
if (after.envelope.referee?.account !== REF_B) fail("referee did not change to " + REF_B + ": " + JSON.stringify(after.envelope.referee));

// (c) bad args: must be refused by policy, no tx broadcast (relayer nonce unchanged, referee unchanged).
const n0 = await relayerNonce();
const rc = await relay("amend_referee", badAmendRefereeArgs(betId, { account: REF_A, mode: "Human" }));
await sleep(3000);
const n1 = await relayerNonce();
res.checks.bad_args = { status: rc.status, body: rc.body, relayer_nonce_before: String(n0), relayer_nonce_after: String(n1) };
if (rc.status !== 400 || !/policy|amend_referee|not allowed|args/i.test(JSON.stringify(rc.body)) || rc.body.txHash) fail("bad-args amend_referee not refused with a policy 400: " + JSON.stringify(rc));
if (n0 !== n1) fail("relayer key nonce moved after the refused call (possible broadcast)");
res.checks.referee_after_bad = (await view(ESCROW, "get_bet", { bet_id: betId })).envelope.referee;
if (res.checks.referee_after_bad.account !== REF_B) fail("referee changed by the refused call");

// (d) cancel (relayed through the Worker too), maker refund must settle, escrow holds 0 for the bet.
const before = await view(INTENTS, "mt_balance_of", { account_id: MAKER, token_id: USDC });
const rd = await relay("cancel", { bet_id: betId });
const cancelHash = rd.body.txHash ?? rd.body.tx_hash ?? rd.body.hash;
res.checks.cancel_http = { status: rd.status, body: rd.body };
if (rd.status !== 200 || !cancelHash) fail("relayed cancel failed: " + JSON.stringify(rd));
rec("relayed cancel (deployed Worker)", cancelHash);
let verdict: string | null = "not checked", afterBal = before, escrowAfter = escrowBefore, owed = "0", keeperDrained = false;
const settle = async () => {
  afterBal = await view(INTENTS, "mt_balance_of", { account_id: MAKER, token_id: USDC });
  escrowAfter = await view(INTENTS, "mt_balance_of", { account_id: ESCROW, token_id: USDC });
  // "0 left in the escrow for that bet": no undone payout line for the bet (other bets' traffic moves the shared escrow balance, so that is informational only).
  owed = (await view(ESCROW, "pending_payouts", { bet_id: betId })).filter((p: any) => !p.done).reduce((t: bigint, p: any) => t + BigInt(p.amount), 0n).toString();
  verdict = checkRefundSettled({ before, after: afterBal, deposit: dep, escrowLeft: owed });
};
// the refund is a payout line the keeper's cron drains; give it up to 3 minutes, then fall back to the public drain_payouts (callable by anyone).
for (let i = 0; i < 36 && verdict !== null; i++) { await sleep(5000); await settle(); }
keeperDrained = verdict === null;
if (!keeperDrained) {
  const d: any = await keeper.functionCall({ contractId: ESCROW, methodName: "drain_payouts", args: { bet_id: betId, limit: 20 }, gas: 300_000_000_000_000n });
  rec("drain_payouts fallback (public method; the keeper cron had not drained it in 3 min)", d.transaction.hash);
  for (let i = 0; i < 10 && verdict !== null; i++) { await sleep(3000); await settle(); }
}
res.checks.refund = { keeper_cron_drained: keeperDrained, maker_usdc_before_cancel: before, maker_usdc_after_cancel: afterBal, deposit: dep, undone_payout_amount_for_bet: owed, escrow_usdc_before_open: escrowBefore, escrow_usdc_after_cancel: escrowAfter, verdict };
res.checks.bet_status_after_cancel = (await view(ESCROW, "get_bet", { bet_id: betId })).status;
res.checks.pending_payouts = await view(ESCROW, "pending_payouts", { bet_id: betId });
save();
if (verdict !== null) fail(verdict);
if (res.checks.bet_status_after_cancel !== "Cancelled") fail("bet status " + res.checks.bet_status_after_cancel);
res.ok = true; save();
console.log("PROOF OK", JSON.stringify(res.checks.refund));
