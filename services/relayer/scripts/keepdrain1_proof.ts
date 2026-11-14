// KEEPDRAIN1 live testnet proof (testnet only; never prints keys): open a fresh bet, maker cancels it directly, then ONLY WAIT: the deployed
// keeper Worker's cron must drain the cancel_expire_refund line (no manual drain_payouts call is made anywhere). Records tx hashes.
// usage (from services/): NEAR_RPC_URL=<testnet rpc> [RELAYER_URL=...] node --import tsx relayer/scripts/keepdrain1_proof.ts
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

const HOME = process.env.HOME!, CRED = `${HOME}/.near-credentials/testnet`;
const RPC = process.env.NEAR_RPC_URL; if (!RPC) throw new Error("set NEAR_RPC_URL (testnet)");
const WORKER = process.env.RELAYER_URL ?? "https://praetorial-relayer-testnet.familiarcow.workers.dev";
const ESCROW = "praetorial-frz1b-2611081810.praetorial-dev-1101.testnet", INTENTS = "intents-mock.praetorial-dev-1101.testnet";
const FUNDER = process.env.FUNDER ?? "praetorial-dev-1101.testnet", KEEPER = "keeper.praetorial-dev-1101.testnet";
const REF_A = "arbiter1.praetorial-dev-1101.testnet", REF_B = "keeper.praetorial-dev-1101.testnet"; // existing testnet accounts (fee_account is fee.*, excluded)
const USDC = "nep141:usdc.testnet", ATTEST1 = "b0bd538e5a1cc4a31216a8020f992b3f9dcde612bc9889c7a828dc697abf8e9f";
const OUT = new URL("../../e2e/live-KEEPDRAIN1/results.json", import.meta.url).pathname;
fs.mkdirSync(new URL("../../e2e/live-KEEPDRAIN1/", import.meta.url).pathname, { recursive: true });
const res: any = { network: "testnet", worker: WORKER, escrow: ESCROW, txs: [], checks: {} };
const save = () => fs.writeFileSync(OUT, JSON.stringify(res, null, 2));
const rec = (step: string, hash: string, extra: any = {}) => { res.txs.push({ step, hash, url: `https://testnet.nearblocks.io/txns/${hash}`, ...extra }); save(); console.log("tx", step, hash); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (m: string) => { res.failed = m; save(); console.log("PROOF FAILED:", m); process.exit(1); };

const ks = new keyStores.InMemoryKeyStore();
const near = await connect({ networkId: "testnet", nodeUrl: RPC, keyStore: ks });
const load = async (id: string) => { await ks.setKey("testnet", id, KeyPair.fromString(JSON.parse(fs.readFileSync(`${CRED}/${id}.json`, "utf8")).private_key)); return near.account(id); };
const funder: any = await load(FUNDER), keeper: any = await load(KEEPER); // keeper key only mints mock USDC to the maker (never drains)
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
const work = `${process.env.TMPDIR ?? "/tmp"}/keepdrain1_${Date.now()}`; fs.mkdirSync(work, { recursive: true });
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
const dep0 = dep;
const before = await view(INTENTS, "mt_balance_of", { account_id: MAKER, token_id: USDC });
const cancel: any = await maker.functionCall({ contractId: ESCROW, methodName: "cancel", args: { bet_id: betId }, gas: 100_000_000_000_000n });
rec("cancel (maker direct)", cancel.transaction.hash);
res.cancel_at_ms = Date.now();
// ONLY WAIT: up to 6 minutes for the keeper cron to drain the refund line. Never call drain_payouts here.
let lines: any[] = [];
for (let i = 0; i < 72; i++) {
  await sleep(5000);
  lines = await view(ESCROW, "pending_payouts_view", { from: 1, limit: 2000 }).then((l: any[]) => l.filter((p) => p.bet_id === betId));
  if (lines.length && lines.every((p) => p.done)) break;
}
const after = await view(INTENTS, "mt_balance_of", { account_id: MAKER, token_id: USDC });
res.drained_after_ms = Date.now() - res.cancel_at_ms;
res.checks = { bet_id: betId, lines, maker_usdc_before_cancel: before, maker_usdc_after: after, deposit: dep0, status: (await view(ESCROW, "get_bet", { bet_id: betId })).status };
res.ok = lines.length > 0 && lines.every((p) => p.done) && BigInt(after) - BigInt(before) === BigInt(dep0);
save();
console.log(res.ok ? "PROOF OK keeper drained refund" : "PROOF FAILED: keeper did not drain", JSON.stringify(res.checks));
process.exit(res.ok ? 0 : 1);
