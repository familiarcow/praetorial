import { account, mk, utils, balance } from "./lib.mjs"; import * as C from "./config.mjs";
const { recordTx } = mk("./results.json");
const dev = await account(C.OPERATOR); const r = await dev.sendMoney(C.KEEPER, utils.format.parseNearAmount(process.argv[2] ?? "1"));
recordTx("fund_keeper_" + (process.argv[2] ?? "1") + "_near", r.transaction.hash, { status: "Success" }); console.log(await balance(C.KEEPER));
