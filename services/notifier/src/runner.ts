import { NearClient } from "@praetorial/common/nearClient.js";
import { loadServiceConfig } from "@praetorial/common/config.js";
import { discoverAllBets } from "@praetorial/common/discovery.js";
import { computeNoticesMulti, appendOutbox, loadSeenKeys, saveSeenKeys } from "./notifier.js";
import { ContactStore } from "./contactStore.js";
import { TelegramChannel } from "./telegram.js";
import { routeHighStakeToTelegram, noticesToHighStakeEvents, type AssetPriceTable } from "./highStakeRouter.js";
import type { Bet } from "@praetorial/common/types.js";
import { createSecondRpcClient } from "@praetorial/common/terminalConfirm.js";
import { filterConfirmedTerminals } from "./confirm.js";
import { ServiceAlertRaiser, runVersionCheck } from "../../monitor/src/serviceAlerts.js";
import { LogOnlyAlertChannel } from "../../monitor/src/alertChannel.js";

/** Telegram 2nd channel is opt-in at the deployment level: unset
 * TELEGRAM_BOT_TOKEN (e.g. local/dev) means routeHighStake below is
 * simply skipped -- the existing channel is completely unaffected. No
 * live price feed is called here (none exists in services/common); the
 * price table below is a deployment-supplied constant, same "injected,
 * not invented" posture as highStakeRouter.ts.
 *
 * Each bet's maker and taker can stake DIFFERENT assets (cross-asset
 * bets, contracts/escrow/src/lib.rs Envelope.maker_asset/taker_asset),
 * so this table is keyed by asset id and may carry more than one
 * entry -- it is no longer "the one stake asset this deployment
 * supports". NOTIFIER_ASSET_PRICES, if set, is a JSON object:
 *   {"usdc.fakes.testnet":{"decimals":6,"usdPerToken":1}, ...}
 * Falling back to the legacy single-asset env vars keeps pre-existing
 * same-asset-only deployments working unchanged with no config
 * migration required. */
function loadStakePriceTable(): AssetPriceTable {
  const json = process.env.NOTIFIER_ASSET_PRICES;
  if (json) {
    try {
      return JSON.parse(json) as AssetPriceTable;
    } catch (err) {
      throw new Error(`NOTIFIER_ASSET_PRICES is not valid JSON: ${(err as Error).message}`);
    }
  }
  const assetId = process.env.NOTIFIER_STAKE_ASSET_ID ?? "usdc.fakes.testnet";
  const decimals = Number(process.env.NOTIFIER_STAKE_ASSET_DECIMALS ?? "6");
  const usdPerToken = Number(process.env.NOTIFIER_STAKE_ASSET_USD_PRICE ?? "1");
  return { [assetId]: { decimals, usdPerToken } };
}

/** User-deletion entrypoint (TASK A): wipes every stored row for
 * `account` from the contact store at `dbPath`. No other state in this
 * service holds any PII to delete -- notices/outbox/seen-keys/
 * notification-log are all account-id-only (already-public chain data)
 * by construction, see notifier.ts and notificationLog.ts. */
import { writeHeartbeat } from "../../monitor/src/opsAlerts.js";

export function deleteContact(dbPath: string, account: string): void {
  const store = new ContactStore(dbPath, process.env.NOTIFIER_CONTACT_KEY);
  try {
    store.deleteContact(account);
  } finally {
    store.close();
  }
}

