import { account, mk, utils, balance } from "./lib.mjs"; import * as C from "./config.mjs";
const { recordTx } = mk("./results.json");
const dev = await account(C.OPERATOR); const r = await dev.sendMoney(C.ESCROW, utils.format.parseNearAmount(process.argv[2]));
recordTx("fund_escrow_" + process.argv[2] + "_near", r.transaction.hash, { status: "Success" }); console.log(await balance(C.ESCROW));
