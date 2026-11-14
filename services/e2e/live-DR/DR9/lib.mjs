// DR9 live helpers (testnet only). Keys are read in-process from ~/.near-credentials/testnet, never printed. Run from apps/web:
//   NEAR_RPC_URL=<testnet rpc> node --import tsx ../../services/e2e/live-DR/DR9/<script>.mjs
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blankCustomForm, sheetFromCustomForm } from "../../../../apps/web/lib/customBuilder";
import { customOpenProblems } from "../../../../apps/web/lib/customLint";
import { buildOpenEnvelope, makerDeposit } from "../../../../apps/web/lib/openEnvelope";
import { buildOpenMsg, buildTakeMsg } from "../../../../apps/web/lib/escrowAdapter";
// PUB1/MISS1: near-api-js from THIS checkout's services/ (repo-relative), never one machine's path.
const require = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../package.json"));
export const { connect, keyStores, KeyPair, utils } = require("near-api-js");
export const NODE = process.env.NEAR_RPC_URL; if (!NODE) throw new Error("set NEAR_RPC_URL (testnet RPC)");
export const CRED = `${process.env.HOME}/.near-credentials/testnet`;
export const DIR = new URL(".", import.meta.url).pathname;
export const DEV = "praetorial-dev-1101.testnet", USDC = "nep141:usdc.testnet", KEEPER = "keeper.praetorial-dev-1101.testnet", FEE = "fee.praetorial-dev-1101.testnet";
const CACHE = process.env.PRAETORIAL_CACHE_DIR; if (!CACHE) throw new Error("set PRAETORIAL_CACHE_DIR (operator cache dir; scratch keys live in its scratch/)");
export const S = `${CACHE}/scratch`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function store(file) {
  const p = DIR + file;
  const load = () => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : { txs: [] });
  // merge txs already on disk (rec() writes them) so a caller holding a stale copy of the results object cannot clobber the tx log
  const save = (r) => { const disk = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).txs ?? [] : []; const seen = new Set((r.txs ?? []).map((t) => t.hash)); r.txs = [...(r.txs ?? []), ...disk.filter((t) => !seen.has(t.hash))]; fs.writeFileSync(p, JSON.stringify(r, null, 2)); };
  const rec = (step, hash, extra = {}) => { const r = load(); r.txs.push({ step, hash, url: `https://testnet.nearblocks.io/txns/${hash}`, ...extra }); save(r); console.log("tx", step, hash); };
  return { load, save, rec };
}
const near = await connect({ networkId: "testnet", nodeUrl: NODE, keyStore: new keyStores.InMemoryKeyStore() });
export const viewer = await near.account(DEV);
export async function account(id) {
  const ks = new keyStores.InMemoryKeyStore();
  const k = JSON.parse(fs.readFileSync(`${CRED}/${id}.json`, "utf8"));
  await ks.setKey("testnet", id, KeyPair.fromString(k.private_key));
  return (await connect({ networkId: "testnet", nodeUrl: NODE, keyStore: ks })).account(id);
}
export async function createKeyed(parent, id, nearAmt) {
  const kp = KeyPair.fromRandom("ed25519");
  const r = await parent.createAccount(id, kp.getPublicKey(), utils.format.parseNearAmount(nearAmt));
  fs.writeFileSync(`${CRED}/${id}.json`, JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  return r.transaction.hash;
}
export const view = (contractId, methodName, args = {}) => viewer.viewFunction({ contractId, methodName, args });
export const bal = (intents, who) => view(intents, "mt_balance_of", { account_id: who, token_id: USDC }).then(BigInt);
export async function tryCall(acc, contractId, methodName, args = {}, { deposit = 0n, gas = 100_000_000_000_000n } = {}) {
  try {
    const r = await acc.functionCall({ contractId, methodName, args, gas, attachedDeposit: deposit });
    const rf = (r.receipts_outcome ?? []).map((o) => o.outcome?.status?.Failure).filter(Boolean).map((f) => JSON.stringify(f)).join(" | ");
    const fail = r.status?.Failure ? JSON.stringify(r.status.Failure) : null;
    return { ok: !fail && !rf, hash: r.transaction.hash, failure: fail || rf || null };
  } catch (e) { return { ok: false, hash: e?.context?.transactionHash ?? null, failure: String(e?.message ?? e) }; }
}
/** Build+attest an open for `maker` on `escrow` (sourcecheck runs as attest1 via the OutLayer CLI, no NEAR AI). Returns { built, msg, dep }. */
export function prepareOpen({ escrow, keys, wasmBase, maker, tag, stake = "10000000", storagePerKib = "37684" }) {
  const nowMs = Date.now();
  const dl = (m) => new Date(nowMs + m * 60_000).toISOString().slice(0, 16);
  const form = { ...blankCustomForm(), claim: `DR9 drill ${tag}: the iana.org home page mentions the Internet Assigned Numbers Authority (${nowMs}).`,
    elements: ["Does the iana.org home page mention the Internet Assigned Numbers Authority?"],
    sources: [{ publisher: "IANA", url: "https://www.iana.org/", partyControlled: false }, { publisher: "ICANN", url: "https://www.icann.org/", partyControlled: false }],
    windowStart: dl(-30), windowEnd: dl(-20), evidenceCutoff: dl(-10), fallbackRule: "Fallback: if a named source is unavailable the answer is could-not-check.", earlyRule: "No early resolution." };
  const sheet = sheetFromCustomForm(form);
  const problems = customOpenProblems(sheet, { humanReferee: false }); if (problems.length) throw new Error("lint: " + problems.join("; "));
  const built = buildOpenEnvelope({ maker, sheet, customDeadlineSecs: Math.floor(nowMs / 1000) + 3600, makerAsset: USDC, takerAsset: USDC, stakeMaker: stake, stakeTaker: stake, takerAccount: null, referee: null, nowMs });
  const HASH = keys[2], f = `${DIR}run/sc_${tag}.json`;
  fs.mkdirSync(DIR + "run", { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ mode: "sourcecheck", terms: built.terms }));
  const out = execFileSync(`${process.env.HOME}/.local/bin/outlayer`, ["run", "--wasm", `${wasmBase}/${HASH}.wasm`, "--hash", HASH, "--input", f], { env: { ...process.env, OUTLAYER_HOME: `${S}/olhome-frz2-attest` }, encoding: "utf8", timeout: 240000 });
  const sc = JSON.parse(out.slice(out.indexOf("{")).replace(/"checked_at":\s*(\d{16,})/, '"checked_at":"$1"'));
  if (!sc.ok || sc.spec_hash !== built.terms_hash) throw new Error("sourcecheck refused");
  if (sc.signing?.pubkey_hex !== keys[1]) throw new Error("attest pubkey != pinned");
  fs.writeFileSync(`${DIR}run/sc_${tag}.out.json`, JSON.stringify({ spec_hash: sc.spec_hash, checked_at: sc.checked_at, ok: sc.ok }));
  return { built, msg: buildOpenMsg(built, { checked_at: sc.checked_at, signature_hex: sc.signing.signature_hex }, null), dep: makerDeposit(built, storagePerKib) };
}
export { buildTakeMsg };
