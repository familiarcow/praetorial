// LIVE2 / WITHDRAW1: redeploy contracts/mock-intents wasm IN PLACE (adds ft_withdraw/ft_resolve_withdraw; method-only, state layout
// unchanged) to intents-mock.praetorial-dev-1101.testnet. Reads mt_balance_of for known holders before/after and refuses to call it
// done unless state reads back identically. Testnet only; never prints keys.
// usage (from services/): tsx relayer/scripts/live2_deploy_mock.ts <probe-account>...
import fs from "node:fs";
import { createHash } from "node:crypto";
import { KeyPair, connect, keyStores } from "near-api-js";
import { DEFAULT_TESTNET_RPC_URL } from "../../common/src/rpc.js";
const INTENTS = "intents-mock.praetorial-dev-1101.testnet";
const WASM = new URL("../../../contracts/target/wasm32-unknown-unknown/release/mock_intents.wasm", import.meta.url).pathname;
const ks = new keyStores.InMemoryKeyStore();
await ks.setKey("testnet", INTENTS, KeyPair.fromString(JSON.parse(fs.readFileSync(`${process.env.HOME}/.near-credentials/testnet/${INTENTS}.json`, "utf8")).private_key));
const acct: any = await (await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC_URL ?? DEFAULT_TESTNET_RPC_URL, keyStore: ks })).account(INTENTS);
const holders = process.argv.slice(2);
const tokens = ["nep141:wrap.testnet", "nep141:usdc.testnet"];
const read = async () => { const o: Record<string, string> = {}; for (const a of holders) for (const t of tokens) o[`${a}|${t}`] = await acct.viewFunction({ contractId: INTENTS, methodName: "mt_balance_of", args: { account_id: a, token_id: t } }); return o; };
const before = await read();
const wasm = fs.readFileSync(WASM);
const r: any = await acct.deployContract(wasm);
const after = await read();
const out = { account: INTENTS, wasmSha256: createHash("sha256").update(wasm).digest("hex"), wasmBytes: wasm.length, deployTx: r.transaction.hash, stateUnchanged: JSON.stringify(before) === JSON.stringify(after), before, after };
console.log(JSON.stringify(out, null, 2));
if (!out.stateUnchanged) process.exit(3);
