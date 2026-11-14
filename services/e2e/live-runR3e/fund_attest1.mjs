import { account, mk, utils, balance } from "./lib.mjs";
const { recordTx } = mk("./results.json");
const dev = await account("praetorial-dev-1101.testnet");
const r = await dev.sendMoney("attest1.praetorial-dev-1101.testnet", utils.format.parseNearAmount("0.6"));
recordTx("fund_keeper_0.6_near", r.transaction.hash, { status: "Success" });
console.log(await balance("praetorial-dev-1101.testnet"), await balance("attest1.praetorial-dev-1101.testnet"));
