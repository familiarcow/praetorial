// NOKEY1b (copy of RFRZ2 human_bet.mjs, AI mode): live proof the frz2 resolver uses the real NEAR AI judge.
// was: RFRZ2 live Human-mode (referee) bet on the NEW escrow, built with the web's own modules (custom builder -> buildOpenEnvelope -> buildOpenMsg).
// Sourcecheck attestation comes from the deployed Worker (signed by attest1, verified by the contract against the pinned key).
// usage (from apps/web so tsx resolves): node --import tsx ../../services/e2e/live-RFRZ2/human_bet.mjs
import fs from "node:fs";
import { execFileSync } from "node:child_process";
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
const ESCROW = fs.readFileSync(DIR + "./escrow_name.txt", "utf8").trim();
const INTENTS = "intents-mock.praetorial-dev-1101.testnet", USDC = "nep141:usdc.testnet";
const MAKER = "maker1.praetorial-dev-1101.testnet", TAKER = "praetorial-dev-1101.testnet", REFEREE = "keeper.praetorial-dev-1101.testnet", MINTER = "keeper.praetorial-dev-1101.testnet";
const resFile = DIR + "prove_results.json";
const res = fs.existsSync(resFile) ? JSON.parse(fs.readFileSync(resFile, "utf8")) : { txs: [] };
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

const keys = await view("resolver_keys");
const pinErr = await checkOpenPins(async () => keys);
if (pinErr) throw new Error("checkOpenPins refused: " + pinErr);
res.resolver_keys = keys; res.escrow = ESCROW;

const nowMs = Date.now();
const dl = (m) => new Date(nowMs + m * 60_000).toISOString().slice(0, 16);
const form = {
  ...blankCustomForm(),
  claim: "NOKEY1b rehearsal: the iana.org home page mentions the Internet Assigned Numbers Authority.",
  elements: ["Does the iana.org home page mention the Internet Assigned Numbers Authority?"],
  sources: [{ publisher: "IANA", url: "https://www.iana.org/", partyControlled: false }, { publisher: "ICANN", url: "https://www.icann.org/", partyControlled: false }],
  windowStart: dl(-30), windowEnd: dl(-20), evidenceCutoff: dl(-10),
  fallbackRule: "Fallback: if a named source is unavailable the answer is could-not-check.",
  earlyRule: "No early resolution.",
};
const sheet = sheetFromCustomForm(form);
const problems = customOpenProblems(sheet, { humanReferee: false });
if (problems.length) throw new Error("lint: " + problems.join("; "));
const deadlineSecs = Math.floor(nowMs / 1000) + 240; // funding closes in 4 min; the referee rules after it (contract: now >= funding_deadline)
const built = buildOpenEnvelope({ maker: MAKER, sheet, customDeadlineSecs: deadlineSecs, makerAsset: USDC, takerAsset: USDC, stakeMaker: "10000000", stakeTaker: "10000000", takerAccount: null, referee: null, nowMs });
fs.writeFileSync(DIR + "prove_envelope.json", JSON.stringify(built, null, 2));

// The deployed sourcecheck Worker still points at frz2 (NOKEY1b step 8 repoints it), so run the same OutLayer sourcecheck job directly as attest1 against the frz3 pinned hash.
const HASH = keys[2];
fs.writeFileSync(DIR + "sc_input.json", JSON.stringify({ mode: "sourcecheck", terms: built.terms }));
const scOut = execFileSync(process.env.HOME + "/.local/bin/outlayer", ["run", "--wasm", `https://test.fastfs.io/praetorial-dev-1101.testnet/outlayer.testnet/${HASH}.wasm`, "--hash", HASH, "--input", DIR + "sc_input.json"], { env: { ...process.env, OUTLAYER_HOME: (process.env.PRAETORIAL_CACHE_DIR ?? (() => { throw new Error("set PRAETORIAL_CACHE_DIR (operator cache dir)"); })()) + "/scratch/olhome-frz2-attest" }, encoding: "utf8", timeout: 240000 });
const txt = scOut.slice(scOut.indexOf("{"));
const sc = JSON.parse(txt.replace(/"checked_at":\s*(\d{16,})/, '"checked_at":"$1"'));
fs.writeFileSync(DIR + "prove_sourcecheck.json", JSON.stringify({ via: "outlayer-cli-as-attest1", ok: sc.ok, unreachable: sc.unreachable, spec_hash: sc.spec_hash, checked_at: sc.checked_at, pubkey_equals_pinned: sc.signing?.pubkey_hex === keys[1] }, null, 2));
if (!sc.ok || sc.spec_hash !== built.terms_hash) throw new Error("sourcecheck refused: " + txt.slice(0, 300));
const msg = buildOpenMsg(built, { checked_at: sc.checked_at, signature_hex: sc.signing.signature_hex }, null);
const dep = makerDeposit(built, "37684");

const minter = referee; // keeper is the mock's minter
const b0 = { maker: await bal(MAKER), taker: await bal(TAKER), fee: await bal("fee.praetorial-dev-1101.testnet") };
let t = await minter.functionCall({ contractId: INTENTS, methodName: "mint", args: { account_id: MAKER, token_id: USDC, amount: dep }, gas: 30_000_000_000_000n }); rec("mint_maker", t.transaction.hash, { amount: dep });
t = await minter.functionCall({ contractId: INTENTS, methodName: "mint", args: { account_id: TAKER, token_id: USDC, amount: dep }, gas: 30_000_000_000_000n }); rec("mint_taker", t.transaction.hash, { amount: dep });
const before = (await view("open_offers", { from: 0, limit: 500 })).length;
t = await maker.functionCall({ contractId: INTENTS, methodName: "transfer_with_msg", args: { receiver_id: ESCROW, token_id: USDC, amount: dep, msg }, gas: 80_000_000_000_000n }); rec("open_human_bet", t.transaction.hash, { amount: dep });
await sleep(4000);
const offers = await view("open_offers", { from: 0, limit: 500 });
if (offers.length !== before + 1) throw new Error("open did not create an offer (refunded?)");
const bet = offers[offers.length - 1]; const betId = bet.envelope?.bet_id ?? bet.id ?? bet.bet_id;
res.bet_id = betId; save(); console.log("bet", betId);
t = await taker.functionCall({ contractId: INTENTS, methodName: "transfer_with_msg", args: { receiver_id: ESCROW, token_id: USDC, amount: dep, msg: buildTakeMsg(betId, null) }, gas: 80_000_000_000_000n }); rec("take_human_bet", t.transaction.hash, { amount: dep });
await sleep(3000);
let b = await view("get_bet", { bet_id: betId }); console.log("status after take", b.status); res.status_after_take = b.status; save();
if (b.status !== "Taken") throw new Error("not taken: " + b.status);
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
