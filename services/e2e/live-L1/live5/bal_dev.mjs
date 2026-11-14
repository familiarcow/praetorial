import { balance } from "./lib.mjs";
for (const a of ["praetorial-dev-1101.testnet","keeper.praetorial-dev-1101.testnet","maker1.praetorial-dev-1101.testnet","taker1.praetorial-dev-1101.testnet","attest1.praetorial-dev-1101.testnet"]) console.log(a.split(".")[0], (Number(BigInt(await balance(a))/10n**20n)/1e4).toFixed(4));
