import { balance } from "./lib.mjs";
for (const k of ["praetorial-dev-1101","keeper","maker1","taker1","fee"]) console.log(k, (BigInt(await balance(`${k}${k.includes("-")?"":".praetorial-dev-1101"}.testnet`.replace("praetorial-dev-1101.praetorial-dev-1101","praetorial-dev-1101")))/10n**21n).toString(), "mNEAR");
