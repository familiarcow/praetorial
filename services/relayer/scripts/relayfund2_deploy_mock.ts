// RELAYFUND2: redeploy contracts/mock-intents wasm (adds ft_on_transfer; state layout unchanged) to the testnet mock.
// Records mt_balance_of views before/after to show existing state is still readable. Testnet only; never prints keys.
// usage (from services/): NEAR_RPC_URL=<testnet rpc> tsx relayer/scripts/relayfund2_deploy_mock.ts
import fs from "node:fs";
import { KeyPair, connect, keyStores } from "near-api-js";
const CRED = `${process.env.HOME}/.near-credentials/testnet`;
const INTENTS = "intents-mock.praetorial-dev-1101.testnet";
const WASM = new URL("../../../contracts/target/wasm32-unknown-unknown/release/mock_intents.wasm", import.meta.url).pathname;
const OUT = new URL("../../e2e/live-RELAYFUND2/mock_deploy.json", import.meta.url).pathname;
const ks = new keyStores.InMemoryKeyStore();
await ks.setKey("testnet", INTENTS, KeyPair.fromString(JSON.parse(fs.readFileSync(`${CRED}/${INTENTS}.json`, "utf8")).private_key));
const acct: any = await (await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC_URL!, keyStore: ks })).account(INTENTS);
const probes = [["praetorial-frz1b-2611081810.praetorial-dev-1101.testnet", "nep141:wrap.testnet"], ["escrow3.praetorial-dev-1101.testnet", "nep141:wrap.testnet"], ["praetorial-frz1b-2611081810.praetorial-dev-1101.testnet", "nep141:usdc.fakes.testnet"], ["escrow3.praetorial-dev-1101.testnet", "nep141:usdc.fakes.testnet"]];
const read = async () => Object.fromEntries(await Promise.all(probes.map(async ([a, t]) => [`${a}|${t}`, await acct.viewFunction({ contractId: INTENTS, methodName: "mt_balance_of", args: { account_id: a, token_id: t } })])));
const before = await read();
const wasm = fs.readFileSync(WASM);
const r: any = await acct.deployContract(wasm);
const after = await read();
const out = { account: INTENTS, wasmBytes: wasm.length, deployTx: r.transaction.hash, before, after, stateUnchanged: JSON.stringify(before) === JSON.stringify(after), fail_mt_transfer_enabled: await acct.viewFunction({ contractId: INTENTS, methodName: "fail_mt_transfer_enabled", args: {} }) };
fs.mkdirSync(new URL("../../e2e/live-RELAYFUND2/", import.meta.url).pathname, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
