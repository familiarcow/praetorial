// Escrow pin check: the escrow's resolver_keys() (hash entry) must equal apps/web/lib/release.json resolver_wasm_hash, all 64 hex chars.
import fs from "node:fs";
import { view, ESCROW } from "./chain.js";
const rel = JSON.parse(fs.readFileSync(new URL("../../../../apps/web/lib/release.json", import.meta.url), "utf8"));
const keys = await view("resolver_keys");
console.log(JSON.stringify({ escrow: ESCROW, release_hash: rel.resolver_wasm_hash, resolver_keys: keys, full_match: JSON.stringify(keys).includes(rel.resolver_wasm_hash) }));
