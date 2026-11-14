// Monitoring-alert runner: periodically snapshots escrow state (reusing
// snapshot.ts + invariants.ts), decides which alerts are due, dedupes
// against a cooldown, and delivers through an injected AlertChannel
// (log-only by default -- a real Telegram/email send is opt-in via
// env). `runAlertTick`/`createAlertRunnerState` are the fully testable
// core: every dependency is an injected AlertSnapshotProvider, so unit
// tests drive it with mocked chain/RPC data and a fabricated clock,
// never a real network call. `main()` below is the only part of this
// file that touches a real NearClient/RPC/Telegram -- it just wires a
// concrete AlertSnapshotProvider and loops runAlertTick on a timer.
import fs from "node:fs";
import path from "node:path";
import { NearClient } from "@praetorial/common/nearClient.js";
import { loadServiceConfig } from "@praetorial/common/config.js";
import { discoverAllBets } from "@praetorial/common/discovery.js";
import { checkContractShutdown } from "@praetorial/common/shutdown.js";
import { getAttemptCount, get429Count, DEFAULT_TESTNET_RPC_URL } from "@praetorial/common/rpc.js";
import type { Bet, PendingPayout } from "@praetorial/common/types.js";
import { nextActionForBet } from "../../keeper/src/policy.js";
import { TelegramChannel } from "../../notifier/src/telegram.js";
import type { Violation } from "./invariants.js";
import { runMonitor, checkI2ContractWide, type MonitorResult } from "./invariants.js";
import { fundsInForBet, trackedTotalByAsset } from "./snapshot.js";
import {
  AlertDedupe,
  RpcErrorRateTracker,
  StallTracker,
  alertsForContractState,
  alertsForInvariantResults,
  loadDedupeState,
  saveDedupeState,
  type Alert,
  type DueAction,
  type RpcStats,
} from "./alerts.js";
import {
  alertForUncheckable,
  alertsForStorageHeadroom,
  appendSample,
  fetchHeadroomSample,
  type HeadroomSample,
} from "./storageHeadroom.js";
import {
  alertForRelayerBudgetUnchecked,
  alertsForRelayerGlobalBudget,
  fetchRelayerBudget,
  type RelayerBudgetSnapshot,
} from "./relayerBudget.js";
import { RecoveryTracker, alertsForHeartbeats, alertsForKeeperCredit, writeHeartbeat, type HeartbeatService } from "./opsAlerts.js";
import { DEFAULT_STUCK_PAYOUT_THRESHOLD_MS, scanUndonePayouts } from "./stuckPayouts.js";
import { CONTRACT_WIDE_BET_ID, createAlertRunnerState, runAlertTick, type AlertSnapshotProvider, type AlertRunnerState, type AlertRunnerOptions } from "./runnerCore.js";
export * from "./runnerCore.js";
import { LogOnlyAlertChannel, MultiAlertChannel, TelegramAlertChannel, type AlertChannel } from "./alertChannel.js";

/** Builds a real AlertSnapshotProvider against one escrow contract
 * using the shared NearClient -- the same view calls snapshot.ts's
 * checkAfterStep makes (get_bet, is_paused, pending_payouts_view,
 * mt_balance_of), reused here for a periodic full sweep instead of a
 * single post-tx check. */
/** Returns a reader yielding the per-call delta of two cumulative
 * counters (baseline = values at creation). */
export function makeRpcStatsDelta(
  getAttempts: () => number,
  get429s: () => number,
): () => { total: number; errors: number } {
  let lastTotal = getAttempts();
  let lastErrors = get429s();
  return () => {
    const t = getAttempts();
    const e = get429s();
    const out = { total: Math.max(0, t - lastTotal), errors: Math.max(0, e - lastErrors) };
    lastTotal = t;
    lastErrors = e;
    return out;
  };
}

