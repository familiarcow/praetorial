// List the escrow txs since the run started with their method names (who/what per step for the README tx table): npx tsx txs.ts
import fs from "node:fs";
import { escrowMethods } from "./chain.js";
const st = JSON.parse(fs.readFileSync(new URL("./run/state.json", import.meta.url), "utf8"));
console.log(JSON.stringify(await escrowMethods(BigInt(st.sinceNs) - 600_000_000_000n), null, 1));
