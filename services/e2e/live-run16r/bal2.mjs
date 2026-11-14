import { balance } from "./lib.mjs";
for (const k of ["praetorial-dev-1101","keeper.praetorial-dev-1101","attest1.praetorial-dev-1101","praetorial-e2e-2611052236.praetorial-dev-1101"]) console.log(k, Number(BigInt(await balance(`${k}.testnet`))/10n**20n)/1e4);