export async function main(): Promise<void> {
  const cfg = loadServiceConfig();
  // Refuses to start without a key to encrypt contact info at rest --
  // ContactStore's constructor throws if NOTIFIER_CONTACT_KEY is
  // missing/malformed, so constructing it here up front fails fast
  // before the service does anything else.
  const contactDbPath = process.env.NOTIFIER_CONTACT_DB_FILE ?? "./data/notifier-contacts.sqlite3";
  const contactStore = new ContactStore(contactDbPath, process.env.NOTIFIER_CONTACT_KEY);
  const client = new NearClient(cfg, { accountId: cfg.escrowContract, privateKey: "" });
  const outboxPath = process.env.NOTIFIER_OUTBOX_FILE ?? "./data/notifier-outbox.jsonl";
  const seenPath = process.env.NOTIFIER_SEEN_FILE ?? "./data/notifier-seen.json";
  const intervalMs = Number(process.env.NOTIFIER_POLL_INTERVAL_MS ?? 20_000);
  const once = process.env.NOTIFIER_RUN_ONCE === "1";

  // D-UPGRADE1: per-contract discovery frontier -- a plain object
  // (not discoverAllBetsMulti's own Record) keyed by contract id so
  // maxIds persists correctly across however many contracts are
  // configured, including the single-ESCROW_CONTRACT_ID back-compat
  // case (one entry).
  const maxIds: Record<string, number> = {};
  const seen = loadSeenKeys(seenPath);
  // D-DSY1: version label check each tick; terminal outcomes announced only
  // after rpcUrls[1] agrees (single RPC => never announced + alert).
  const second = createSecondRpcClient(cfg);
  const raiser = new ServiceAlertRaiser(new LogOnlyAlertChannel((m) => console.error(m)));
  const confirmedCache = new Set<string>();

  // Telegram 2nd channel: only constructed when a bot token is
  // configured -- TelegramChannel's own constructor would otherwise
  // throw, and this deployment may simply not have opted into it yet.
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChannel = telegramBotToken ? new TelegramChannel({ fetchImpl: fetch, botToken: telegramBotToken }) : null;
  const stakePriceTable = loadStakePriceTable();
  const highStakeThresholdUsd = Number(process.env.NOTIFIER_HIGH_STAKE_USD ?? "500");
  const explorerLinkBase = process.env.NOTIFIER_BET_LINK_BASE ?? "https://testnet.praetorial.example/bet";

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (process.env.HEARTBEAT_DIR) { try { writeHeartbeat(process.env.HEARTBEAT_DIR, "notifier", Date.now()); } catch (e) { console.error("heartbeat write failed", e); } }
    try {
      const betsByContract = new Map<string, Map<number, Bet>>();
      // One unreadable contract must not stop notices for the others.
      for (const contract of cfg.escrowContracts) {
        try {
          const known = maxIds[contract.id] ?? 0;
          const { bets, newMaxId } = await discoverAllBets(client, contract.id, known);
          maxIds[contract.id] = newMaxId;
          betsByContract.set(contract.id, bets);
        } catch (err) {
          console.error(`notifier: contract ${contract.id} unreadable, skipping this tick`, err);
        }
      }
      await runVersionCheck(client, cfg.escrowContracts, raiser);
      const confirmedByContract = await filterConfirmedTerminals(betsByContract, { second, raiser, cache: confirmedCache });
      const notices = computeNoticesMulti(confirmedByContract, Date.now() * 1_000_000, seen);
      appendOutbox(outboxPath, notices);
      saveSeenKeys(seenPath, seen);
      if (notices.length) console.log(`notifier: wrote ${notices.length} notice(s)`);

      // High-stakes (>= $500 USD-equivalent per side) additionally
      // fan out to Telegram, on top of (never instead of) the outbox
      // above. Best-effort: a Telegram delivery failure never blocks
      // or rolls back the outbox/seen-keys writes that already
      // happened.
      if (telegramChannel && notices.length) {
        const events = noticesToHighStakeEvents(notices, confirmedByContract, explorerLinkBase);
        await routeHighStakeToTelegram(events, stakePriceTable, contactStore, telegramChannel, highStakeThresholdUsd);
      }
    } catch (err) {
      console.error("notifier tick failed", err);
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

if (process.argv[1] && process.argv[1].endsWith("runner.ts") && process.argv[1].includes("notifier")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
