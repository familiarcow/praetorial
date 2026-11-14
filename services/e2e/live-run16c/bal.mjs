import { balance } from "../live-run16a/lib.mjs";
for (const k of ["keeper","attest1"]) console.log(k, await balance(`${k}.praetorial-dev-1101.testnet`));
