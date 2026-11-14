// RFRZ2 live Human-mode (referee) bet on the NEW escrow, built with the web's own modules (custom builder -> buildOpenEnvelope -> buildOpenMsg).
// Sourcecheck attestation comes from the deployed Worker (signed by attest1, verified by the contract against the pinned key).
// usage (from apps/web so tsx resolves): node --import tsx ../../services/e2e/live-RFRZ2/human_bet.mjs
import fs from "node:fs";
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
const ESCROW = fs.readFileSync(DIR + "escrow_name.txt", "utf8").trim();
const INTENTS = "intents-mock.praetorial-dev-1101.testnet", USDC = "nep141:usdc.testnet";
const MAKER = "maker1.praetorial-dev-1101.testnet", TAKER = "praetorial-dev-1101.testnet", REFEREE = "keeper.praetorial-dev-1101.testnet", MINTER = "keeper.praetorial-dev-1101.testnet";
const resFile = DIR + "human_bet_results.json";
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
  claim: "RFRZ2 rehearsal: the named referee rules this test bet YES.",
  elements: ["Does the named referee rule YES on this rehearsal bet?"],
  sources: [{ publisher: "IANA", url: "https://www.iana.org/", partyControlled: false }, { publisher: "Wikipedia", url: "https://en.wikipedia.org/wiki/Main_Page", partyControlled: false }],
  windowStart: dl(0), windowEnd: dl(3), evidenceCutoff: dl(4),
  fallbackRule: "Fallback: the referee decides if a named source is unavailable.",
  earlyRule: "Early YES resolution is allowed once the referee rules.",
};
const sheet = sheetFromCustomForm(form);
const problems = customOpenProblems(sheet, { humanReferee: true });
if (problems.length) throw new Error("lint: " + problems.join("; "));
const deadlineSecs = Math.floor(nowMs / 1000) + 240; // funding closes in 4 min; the referee rules after it (contract: now >= funding_deadline)
const built = buildOpenEnvelope({ maker: MAKER, sheet, customDeadlineSecs: deadlineSecs, makerAsset: USDC, takerAsset: USDC, stakeMaker: "10000000", stakeTaker: "10000000", takerAccount: null, referee: { account: REFEREE, mode: "Human" }, nowMs });
fs.writeFileSync(DIR + "human_envelope.json", JSON.stringify(built, null, 2));

const r = await fetch("https://praetorial-sourcecheck-testnet.familiarcow.workers.dev/sourcecheck", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "sourcecheck", terms: built.terms }) });
const txt = await r.text();
const sc = JSON.parse(txt.replace(/"checked_at":\s*(\d{16,})/, '"checked_at":"$1"'));
fs.writeFileSync(DIR + "human_sourcecheck.json", JSON.stringify({ http: r.status, ok: sc.ok, unreachable: sc.unreachable, spec_hash: sc.spec_hash, checked_at: sc.checked_at, error: sc.error }, null, 2));
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
t = await taker.functionCall({ contractId: INTENTS, methodName: "transfer_with_msg", args: { receiver_id: ESCROW, token_id: USDC, amount: dep, msg: buildTakeMsg(betId, null, { refereeAck: REFEREE }) }, gas: 80_000_000_000_000n }); rec("take_human_bet", t.transaction.hash, { amount: dep });
await sleep(3000);
let b = await view("get_bet", { bet_id: betId }); console.log("status after take", b.status); res.status_after_take = b.status; save();
if (b.status !== "Taken") throw new Error("not taken: " + b.status);
const fd = BigInt(b.envelope.funding_deadline);
while (BigInt(Date.now()) * 1_000_000n < fd + 15_000_000_000n) await sleep(5000);
t = await referee.functionCall({ contractId: ESCROW, methodName: "referee_rule", args: { bet_id: betId, outcome: "YES" }, gas: 100_000_000_000_000n }); rec("referee_rule_yes", t.transaction.hash);
for (let i = 0; i < 24; i++) { await sleep(5000); const p = await view("pending_payouts", { from: 0, limit: 50 }).catch(() => null); if (p && p.length === 0) break; }
b = await view("get_bet", { bet_id: betId });
res.final_status = b.status; res.final_outcome = b.outcome;
res.balances = { before: Object.fromEntries(Object.entries(b0).map(([k, v]) => [k, v.toString()])), after: { maker: (await bal(MAKER)).toString(), taker: (await bal(TAKER)).toString(), fee: (await bal("fee.praetorial-dev-1101.testnet")).toString(), escrow: (await bal(ESCROW)).toString() } };
save(); console.log(JSON.stringify({ status: b.status, outcome: b.outcome, balances: res.balances }));
