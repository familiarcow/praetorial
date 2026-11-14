import { account } from "./lib.mjs"; import * as C from "./config.mjs";
const k = await account(C.KEEPER);
const b = await k.viewFunction({ contractId: C.ESCROW, methodName: "get_bet", args: { bet_id: +process.argv[2] } });
b.envelope.terms = undefined; console.log(JSON.stringify(b).slice(0, 3000));
