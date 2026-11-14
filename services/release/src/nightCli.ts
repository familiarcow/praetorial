// MAINPREP1 deploy-night CLI (read-only + local files; never signs, never sends a transaction).
//   fill  --input draft.json --outcome-log F --attest-log F --upload-log F --escrow ACC --attest-account ACC --out input.json
//   views --network mainnet|testnet --escrow ACC --args args.json [--rpc URL]
import { readFileSync, writeFileSync } from "node:fs";
import { compareViews, fillOutlayerFields, type EscrowViews } from "./night.js";
import { DEFAULT_MAINNET_RPC_URL, DEFAULT_TESTNET_RPC_URL } from "../../common/src/rpc.js";

// RPC URLs come from the shared config (services/common/src/rpc.ts; guarded by common/test/rpcStatic.test.ts).
const RPC: Record<string, string> = { mainnet: DEFAULT_MAINNET_RPC_URL, testnet: DEFAULT_TESTNET_RPC_URL };

function flags(argv: string[]): Record<string, string> {
  const f: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
    f[argv[i]!.slice(2)] = argv[i + 1]!;
  }
  return f;
}

async function view(rpc: string, account: string, method: string, args: unknown): Promise<unknown> {
  const body = { jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } };
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json()) as { result?: { result?: number[]; error?: string }; error?: unknown };
  if (!j.result?.result) throw new Error(`${method}: ${JSON.stringify(j.error ?? j.result?.error ?? j).slice(0, 300)}`);
  return JSON.parse(Buffer.from(j.result.result).toString("utf8"));
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  if (cmd === "fill") {
    for (const k of ["input", "outcome-log", "attest-log", "upload-log", "escrow", "attest-account", "out"]) if (!f[k]) throw new Error(`fill: --${k} is required`);
    const input = JSON.parse(readFileSync(f.input!, "utf8"));
    const out = fillOutlayerFields(input, {
      outcomeLog: readFileSync(f["outcome-log"]!, "utf8"), attestLog: readFileSync(f["attest-log"]!, "utf8"), uploadLog: readFileSync(f["upload-log"]!, "utf8"),
      escrow: f.escrow!, attestAccount: f["attest-account"]!, resolverHash: input.resolver_wasm_hash,
    });
    writeFileSync(f.out!, JSON.stringify(out, null, 2) + "\n");
    console.log(`outcome_pubkey ${out.outcome_pubkey}\nattest_pubkey  ${out.attest_pubkey}\nwasm_base_url  ${out.outlayer_config.wasm_base_url}\nok: wrote ${f.out}`);
    return 0;
  }
  if (cmd === "views") {
    for (const k of ["network", "escrow", "args"]) if (!f[k]) throw new Error(`views: --${k} is required`);
    const rpc = f.rpc ?? RPC[f.network!] ?? (() => { throw new Error("--network mainnet|testnet"); })();
    const args = JSON.parse(readFileSync(f.args!, "utf8"));
    const E = f.escrow!;
    const asset_limit: Record<string, unknown> = {};
    for (const [id] of args.asset_limits as [string][]) asset_limit[id] = await view(rpc, E, "asset_limit", { asset_id: id });
    const v: EscrowViews = {
      resolver_keys: (await view(rpc, E, "resolver_keys", {})) as string[], outlayer_config: await view(rpc, E, "outlayer_config", {}),
      judge_chain: await view(rpc, E, "judge_chain", {}), asset_limit,
      protocol_fee_bps: (await view(rpc, E, "protocol_fee_bps", {})) as number, is_paused: (await view(rpc, E, "is_paused", {})) as boolean,
      is_shutdown: (await view(rpc, E, "is_shutdown", {})) as boolean, contract_version: (await view(rpc, E, "contract_version", {})) as string,
    };
    const lines = compareViews(args, v);
    console.log(`# views-vs-args: ${f.network} escrow ${E} args ${f.args} rpc ${rpc}`);
    for (const l of lines) console.log(`${l.ok ? "PASS" : "FAIL"} ${l.check} ${l.detail}`);
    const bad = lines.filter((l) => !l.ok).length;
    console.log(`# ${lines.length - bad} PASS, ${bad} FAIL`);
    return bad ? 1 : 0;
  }
  throw new Error("usage: fill ... | views ...");
}
main().then((c) => process.exit(c), (e) => { console.error(`REFUSED: ${e instanceof Error ? e.message : e}`); process.exit(1); });
