// CF1e: open ONE testnet bet whose envelope + Open msg come from the WEB build's own modules (no hand-written envelope):
//   guidedFields.fieldsFromForm -> openEnvelope.buildOpenEnvelope (+ templates lint, releaseConfig pins) ->
//   openPins.checkOpenPins (real resolver_keys() of the target escrow, never bypassed) -> escrowAdapter.buildOpenMsg.
// Funding mechanics (mock-intents mint + transfer_with_msg, outlayer sourcecheck attested by attest1) mirror live-L1/live5/open_take.mjs.
// usage: NEAR_RPC_URL=<testnet rpc> tsx open_from_web.mjs   (run from apps/web so tsx resolves its deps)
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fieldsFromForm } from "../../../apps/web/lib/guidedFields";
import { buildOpenEnvelope, makerDeposit } from "../../../apps/web/lib/openEnvelope";
import { checkOpenPins } from "../../../apps/web/lib/openPins";
import { buildOpenMsg } from "../../../apps/web/lib/escrowAdapter";
import { lintAnySheet } from "../../../apps/web/lib/templates";
import { loadReleaseConfig } from "../../../apps/web/lib/releaseConfig";

const require = createRequire(new URL("../../package.json", import.meta.url));
const { connect, keyStores, KeyPair } = require("near-api-js");
const DIR = new URL(".", import.meta.url).pathname; const COUNT = Number(process.env.COUNT ?? 20);
const RPC = process.env.NEAR_RPC_URL; if (!RPC) throw new Error("set NEAR_RPC_URL (testnet)");
const ESCROW = "praetorial-frz1b-2611081810.praetorial-dev-1101.testnet";
const INTENTS = "intents-mock.praetorial-dev-1101.testnet";
const MAKER = "maker1.praetorial-dev-1101.testnet", KEEPER = "keeper.praetorial-dev-1101.testnet";
const USDC = "nep141:usdc.testnet";
const ATTEST1 = "b0bd538e5a1cc4a31216a8020f992b3f9dcde612bc9889c7a828dc697abf8e9f";
const resFile = DIR + "results.json";
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

const maker = await acct(MAKER), keeper = await acct(KEEPER);
const view = (m, a = {}) => keeper.viewFunction({ contractId: ESCROW, methodName: m, args: a });

// 1. guided-fields path: a person's form values -> exact typed fields (btc_close_at_t, the close of the 1-min candle at T).
const nowMs = Date.now();
const tMs = Math.ceil((nowMs + 150 * 60_000) / 60_000) * 60_000; // T = ~65 min from now (resolver OPEN_T_TOO_SOON needs >= 1h), UTC minute
const tForm = new Date(tMs).toISOString().slice(0, 16); // what a datetime-local input yields
const form = { t_utc: tForm, op: ">=", x_usd: "75900" };
const sheet = { template: { id: "btc_close_at_t", version: 1 }, fields: fieldsFromForm("btc_close_at_t", form, nowMs) };
const lint = lintAnySheet(sheet);
if (lint.length) throw new Error("web lint refused the sheet: " + lint.join("; "));
res.form = form; res.sheet = sheet; res.release = loadReleaseConfig();

// 2. pins: the real escrow resolver_keys() must equal the web release pin. Never bypassed.
const keys = await view("resolver_keys");
const pinErr = await checkOpenPins(async () => keys);
res.resolver_keys = keys; res.checkOpenPins = pinErr;
save();
if (pinErr) throw new Error("checkOpenPins refused: " + pinErr);
console.log("checkOpenPins: null (pass); resolver_keys[2] =", keys[2]);

// 3. envelope from the web builder (USDC mock both sides, 1 USDC each: no real value; only gas costs tNEAR).
const built = buildOpenEnvelope({
  maker: MAKER, sheet, makerAsset: USDC, takerAsset: USDC, stakeMaker: "10000000", stakeTaker: "10000000",
  takerAccount: null, referee: null, nowMs,
});
fs.writeFileSync(DIR + "envelope_built.json", JSON.stringify(built, null, 2));

// 4. sourcecheck attestation (one outlayer call; HTTP sources only, no NEAR AI) over the envelope's exact terms.
const terms = built.terms;
fs.writeFileSync(DIR + "job_sourcecheck.json", JSON.stringify({ mode: "sourcecheck", terms }));
const U = `https://test.fastfs.io/praetorial-dev-1101.testnet/outlayer.testnet/${keys[2]}.wasm`;
const OL = `${process.env.HOME}/.local/bin/outlayer`;
let out = "";
for (let a = 0; a < 3 && !out; a++) {
  try { out = execFileSync("/bin/sh", ["-c", `${OL} run --wasm ${U} --input ${DIR}job_sourcecheck.json 2>&1`], { env: { ...process.env, OUTLAYER_HOME: ((process.env.PRAETORIAL_CACHE_DIR ?? (() => { throw new Error("set PRAETORIAL_CACHE_DIR (operator cache dir)"); })()) + "/scratch/olhome-frz1b-attest") }, encoding: "utf8", timeout: 280000 }); }
  catch (e) { console.log("outlayer attempt failed:", String(e.stderr || e.message).slice(0, 300)); }
}
fs.writeFileSync(DIR + "sourcecheck.log", out);
const scTx = out.match(/Tx: (\S+)/)[1];
const sc = JSON.parse(out.slice(out.indexOf("{", out.indexOf("Tx:"))));
if (!sc.ok || sc.signing?.pubkey_hex !== ATTEST1) throw new Error("sourcecheck not ok / pubkey mismatch: " + JSON.stringify(sc).slice(0, 300));
if (sc.spec_hash !== built.terms_hash) throw new Error(`spec_hash ${sc.spec_hash} != web terms_hash ${built.terms_hash}`);
const checkedAt = out.match(/"checked_at":\s*(\d+)/)[1];
rec("sourcecheck_attest1", scTx, { spec_hash: sc.spec_hash, checked_at: checkedAt, status: "Success" });
const attestation = { checked_at: checkedAt, signature_hex: sc.signing.signature_hex };

// 5. Open msg from the web's own buildOpenMsg; deposit = stake + storage (web makerDeposit).
const msg = buildOpenMsg(built, attestation, null);
fs.writeFileSync(DIR + "open_msg.json", msg);
const dep = makerDeposit(built, "37684");
const total = (BigInt(dep) * BigInt(COUNT)).toString();
const mint = await keeper.functionCall({ contractId: INTENTS, methodName: "mint", args: { account_id: MAKER, token_id: USDC, amount: total }, gas: 30_000_000_000_000n });
rec("mint_usdc_maker_x" + COUNT, mint.transaction.hash, { amount: total, status: "Success" });
for (let n = 0; n < COUNT; n++) {
  try {
    const open = await maker.functionCall({ contractId: INTENTS, methodName: "transfer_with_msg", args: { receiver_id: ESCROW, token_id: USDC, amount: dep, msg }, gas: 80_000_000_000_000n });
    rec("open_usdc_" + n, open.transaction.hash, { amount: dep });
  } catch (e) { console.log("open", n, "failed:", String(e.message).slice(0, 200)); }
}
const offers = await view("open_offers", { from: 0, limit: 200 });
res.open_offers_now = offers.length; res.escrow = ESCROW; save();
console.log("open offers on escrow:", offers.length);
