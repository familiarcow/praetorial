// usage: node run_probe.mjs <group> <out.json>   (group: all|price|sports|weather). Testnet only. Never prints keys.
import fs from "node:fs";
import { account } from "./lib.mjs";
const [group, out] = process.argv.slice(2);
const H = "f9adbe6f631ea7e13cf77f651c8a8fff0c0a8876c5f3f9a0f44e72f7e383e5a2";
const dev = await account("praetorial-dev-1101.testnet");
const args = {
  source: { WasmUrl: { url: `https://test.fastfs.io/praetorial-dev-1101.testnet/outlayer.testnet/${H}.wasm`, hash: H, build_target: "wasm32-wasip2" } },
  input_data: JSON.stringify({ mode: "probe-sources", group }),
  resource_limits: { max_instructions: 5_000_000_000, max_memory_mb: 128, max_execution_seconds: 90 },
  response_format: "Json",
};
const res = await dev.functionCall({ contractId: "outlayer.testnet", methodName: "request_execution", args, gas: 100_000_000_000_000n, attachedDeposit: 30n * 10n ** 21n });
const hash = res.transaction.hash;
console.log("tx", hash);
fs.writeFileSync(out, JSON.stringify(res));
