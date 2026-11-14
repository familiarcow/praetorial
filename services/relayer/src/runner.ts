// HTTP entrypoint: POST /relay { signedDelegate: base64 } -> { ok, txHash }
// Relayer key comes from env (RELAYER_ACCOUNT_ID, RELAYER_KEY_FILE) --
// never logged, never printed, never committed. Testnet only: nothing
// here reads a mainnet network id by default.
import http from "node:http";
import { NearClient } from "@praetorial/common/nearClient.js";
import { loadServiceConfig, loadKeyFile } from "@praetorial/common/config.js";
import { LAUNCH_TOKEN_CONTRACTS } from "./policy.js";
import { createRelayHandler } from "./http.js";
import { indexerBettorLookup, escrowBettorLookupMulti } from "./bettor.js";
import { Relayer, chainPortFromClient, type RelayerConfig } from "./relayer.js";

function relayerConfigFromEnv(): RelayerConfig {
  return {
    escrowContract: required("ESCROW_CONTRACT_ID"),
    intentsContract: required("INTENTS_CONTRACT_ID"),
    usdcTokenId: process.env.USDC_TOKEN_ID ?? "usdc.fakes.testnet",
    stakeAssetIds: process.env.STAKE_ASSET_IDS ? process.env.STAKE_ASSET_IDS.split(",").map((s) => s.trim()).filter(Boolean) : undefined, // LIVE1
    fundTokenContracts: process.env.FUND_TOKEN_CONTRACTS ? process.env.FUND_TOKEN_CONTRACTS.split(",").map((s) => s.trim()).filter(Boolean) : [...LAUNCH_TOKEN_CONTRACTS],
    wnearContract: process.env.WNEAR_CONTRACT_ID ?? "wrap.testnet",
    maxTransferAmount: BigInt(process.env.RELAYER_MAX_TRANSFER_AMOUNT ?? "1000000000000"), // 1,000,000 USDC @6dp default ceiling
    maxBlockHeightFuture: BigInt(process.env.RELAYER_MAX_BLOCK_HEIGHT_FUTURE ?? "1200"), // ~20 min at ~1s/block
    perCallSponsorshipYocto: BigInt(process.env.RELAYER_PER_CALL_SPONSORSHIP_YOCTO ?? "5000000000000000000000"), // 0.005 NEAR/call estimate
    maxRequestsPerWindow: Number(process.env.RELAYER_MAX_REQUESTS_PER_WINDOW ?? "20"),
    windowMs: Number(process.env.RELAYER_WINDOW_MS ?? "60000"),
    dailyBudgetYocto: BigInt(process.env.RELAYER_DAILY_BUDGET_YOCTO ?? "100000000000000000000000"), // 0.1 NEAR/user/day default
    // Persistent by default for the real runner -- restarting the
    // process must not reset any user's nonce/rate-limit/budget state.
    // Tests construct Relayer/Guards directly with ":memory:" instead.
    // D-RLY1: relayer-wide cap across all senders. Default 50x the per-user
    // daily budget. The MAINNET number is set by familiarcow at deploy.
    globalDailyBudgetYocto: process.env.RELAYER_GLOBAL_DAILY_BUDGET_YOCTO ? BigInt(process.env.RELAYER_GLOBAL_DAILY_BUDGET_YOCTO) : undefined,
    reservedShare: Number(process.env.RELAYER_RESERVED_SHARE ?? "0.5"),
    bettorCacheTtlMs: Number(process.env.RELAYER_BETTOR_CACHE_TTL_MS ?? "60000"),
    bettorLookupTimeoutMs: Number(process.env.RELAYER_BETTOR_LOOKUP_TIMEOUT_MS ?? "2000"),
    guardDbPath: process.env.RELAYER_GUARD_DB_PATH ?? "./data/relayer-guards.sqlite3",
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

import { writeHeartbeat } from "../../monitor/src/opsAlerts.js";

export async function main(): Promise<void> {
  const cfg = loadServiceConfig();
  const keyPath = process.env.RELAYER_KEY_FILE;
  if (!keyPath) throw new Error("RELAYER_KEY_FILE env var required");
  const key = loadKeyFile(keyPath);
  const accountId = process.env.RELAYER_ACCOUNT_ID ?? key.account_id;
  if (!accountId) throw new Error("RELAYER_ACCOUNT_ID required");
  const client = new NearClient(cfg, { accountId, privateKey: key.private_key });
  await client.init();

  const relayerCfg = relayerConfigFromEnv();
  const indexerUrl = process.env.INDEXER_URL;
  const bettorLookup = indexerUrl
    ? indexerBettorLookup(indexerUrl)
    : escrowBettorLookupMulti(client, cfg.escrowContracts);
  const relayer = new Relayer(chainPortFromClient(client), relayerCfg, undefined, { bettorLookup });

  const server = http.createServer(createRelayHandler(relayer));
  const port = Number(process.env.RELAYER_PORT ?? 8788);
  if (process.env.HEARTBEAT_DIR) {
    const dir = process.env.HEARTBEAT_DIR;
    const beat = () => { try { writeHeartbeat(dir, "relayer", Date.now()); } catch (e) { console.error("heartbeat write failed", e); } };
    beat();
    setInterval(beat, Number(process.env.RELAYER_HEARTBEAT_INTERVAL_MS ?? 60_000)).unref();
  }
  server.listen(port, () => console.log(`relayer listening on :${port} (NEP-366 meta-tx)`));
}

if (process.argv[1] && process.argv[1].endsWith("runner.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
