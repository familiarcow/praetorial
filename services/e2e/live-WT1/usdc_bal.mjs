// WT1c: read-only mock-USDC balances on intents-mock (maker, taker, escrow).
import { createRequire } from "node:module";
const require = createRequire(new URL("../../package.json", import.meta.url));
const { connect, keyStores } = require("near-api-js");
const a = await (await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC_URL, keyStore: new keyStores.InMemoryKeyStore() })).account("x");
const bal = (id) => a.viewFunction({ contractId: "intents-mock.praetorial-dev-1101.testnet", methodName: "mt_balance_of", args: { account_id: id, token_id: "nep141:usdc.testnet" } });
for (const w of ["maker1", "taker1"]) console.log(w, await bal(`${w}.praetorial-dev-1101.testnet`));
console.log("escrow", await bal("praetorial-l1b20-11080132.praetorial-dev-1101.testnet"));