export function buildLiveProvider(
  client: NearClient,
  contractId: string,
  intentsContract: string,
  usdcTokenId: string,
  accounts: { feeAccount: string; keeper: string },
  rpcUrl: string = DEFAULT_TESTNET_RPC_URL,
  relayerBudgetUrl?: string,
): AlertSnapshotProvider {
  const rpcDelta = makeRpcStatsDelta(getAttemptCount, get429Count);
  let payoutScanFrom = 1; // MON1: oldest not-done payout line seen last scan (process-lifetime)
  return {
    contractId,
    async fetchInvariantResults() {
      const { bets } = await discoverAllBets(client, contractId, 0);
      const betIds = [...bets.keys()];
      const payouts = await client.view<PendingPayout[]>(contractId, "pending_payouts_view", { from: 0, limit: 500 });
      const payoutsByBet = new Map<number, PendingPayout[]>();
      for (const p of payouts) {
        const arr = payoutsByBet.get(p.bet_id) ?? [];
        arr.push(p);
        payoutsByBet.set(p.bet_id, arr);
      }
      const paused = await client.view<boolean>(contractId, "is_paused", {});
      // I-2 contract-wide, per asset: every asset appearing in tracked
      // bets/payouts plus the configured one.
      const trackedByAsset = await trackedTotalByAsset(client, contractId, betIds);
      const assets = new Set<string>([usdcTokenId, ...trackedByAsset.keys()]);
      const contractWide: Violation[] = [];
      for (const asset of [...assets].sort()) {
        const actual = BigInt(
          await client.view<string>(intentsContract, "mt_balance_of", { account_id: contractId, token_id: asset }),
        );
        for (const v of checkI2ContractWide(trackedByAsset.get(asset) ?? 0n, actual)) {
          contractWide.push({ ...v, asset, detail: `asset=${asset} ${v.detail}` });
        }
      }
      const results = new Map<number, MonitorResult>();
      for (const [id, bet] of bets) {
        const actors = {
          maker: bet.envelope.maker,
          taker: bet.taker,
          feeAccount: accounts.feeAccount,
          keeper: accounts.keeper,
          arbiter: bet.envelope.arbiter,
        };
        results.set(
          id,
          runMonitor({
            betId: id,
            paused,
            actors,
            payouts: payoutsByBet.get(id) ?? [],
            fundsIn: fundsInForBet(bet),
            // contract-wide I-2 is done per asset above, not per bet
            trackedTotalYocto: 0n,
            actualIntentsBalanceYocto: 0n,
            bet,
          }),
        );
      }
      if (contractWide.length > 0) {
        results.set(CONTRACT_WIDE_BET_ID, { ok: false, violations: contractWide });
      }
      return results;
    },
    async fetchDueActions() {
      const { bets } = await discoverAllBets(client, contractId, 0);
      const nowNs = Date.now() * 1_000_000;
      const actions: DueAction[] = [];
      for (const [id, bet] of bets) {
        const action = nextActionForBet(bet, id, nowNs);
        if (action) actions.push({ contractId, betId: id, kind: action.kind });
      }
      return actions;
    },
    async fetchRpcStats() {
      // get429Count/getAttemptCount are process-wide cumulative
      // counters (common/src/rpc.ts); the delta between ticks is this
      // tick's window. Falls back to a zero-error tick if nothing was
      // attempted since the last read (no RPC calls made => no RPC
      // problem to report).
      return rpcDelta();
    },
    async fetchUndonePayouts() {
      const scan = await scanUndonePayouts(client, contractId, payoutScanFrom);
      payoutScanFrom = scan.nextFrom;
      return scan;
    },
    async fetchStorageHeadroomSample(nowNs: number) {
      return fetchHeadroomSample(rpcUrl, contractId, nowNs);
    },
    ...(relayerBudgetUrl ? { fetchRelayerBudget: () => fetchRelayerBudget(relayerBudgetUrl) } : {}),
    async fetchContractState() {
      const paused = await client.view<boolean>(contractId, "is_paused", {});
      const shutdown = await checkContractShutdown(client, contractId);
      return { paused, shutdown };
    },
  };
}

