import fs from "node:fs";
import { SERVICES, COMMON_VARS } from "./serviceEnv.js";
import { loadEnvFile, parseFlags, realIo, type CliIo } from "./envFile.js";

export type Network = "testnet" | "mainnet";
export interface ReleaseIds { escrow: string; resolver?: string }
export type Verdict = "ok" | "FAIL" | "warn" | "unset";
export interface Finding { service: string; name: string; verdict: Verdict; reason: string }
export interface CheckResult { ok: boolean; findings: Finding[] }

const isSet = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";
const PLACEHOLDER = /pending|todo|tbd/i;

/** Reads escrow (+ optional resolver) account ids from a release/freeze record. Never returns placeholders. */
export function readRelease(path: string, network: Network): ReleaseIds {
  let rec: any;
  try { rec = JSON.parse(fs.readFileSync(path, "utf8")); } catch (e) { throw new Error(`cannot read release record: ${(e as Error).message.split("\n")[0]}`); }
  const pick = (...c: unknown[]): string | undefined => c.find((x): x is string => typeof x === "string" && x.trim() !== "");
  const escrow = pick(rec?.[`${network}_escrow`]?.account, network === "testnet" ? rec?.escrow_account : rec?.mainnet_escrow_account);
  if (!escrow || PLACEHOLDER.test(escrow)) throw new Error(`release record has no ${network} escrow account id (missing or placeholder)`);
  const resolver = pick(rec?.[`${network}_resolver`]?.account, rec?.resolver_account);
  return resolver && !PLACEHOLDER.test(resolver) ? { escrow, resolver } : { escrow };
}

/** Vars whose values are NEAR account/contract/asset ids (scanned for `.testnet` on mainnet). */
const ID_VAR = /(_ACCOUNT_ID|_CONTRACT_ID|_CONTRACTS|_TOKEN_ID|_ASSET_ID|_ASSET_IDS|CREDIT_WATCH)$/;
const idTokens = (v: string): string[] => v.split(/[\s,@:]+/).filter(Boolean);
const escrowIdsOf = (v: string): string[] => v.split(",").map((e) => e.trim().split("@")[0]).filter(Boolean);

