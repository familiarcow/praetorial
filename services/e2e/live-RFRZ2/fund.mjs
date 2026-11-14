// RFRZ2: top up the fresh escrow account so the 472 KB wasm storage lock + new() gas fit.
import { account, utils, balance } from "./lib.mjs";
const [, , TO, NEAR] = process.argv;
const r = await (await account("praetorial-dev-1101.testnet")).sendMoney(TO, utils.format.parseNearAmount(NEAR));
console.log("tx fund", r.transaction.hash, "bal", await balance(TO));
