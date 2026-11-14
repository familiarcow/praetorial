import { balance } from "./lib.mjs";
console.log("dev", Number(BigInt(await balance("praetorial-dev-1101.testnet"))/10n**20n)/1e4);