export function checkOps(o: { network: Network; env: Record<string, string>; release: ReleaseIds }): CheckResult {
  const { network, env, release } = o;
  const f: Finding[] = [];
  const add = (service: string, name: string, verdict: Verdict, reason: string) => f.push({ service, name, verdict, reason });

  // network agreement
  if (!isSet(env.NEAR_NETWORK_ID)) add("*", "NEAR_NETWORK_ID", "FAIL", "unset (must equal --network)");
  else if (env.NEAR_NETWORK_ID.trim() !== network) add("*", "NEAR_NETWORK_ID", "FAIL", `disagrees with --network ${network}`);
  else add("*", "NEAR_NETWORK_ID", "ok", "matches --network");

  // escrow id vs release record
  let escrowNamed = false;
  if (isSet(env.ESCROW_CONTRACT_ID)) {
    escrowNamed = true;
    if (env.ESCROW_CONTRACT_ID.trim() === release.escrow) add("*", "ESCROW_CONTRACT_ID", "ok", "matches release record escrow id");
    else add("*", "ESCROW_CONTRACT_ID", "FAIL", "names a different escrow id than the release record");
  }
  if (isSet(env.ESCROW_CONTRACTS)) {
    escrowNamed = true;
    const bad = escrowIdsOf(env.ESCROW_CONTRACTS).filter((id) => id !== release.escrow).length;
    if (bad === 0) add("*", "ESCROW_CONTRACTS", "ok", "only the release record escrow id");
    else add("*", "ESCROW_CONTRACTS", "FAIL", `${bad} entr${bad === 1 ? "y names a" : "ies name"} different escrow id than the release record`);
  }
  if (!escrowNamed) add("*", "ESCROW_CONTRACT_ID", "FAIL", "neither ESCROW_CONTRACT_ID nor ESCROW_CONTRACTS is set");

  // mainnet rules
  if (network === "mainnet") {
    const hits = new Set<string>();
    for (const [k, v] of Object.entries(env)) if (ID_VAR.test(k) && isSet(v) && idTokens(v).some((t) => t.endsWith(".testnet"))) hits.add(k);
    for (const k of [...hits].sort()) add("*", k, "FAIL", "id ends in .testnet on mainnet");
    if (release.escrow.endsWith(".testnet") || release.resolver?.endsWith(".testnet")) add("release", "release record", "FAIL", "release record id ends in .testnet on mainnet");
    const fb = (env.NEAR_RPC_FALLBACKS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (fb.length >= 1) add("*", "NEAR_RPC_FALLBACKS", "ok", `${fb.length} fallback(s) (D-RPC1)`);
    else add("*", "NEAR_RPC_FALLBACKS", "FAIL", "empty; mainnet needs >=1 fallback (D-RPC1)");
    for (const k of ["ALERT_TELEGRAM_BOT_TOKEN", "ALERT_TELEGRAM_CHAT_ID"]) {
      if (isSet(env[k])) add("monitor:alerts", k, "ok", "set"); else add("monitor:alerts", k, "FAIL", "unset; required on mainnet");
    }
  } else {
    for (const k of ["ALERT_TELEGRAM_BOT_TOKEN", "ALERT_TELEGRAM_CHAT_ID"]) {
      if (isSet(env[k])) add("monitor:alerts", k, "ok", "set"); else add("monitor:alerts", k, "warn", "unset; alerts are log-only");
    }
  }

  // per service
  for (const s of SERVICES) {
    for (const k of s.required) {
      if (k === "ESCROW_CONTRACT_ID" && s.name === "treasury") {
        if (!isSet(env[k])) add(s.name, k, "FAIL", "unset"); else add(s.name, k, "ok", "set");
        continue;
      }
      if (isSet(env[k])) add(s.name, k, "ok", "set"); else add(s.name, k, "FAIL", "unset");
    }
    for (const g of s.requiredOneOf) {
      if (g.some((k) => isSet(env[k]))) add(s.name, g.join("|"), "ok", "set");
      else add(s.name, g.join("|"), "FAIL", "none set");
    }
    if (s.heartbeat) {
      if (isSet(env.HEARTBEAT_DIR)) add(s.name, "HEARTBEAT_DIR", "ok", "set (MON4)"); else add(s.name, "HEARTBEAT_DIR", "FAIL", "unset; MON4 heartbeats need it");
    }
  }
  void COMMON_VARS;
  return { ok: !f.some((x) => x.verdict === "FAIL"), findings: f };
}

export function formatFindings(r: CheckResult): string[] {
  const lines = r.findings.map((x) => `${x.verdict.padEnd(5)} ${x.service.padEnd(15)} ${x.name} - ${x.reason}`);
  const n = r.findings.filter((x) => x.verdict === "FAIL").length;
  lines.push(r.ok ? "ops:check OK" : `ops:check FAILED (${n} problem${n === 1 ? "" : "s"})`);
  return lines;
}

export async function runCheckCli(argv: string[], io: CliIo = realIo): Promise<number> {
  const flags = parseFlags(argv, ["network", "env-file", "release"]);
  const usage = "usage: ops:check --network <testnet|mainnet> --env-file <path> --release <record.json>";
  if (!flags || (flags.network !== "testnet" && flags.network !== "mainnet") || typeof flags["env-file"] !== "string" || typeof flags.release !== "string") {
    io.stderr(usage); return 2;
  }
  const network = flags.network as Network;
  let env: Record<string, string>; let release: ReleaseIds;
  try { env = loadEnvFile(flags["env-file"]); } catch { io.stderr("cannot read env file"); return 1; }
  try { release = readRelease(flags.release, network); } catch (e) { io.stderr((e as Error).message); return 1; }
  const r = checkOps({ network, env, release });
  for (const l of formatFindings(r)) io.stdout(l);
  return r.ok ? 0 : 1;
}
