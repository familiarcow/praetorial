// WT1c: read-only probe: which deployed testnet escrow pins the resolver this web build expects?
import { viewFunction } from "../../../apps/web/lib/rpc";
import { loadReleaseConfig } from "../../../apps/web/lib/releaseConfig";
import { checkOpenPins } from "../../../apps/web/lib/openPins";
const rel = loadReleaseConfig();
console.log("web expects", rel.resolver_wasm_hash);
for (const e of process.argv.slice(2)) {
  try {
    const keys = await viewFunction(e, "resolver_keys", {});
    console.log(e, JSON.stringify(keys), "checkOpenPins:", await checkOpenPins(async () => keys, rel));
  } catch (err) { console.log(e, "ERR", String(err.message).slice(0, 150)); }
}
