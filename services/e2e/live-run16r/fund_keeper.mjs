import { account, mk, utils, balance } from "./lib.mjs";
const { recordTx } = mk("./results.json");
const dev = await account("praetorial-dev-1101.testnet");
const r = await dev.sendMoney("keeper.praetorial-dev-1101.testnet", utils.format.parseNearAmount("0.3"));
recordTx("fund_keeper_0.3_near", r.transaction.hash, { status: "Success" });
console.log(await balance("praetorial-dev-1101.testnet"), await balance("keeper.praetorial-dev-1101.testnet"));