export async function main(): Promise<void> {
  const cfg = loadServiceConfig();
  const client = new NearClient(cfg, { accountId: cfg.escrowContract, privateKey: "" });

  const stateFile = process.env.ALERT_STATE_FILE ?? "./data/monitor-alert-state.json";
  const logFile = process.env.ALERT_LOG_FILE ?? "./data/monitor-alerts.jsonl";
  const stallGraceNs = Number(process.env.ALERT_STALL_GRACE_MS ?? 10 * 60_000) * 1_000_000;
  const cooldownNs = Number(process.env.ALERT_COOLDOWN_MS ?? 30 * 60_000) * 1_000_000;
  const intervalMs = Number(process.env.ALERT_POLL_INTERVAL_MS ?? 30_000);
  const once = process.env.ALERT_RUN_ONCE === "1";
  const feeAccount = process.env.FEE_ACCOUNT_ID ?? "";
  const keeperAccount = process.env.KEEPER_ACCOUNT_ID ?? "";

  const provider = buildLiveProvider(client, cfg.escrowContract, cfg.intentsContract, cfg.usdcTokenId, {
    feeAccount,
    keeper: keeperAccount,
  }, cfg.nodeUrl, process.env.RELAYER_BUDGET_URL); // e.g. http://127.0.0.1:8788/budget/global

  // MON4: heartbeats (HEARTBEAT_DIR) + account-balance floors. Both opt-in by env.
  const hbDir = process.env.HEARTBEAT_DIR;
  const hbServices: HeartbeatService[] = [
    { name: "keeper", intervalMs: Number(process.env.KEEPER_POLL_INTERVAL_MS ?? 15_000) },
    { name: "relayer", intervalMs: Number(process.env.RELAYER_HEARTBEAT_INTERVAL_MS ?? 60_000) },
    { name: "monitor", intervalMs },
    { name: "notifier", intervalMs: Number(process.env.NOTIFIER_POLL_INTERVAL_MS ?? 20_000) },
  ];
  // CREDIT_WATCH="keeper.near:floorYocto[:burnPerDayYocto],attest.near:...,relayer.near:..."
  const creditWatch = (process.env.CREDIT_WATCH ?? "").split(",").filter(Boolean).map((e) => e.split(":"));
  if (hbDir || creditWatch.length) {
    provider.fetchOpsAlerts = async (nowNs: number) => {
      const out: Alert[] = [];
      if (hbDir) out.push(...alertsForHeartbeats(hbDir, hbServices, Math.floor(nowNs / 1e6)));
      for (const [account, floor, burn] of creditWatch) {
        const r = await fetch(cfg.nodeUrl, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: account } }) });
        const amount = ((await r.json()) as any)?.result?.amount;
        if (typeof amount === "string") out.push(...alertsForKeeperCredit({ account: account!, balanceYocto: amount, floorYocto: floor!, ...(burn ? { burnPerDayYocto: burn } : {}) }));
      }
      return out;
    };
  }

  const state = createAlertRunnerState({
    stallGraceNs,
    cooldownNs,
    rpcErrorThresholdRatio: Number(process.env.ALERT_RPC_ERROR_THRESHOLD ?? "0.5"),
    rpcMinConsecutiveTicks: Number(process.env.ALERT_RPC_MIN_CONSECUTIVE_TICKS ?? "3"),
    initialLastSentNs: loadDedupeState(stateFile),
    stuckPayoutThresholdNs: Number(process.env.ALERT_STUCK_PAYOUT_MS ?? DEFAULT_STUCK_PAYOUT_THRESHOLD_MS) * 1_000_000,
  });

  // Dry-run/log-only by default: a real Telegram operator send is
  // opt-in via ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID. Never
  // replaces the log channel -- both fire so there's always a local
  // audit trail even when Telegram is also configured.
  const channels: AlertChannel[] = [
    new LogOnlyAlertChannel((msg) => {
      console.log(msg);
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, msg + "\n");
    }),
  ];
  const botToken = process.env.ALERT_TELEGRAM_BOT_TOKEN;
  const chatId = process.env.ALERT_TELEGRAM_CHAT_ID;
  if (botToken && chatId) {
    channels.push(new TelegramAlertChannel(new TelegramChannel({ fetchImpl: fetch, botToken }), chatId));
  }
  const channel = new MultiAlertChannel(channels);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const nowNs = Date.now() * 1_000_000;
      if (hbDir) writeHeartbeat(hbDir, "monitor", Date.now());
      const sent = await runAlertTick(provider, state, channel, nowNs);
      saveDedupeState(stateFile, state.lastSentNs);
      if (sent.length) console.log(`monitor alerts: sent ${sent.length} alert(s)`);
    } catch (err) {
      console.error("monitor alert tick failed", err);
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

if (process.argv[1] && process.argv[1].endsWith("runner.ts") && process.argv[1].includes("monitor")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
