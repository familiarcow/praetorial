// SVC1: the one typed table of every long-running service and the env vars
// it reads. A static test (ops/test/serviceEnv.test.ts) fails if a runner's
// source reads a var that is not listed here, so this cannot drift silently.

export interface ServiceSpec {
  /** npm script / launchd label name. */
  name: string;
  /** Runner path relative to services/. */
  runner: string;
  /** Loads common/src/config.ts (loadServiceConfig) so COMMON_VARS apply. */
  usesCommon: boolean;
  /** MON4: writes/is covered by a heartbeat file in HEARTBEAT_DIR. */
  heartbeat: boolean;
  /** Must be set for the service to start. */
  required: string[];
  /** Each group needs at least one member set. */
  requiredOneOf: string[][];
  /** Read but not required (defaults exist). */
  optional: string[];
}

/** Read by common/src (config.ts, rpc.ts, nearClient.ts). */
export const COMMON_VARS: string[] = [
  "ESCROW_CONTRACTS", "ESCROW_CONTRACT_ID", "INTENTS_CONTRACT_ID", "NEAR_NETWORK", "NEAR_NETWORK_ID",
  "NEAR_NODE_URL", "NEAR_RPC_URL", "NEAR_RPC_FALLBACKS", "OUTLAYER_CONTRACT_ID", "USDC_TOKEN_ID",
  "MAX_ATTACHED_NEAR_YOCTO", "NEAR_VIEW_FINALITY",
];

const COMMON_REQUIRED = ["INTENTS_CONTRACT_ID"];
const COMMON_ONE_OF = [["ESCROW_CONTRACT_ID", "ESCROW_CONTRACTS"]];

