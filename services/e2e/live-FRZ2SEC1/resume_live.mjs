// FRZ2SEC1 (copy of RFRZ2 human_bet.mjs, AI mode): live proof the frz2 resolver uses the real NEAR AI judge.
// was: RFRZ2 live Human-mode (referee) bet on the NEW escrow, built with the web's own modules (custom builder -> buildOpenEnvelope -> buildOpenMsg).
// Sourcecheck attestation comes from the deployed Worker (signed by attest1, verified by the contract against the pinned key).
// usage (from apps/web so tsx resolves): node --import tsx ../../services/e2e/live-RFRZ2/human_bet.mjs
import fs from "node:fs";
import { assertRealJudge } from "../live-DR/harness/judgeBackend.ts";
import { resolveRpcUrls } from "../../common/src/rpc.ts";
import { createRequire } from "node:module";
import { blankCustomForm, sheetFromCustomForm } from "../../../apps/web/lib/customBuilder";
import { customOpenProblems } from "../../../apps/web/lib/customLint";
import { buildOpenEnvelope, makerDeposit } from "../../../apps/web/lib/openEnvelope";
import { checkOpenPins } from "../../../apps/web/lib/openPins";
import { buildOpenMsg, buildTakeMsg } from "../../../apps/web/lib/escrowAdapter";

const require = createRequire(new URL("../../package.json", import.meta.url));
const { connect, keyStores, KeyPair } = require("near-api-js");
const DIR = new URL(".", import.meta.url).pathname;
const RPC = resolveRpcUrls("testnet").primary; // shared RPC config (services/common/src/rpc.ts)
const ESCROW = fs.readFileSync(DIR + "../live-RFRZ2/escrow_name.txt", "utf8").trim();
const INTENTS = "intents-mock.praetorial-dev-1101.testnet", USDC = "nep141:usdc.testnet";
const MAKER = "maker1.praetorial-dev-1101.testnet", TAKER = "praetorial-dev-1101.testnet", REFEREE = "keeper.praetorial-dev-1101.testnet", MINTER = "keeper.praetorial-dev-1101.testnet";
const resFile = DIR + "prove_results.json";
const res = JSON.parse(fs.readFileSync(resFile, "utf8"));
const save = () => fs.writeFileSync(resFile, JSON.stringify(res, null, 2));
const rec = (step, hash, extra = {}) => { res.txs.push({ step, hash, url: `https://testnet.nearblocks.io/txns/${hash}`, ...extra }); save(); console.log("tx", step, hash); };
const acct = async (id) => {
  const ks = new keyStores.InMemoryKeyStore();
  const k = JSON.parse(fs.readFileSync(`${process.env.HOME}/.near-credentials/testnet/${id}.json`, "utf8"));
  await ks.setKey("testnet", id, KeyPair.fromString(k.private_key));
  return (await connect({ networkId: "testnet", nodeUrl: RPC, keyStore: ks })).account(id);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maker = await acct(MAKER), taker = await acct(TAKER), referee = await acct(REFEREE);
const view = (m, a = {}) => referee.viewFunction({ contractId: ESCROW, methodName: m, args: a });
const bal = async (id) => BigInt(await referee.viewFunction({ contractId: INTENTS, methodName: "mt_balance_of", args: { account_id: id, token_id: USDC } }));

const keys = await view("resolver_keys"); // resume
const pinErr = await checkOpenPins(async () => keys);
if (pinErr) throw new Error("checkOpenPins refused: " + pinErr);
res.resolver_keys = keys; res.escrow = ESCROW;

const betId = res.bet_id; let b = await view("get_bet", { bet_id: betId });
console.log("resume bet", betId, b.status);
const dev = taker; // praetorial-dev-1101.testnet: top up the keeper (testnet only) so request_resolution's gas reserve fits
const kb = BigInt((await referee.getAccountBalance()).available);
if (kb < 1_000_000_000_000_000_000_000_000n) { const t0 = await dev.sendMoney(REFEREE, 1_000_000_000_000_000_000_000_000n); rec("fund_keeper_1_near", t0.transaction.hash); }
const cred = BigInt(await view("keeper_credit_balance")); console.log("keeper_credit before", cred.toString());
if (cred < 500_000_000_000_000_000_000_000n) { const t1 = await referee.functionCall({ contractId: ESCROW, methodName: "topup_keeper_credit", args: {}, gas: 30_000_000_000_000n, attachedDeposit: 600_000_000_000_000_000_000_000n }); rec("topup_keeper_credit_0.6_near", t1.transaction.hash); }
while (await view("can_request_resolution", { bet_id: betId })) await sleep(10000);
const keeperAcct = referee;
let reqTx = null, lastErr = "";
for (let i = 0; i < 30 && !reqTx; i++) {
  try { const rr = await keeperAcct.functionCall({ contractId: ESCROW, methodName: "request_resolution", args: { bet_id: betId }, gas: 280_000_000_000_000n, attachedDeposit: 0n }); reqTx = rr.transaction.hash; rec("request_resolution", reqTx); }
  catch (e) { lastErr = String(e.message).slice(0, 200); console.log("request_resolution retry:", lastErr); await sleep(20000); }
}
if (!reqTx) throw new Error("request_resolution never accepted: " + lastErr);
for (let i = 0; i < 80; i++) { b = await view("get_bet", { bet_id: betId }); console.log(i, b.status); if (b.status !== "Resolving") break; await sleep(6000); }
res.final_status = b.status; res.final_outcome = b.outcome; save();
const lr = b.last_resolution_raw;
const jb = JSON.parse(lr).judge;
console.log("judge_backend", jb.judge_backend, "reason", jb.judge_backend_reason, "http_status", JSON.stringify((jb.run_diagnostics ?? []).map((d) => d.http_status)), "models", JSON.stringify(jb.models_requested));
res.judge = { judge_backend: jb.judge_backend, judge_backend_reason: jb.judge_backend_reason, http_status: (jb.run_diagnostics ?? []).map((d) => d.http_status), models_requested: jb.models_requested, models_echoed: jb.models_echoed };
res.credits_error_check = JSON.stringify(jb.run_diagnostics ?? []).match(/402|insufficient|credit|quota|limit exceeded/i)?.[0] ?? null; save();
console.log("credit/quota hit:", res.credits_error_check);
assertRealJudge(lr, "get_bet.last_resolution_raw");
console.log("assertRealJudge OK; status", b.status, "outcome", b.outcome);
