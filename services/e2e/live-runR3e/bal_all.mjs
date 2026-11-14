import { balance } from "./lib.mjs";
for (const a of ["praetorial-dev-1101.testnet","praetorial-r3e-11062012.praetorial-dev-1101.testnet","praetorial-r3c-11061912.praetorial-dev-1101.testnet"]) console.log(a, (Number(BigInt(await balance(a))/10n**20n)/1e4).toFixed(3));
