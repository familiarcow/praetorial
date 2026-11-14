// NOKEY1b: move testnet NEAR from a spare plain testnet account to the dev account (no faucet reachable).
import { account, utils, balance } from "./lib.mjs";
const [, , FROM, TO, NEAR] = process.argv;
const r = await (await account(FROM)).sendMoney(TO, utils.format.parseNearAmount(NEAR));
console.log("tx topup", r.transaction.hash, "to bal", await balance(TO));
