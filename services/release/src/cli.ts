// RC1: `gen-new-args --input in.json --network mainnet|testnet --out args.json [--table table.md] [--now-ms N]`
import { readFileSync, writeFileSync } from "node:fs";
import { publishSnapshot } from "./publishSnapshot.js";
import { writeFreezeRecord } from "./freezeRecord.js";
import { ADAPTERS, fetchPrices, mergePrices, realHttp, renderPriceTable } from "./prices.js";
import { generate, ReleaseError, type Network, type ReleaseInput } from "./gen.js";

function parse(argv: string[]): { cmd: string; flags: Record<string, string> } {
  const [cmd, ...all] = argv;
  const rest = all.filter((x) => x !== "--final" && x !== "--preflight"); // RCFG1 / MAINPREP1: boolean flags
  const isFinal = all.includes("--final");
  const isPreflight = all.includes("--preflight");
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    if (!k?.startsWith("--") || rest[i + 1] === undefined) throw new ReleaseError(`bad argument ${k}`);
    flags[k.slice(2)] = rest[i + 1];
  }
  if (isFinal) flags.final = "yes";
  if (isPreflight) flags.preflight = "yes";
  return { cmd, flags };
}

async function main(): Promise<number> {
  try {
    const argv = process.argv.slice(2);
    const secretsEnv: string[] = []; // PUB1: repeated flag
    const argvRest: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--secrets-env") { if (argv[i + 1] === undefined) throw new ReleaseError("--secrets-env needs a path"); secretsEnv.push(argv[++i]); } else argvRest.push(argv[i]);
    }
    const { cmd, flags } = parse(argvRest);
    if (cmd === "publish-snapshot") {
      const m = publishSnapshot({ ref: flags.ref, out: flags.out, license: flags.license, secretsEnv, allowlist: flags.allowlist, repo: flags.repo });
      console.log(`snapshot ${m.commit} files=${m.file_count} excluded=${m.excluded_count} scan=${m.scan.status} allowlisted=${m.scan.allowlisted.length}`);
      for (const h of m.scan.hits) console.error(`HIT ${h.path}:${h.line} rule=${h.rule}${h.key ? ` key=${h.key}` : ""}`);
      if (m.scan.status !== "clean") { console.error(`REFUSED: ${m.scan.hits.length} secret-scan hit(s); manifest marked dirty`); return 1; }
      return 0;
    }
    if (cmd === "freeze-record") {
      const need = ["commit", "escrow-record", "resolver-record", "fresh-escrow-hash-file", "testnet-args", "mainnet-args", "test-summary-file", "out"];
      for (const k of need) if (!flags[k]) throw new ReleaseError(`freeze-record: --${k} is required`);
      writeFreezeRecord({
        commit: flags.commit, escrowRecord: flags["escrow-record"], resolverRecord: flags["resolver-record"],
        freshEscrowHashFile: flags["fresh-escrow-hash-file"], testnetArgs: flags["testnet-args"], mainnetArgs: flags["mainnet-args"],
        testSummaryFile: flags["test-summary-file"], testnetEscrow: flags["testnet-escrow"], deployTx: flags["deploy-tx"], verifyOutput: flags["verify-output"],
        expectResolverHash: flags["expect-resolver-hash"],
        pendingFrz1b: flags["pending-frz1b"] === "yes",
      }, flags.out);
      console.log(`ok: wrote ${flags.out}`);
      return 0;
    }
    if (cmd === "prices") { // PXF1: `prices --input in.json --out merged.json [--providers coinbase,kraken]`
      if (!flags.input || !flags.out) throw new ReleaseError("prices: --input and --out are required");
      const names = (flags.providers ?? "coinbase,kraken").split(",");
      const providers = names.map((n) => ADAPTERS[n] ?? (() => { throw new ReleaseError(`prices: unknown provider ${n} (coinbase, kraken, coingecko)`); })());
      const fetched_ms = Date.now();
      const rows = await fetchPrices({ http: realHttp, providers, now_ms: fetched_ms });
      const merged = mergePrices(JSON.parse(readFileSync(flags.input, "utf8")) as ReleaseInput, rows);
      writeFileSync(flags.out, JSON.stringify(merged, null, 2) + "\n");
      console.log(renderPriceTable(rows));
      console.log(`ok: wrote ${flags.out} (fetched ${new Date(fetched_ms).toISOString()}; run gen-new-args within 30 min)`);
      return 0;
    }
    if (cmd !== "gen-new-args") throw new ReleaseError("usage: prices --input F --out F [--providers a,b] | gen-new-args --input F --network mainnet|testnet --out F [--table F] [--now-ms N] [--final | --preflight]");
    if (flags.network !== "mainnet" && flags.network !== "testnet") throw new ReleaseError("--network mainnet|testnet is required");
    if (!flags.input || !flags.out) throw new ReleaseError("--input and --out are required");
    const input = JSON.parse(readFileSync(flags.input, "utf8")) as ReleaseInput;
    const now_ms = flags["now-ms"] !== undefined ? Number(flags["now-ms"]) : Date.now();
    if (!Number.isFinite(now_ms)) throw new ReleaseError("--now-ms must be a number");
    const preflight = flags.preflight === "yes";
    const { args, table, pending } = generate(input, { now_ms, network: flags.network as Network, final: flags.final === "yes", preflight });
    writeFileSync(flags.out, JSON.stringify(args, null, 2) + "\n");
    if (flags.table) writeFileSync(flags.table, table);
    console.log(table.slice(table.indexOf("## Storage charge per side")).trimEnd());
    console.log(`ok: wrote ${flags.out} (${args.asset_limits.length} assets, network ${flags.network}, all asserts passed)`);
    if (preflight) { // MAINPREP1
      for (const p of pending) console.log(`PENDING ${p} (OutLayer-sourced: fill from the mainnet report-pubkey runs / FastFS upload, then rerun with --final)`);
      console.log(pending.length ? `NOT DEPLOYABLE: ${pending.length} OutLayer-sourced field(s) pending; everything else passed the --final checks` : "preflight: no OutLayer-sourced field pending; rerun with --final to produce the deploy args");
    }
    return 0;
  } catch (e) {
    console.error(`REFUSED: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
process.exit(await main());
