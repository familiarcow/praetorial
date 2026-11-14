import { balance } from "./lib.mjs"; import * as C from "./config.mjs";
console.log(C.ESCROW, await balance(C.ESCROW));
