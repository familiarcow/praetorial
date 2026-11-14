import { account } from "./lib.mjs"; import * as C from "./config.mjs";
const a = await account(C.OPERATOR); const b = await a.viewFunction({ contractId: C.ESCROW, methodName: "get_bet", args: { bet_id: Number(process.argv[2]) } });
console.log(JSON.stringify({ ...b, envelope: { ...b.envelope, terms: undefined } }, null, 1));
