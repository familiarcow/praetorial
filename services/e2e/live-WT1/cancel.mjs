// WT1c: maker cancels the still-Open bet to reclaim the mock-USDC deposit (cheap: gas only).
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../package.json", import.meta.url));
const { connect, keyStores, KeyPair } = require("near-api-js");
const F = new URL("results.json", import.meta.url).pathname; const res = JSON.parse(fs.readFileSync(F, "utf8"));
const id = "maker1.praetorial-dev-1101.testnet";
const ks = new keyStores.InMemoryKeyStore();
await ks.setKey("testnet", id, KeyPair.fromString(JSON.parse(fs.readFileSync(`${process.env.HOME}/.near-credentials/testnet/${id}.json`, "utf8")).private_key));
const a = await (await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC_URL, keyStore: ks })).account(id);
const bal = async () => a.viewFunction({ contractId: "intents-mock.praetorial-dev-1101.testnet", methodName: "mt_balance_of", args: { account_id: id, token_id: "nep141:usdc.testnet" } });
res.usdc_before_cancel = await bal();
const r = await a.functionCall({ contractId: res.escrow, methodName: "cancel", args: { bet_id: res.bet_id }, gas: 100_000_000_000_000n });
await new Promise((x) => setTimeout(x, 4000));
res.txs.push({ step: "cancel", hash: r.transaction.hash, url: `https://testnet.nearblocks.io/txns/${r.transaction.hash}` });
res.usdc_after_cancel = await bal();
res.bet_status_after_cancel = (await a.viewFunction({ contractId: res.escrow, methodName: "get_bet", args: { bet_id: res.bet_id } })).status;
fs.writeFileSync(F, JSON.stringify(res, null, 2));
console.log(r.transaction.hash, res.usdc_before_cancel, res.usdc_after_cancel, res.bet_status_after_cancel);
