import { balance } from "./lib.mjs";
for (const a of process.argv.slice(2)) console.log(a, (Number(BigInt(await balance(a)) / 10n**20n) / 10000).toFixed(4));