export const SERVICES: ServiceSpec[] = [
  {
    name: "keeper", runner: "keeper/src/runner.ts", usesCommon: true, heartbeat: true,
    required: [...COMMON_REQUIRED, "KEEPER_KEY_FILE"], requiredOneOf: COMMON_ONE_OF,
    optional: [
      "KEEPER_ACCOUNT_ID", "KEEPER_LOG_FILE", "KEEPER_STATE_FILE", "KEEPER_POLL_INTERVAL_MS", "KEEPER_RUN_ONCE",
      "SOURCE_FAIL_THRESHOLD", "OUTLAYER_FAIL_THRESHOLD", "OUTLAYER_FAIL_WINDOW_MS", "HEARTBEAT_DIR",
      "KEEPER_ATTACH_NEAR_YOCTO", "PRAETORIAL_RESOLVER_SECRET_SEED_HEX", "RESOLVER_DECISIONS_FILE",
      "KEEPER_ARCHIVE_ENABLED", "ARCHIVE_ATTEST_KEY_FILE", "ARCHIVE_ATTEST_ACCOUNT_ID", "ARCHIVE_DIR",
      "ARCHIVE_ATTACH_NEAR_YOCTO", "KEEPER_ALARM_WEBHOOK_URL",
      // CF1a Worker bindings (workers/keeper): the key is a Worker secret, not a key file.
      "KEEPER_PRIVATE_KEY", "TELEGRAM_BOT_TOKEN", "KEEPER_ALERT_TELEGRAM_CHAT_ID", "KEEPER_RPC_PER_SEC",
      "KEEPER_MAX_ACTIONS_PER_TICK", "KEEPER_MAX_VIEWS_PER_TICK", "KEEPER_MAX_DRAINS_PER_TICK", "KEEPER_MAX_RELAYS_PER_TICK", "KEEPER_HEARTBEAT_EVERY_MS",
      // STACK1: injected at deploy (`wrangler deploy --var GIT_SHA:...`), reported by every Worker's GET /health.
      "GIT_SHA",
    ],
  },
  {
    name: "indexer", runner: "indexer/src/server.ts", usesCommon: true, heartbeat: false,
    required: [...COMMON_REQUIRED], requiredOneOf: COMMON_ONE_OF,
    optional: [
      "INDEXER_POLL_INTERVAL_MS", "INDEXER_GOVERNANCE_INTERVAL_MS", "INDEXER_PORT",
      // CF1d Worker bindings (workers/indexer): the D1 binding, per-tick bounds, tx-indexer override and the service binding the dispatcher uses.
      "INDEXER_DB", "INDEXER_SERVICE", "INDEXER_BATCH_BETS", "INDEXER_MAX_CONFIRMS_PER_TICK", "INDEXER_MIN_TICK_INTERVAL_MS",
      "INDEXER_GOVERNANCE_MIN_INTERVAL_MS", "INDEXER_RPC_PER_SEC", "NEAR_TX_INDEXER_URL",
    ],
  },
  {
    name: "notifier", runner: "notifier/src/runner.ts", usesCommon: true, heartbeat: true,
    required: [...COMMON_REQUIRED, "NOTIFIER_CONTACT_KEY"], requiredOneOf: COMMON_ONE_OF,
    optional: [
      "NOTIFIER_ASSET_PRICES", "NOTIFIER_STAKE_ASSET_ID", "NOTIFIER_STAKE_ASSET_DECIMALS", "NOTIFIER_STAKE_ASSET_USD_PRICE",
      "NOTIFIER_CONTACT_DB_FILE", "NOTIFIER_OUTBOX_FILE", "NOTIFIER_SEEN_FILE", "NOTIFIER_POLL_INTERVAL_MS", "NOTIFIER_RUN_ONCE",
      "TELEGRAM_BOT_TOKEN", "NOTIFIER_HIGH_STAKE_USD", "NOTIFIER_BET_LINK_BASE", "HEARTBEAT_DIR",
      // CF1c2 Worker bindings (workers/notifier): per-tick bounds + the service binding the shared dispatcher uses for notifier-tick.
      "NOTIFIER_RPC_PER_SEC", "NOTIFIER_MIN_TICK_INTERVAL_MS", "NOTIFIER_BATCH_BETS", "NOTIFIER_MAX_SENDS_PER_TICK", "NOTIFIER_LOG_KEEP", "NOTIFIER_SERVICE",
    ],
  },
  {
    name: "relayer", runner: "relayer/src/runner.ts", usesCommon: true, heartbeat: true,
    required: [...COMMON_REQUIRED, "RELAYER_KEY_FILE"], requiredOneOf: COMMON_ONE_OF,
    optional: [
      "RELAYER_ACCOUNT_ID", "RELAYER_MAX_TRANSFER_AMOUNT", "RELAYER_MAX_BLOCK_HEIGHT_FUTURE", "RELAYER_PER_CALL_SPONSORSHIP_YOCTO",
      "RELAYER_MAX_REQUESTS_PER_WINDOW", "RELAYER_WINDOW_MS", "RELAYER_DAILY_BUDGET_YOCTO", "RELAYER_GLOBAL_DAILY_BUDGET_YOCTO",
      "RELAYER_RESERVED_SHARE", "RELAYER_BETTOR_CACHE_TTL_MS", "RELAYER_BETTOR_LOOKUP_TIMEOUT_MS", "RELAYER_BETTOR_SCAN_MAX_VIEWS", "RELAYER_GUARD_DB_PATH",
      "INDEXER_URL", "RELAYER_PORT", "HEARTBEAT_DIR", "RELAYER_HEARTBEAT_INTERVAL_MS",
      // CF1b Worker bindings (workers/relayer): the key is a Worker secret, not a key file; RELAYER_SERVICE is the
      // service binding the shared dispatcher (keeper Worker) uses for the heartbeat job.
      "RELAYER_PRIVATE_KEY", "TELEGRAM_BOT_TOKEN", "RELAYER_ALERT_TELEGRAM_CHAT_ID", "RELAYER_RPC_PER_SEC", "RELAYER_SERVICE",
      "STAKE_ASSET_IDS", "RELAYER_REPLAY_STALE_MS", "RELAYER_ACTIVATION_YOCTO", // LIVE1: stakeable assets; stale replay-mark window (open/take/bond); default usdc + fund tokens
      "FAUCET_AMOUNT_YOCTO", "FAUCET_PER_IP_PER_DAY", "FAUCET_GLOBAL_PER_DAY", // FUND1b testnet faucet (amount clamped to 1 NEAR)
      "FUND_TOKEN_CONTRACTS", "WNEAR_CONTRACT_ID", // RELAYFUND1 move-to-betting policy (default: launch token list / wrap.testnet)
    ],
  },
  {
    name: "monitor:alerts", runner: "monitor/src/runner.ts", usesCommon: true, heartbeat: true,
    required: [...COMMON_REQUIRED], requiredOneOf: COMMON_ONE_OF,
    optional: [
      "ALERT_STATE_FILE", "ALERT_LOG_FILE", "ALERT_STALL_GRACE_MS", "ALERT_COOLDOWN_MS", "ALERT_POLL_INTERVAL_MS", "ALERT_RUN_ONCE",
      "FEE_ACCOUNT_ID", "KEEPER_ACCOUNT_ID", "RELAYER_BUDGET_URL", "HEARTBEAT_DIR", "KEEPER_POLL_INTERVAL_MS",
      "RELAYER_HEARTBEAT_INTERVAL_MS", "NOTIFIER_POLL_INTERVAL_MS", "CREDIT_WATCH", "ALERT_RPC_ERROR_THRESHOLD",
      "ALERT_RPC_MIN_CONSECUTIVE_TICKS", "ALERT_TELEGRAM_BOT_TOKEN", "ALERT_TELEGRAM_CHAT_ID",
      "ALERT_STUCK_PAYOUT_MS", // MON1 stuck payouts: alert when a payout line is seen in flight this long (default 600000)
      // CF1c Worker bindings (workers/monitor): per-tick bounds + the service binding the shared dispatcher uses for monitor-tick.
      "MONITOR_RPC_PER_SEC", "MONITOR_MIN_TICK_INTERVAL_MS", "MONITOR_BATCH_BETS", "MONITOR_SERVICE",
    ],
  },
  {
    // The treasury runner does not call loadServiceConfig; it reads these directly.
    name: "treasury", runner: "treasury/src/runner.ts", usesCommon: false, heartbeat: false,
    required: ["TREASURY_ACCOUNT_ID", "ESCROW_CONTRACT_ID", "TREASURY_RELAYER_ACCOUNT_ID", "TREASURY_KEEPER_ACCOUNT_ID", "TREASURY_USD_ASSET_ID"],
    requiredOneOf: [],
    optional: [
      "TREASURY_SCHEDULE_ENABLED", "TREASURY_INTERVAL_MS", "NEAR_NETWORK_ID", "TREASURY_NEAR_ASSET_ID", "TREASURY_FEE_ASSET_IDS",
      "TREASURY_INTENTS_CONTRACT_ID", "TREASURY_RELAYER_FLOAT_TARGET", "TREASURY_KEEPER_FLOAT_TARGET", "TREASURY_DEFAULT_MIN_SWAP_SIZE",
      "TREASURY_SLIPPAGE_BPS", "TREASURY_LIVE", "TREASURY_ALLOW_LIVE_SWAPS", "ONECLICK_API_KEY", "NEAR_RPC_URL", "NEAR_RPC_FALLBACKS",
    ],
  },
];

export function heartbeatServices(): ServiceSpec[] {
  return SERVICES.filter((s) => s.heartbeat);
}

export function allKnownVars(): Set<string> {
  const out = new Set<string>(COMMON_VARS);
  for (const s of SERVICES) for (const v of [...s.required, ...s.requiredOneOf.flat(), ...s.optional]) out.add(v);
  return out;
}
