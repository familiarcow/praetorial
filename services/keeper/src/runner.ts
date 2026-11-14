// Keeper runner: discover bets -> plan actions -> execute with
// idempotency + rate limiting -> log every tx. Each tick is a pure
// function of (bets, now) via policy.ts; this file is the only place
// that touches RPC/state files, so policy.ts stays unit-testable without
// a network.
import fs from "node:fs";
import path from "node:path";
import { NearClient } from "@praetorial/common/nearClient.js";
import { loadServiceConfig, loadKeyFile, MAX_ATTACHED_NEAR_YOCTO, type EscrowContractRef } from "@praetorial/common/config.js";
import { TxLogger } from "@praetorial/common/logger.js";
import { discoverAllBets, discoverAllBetsMultiTolerant } from "@praetorial/common/discovery.js";
import { planActions, planActionsForContracts, type KeeperAction, type ContractAction } from "./policy.js";
import { resolverKeypairFromSeedHex } from "@praetorial/common/resolverSign.js";
import { loadDecisions, maybeSubmitOutcome } from "./resolverSim.js";
import type { PendingPayout } from "@praetorial/common/types.js";
import { checkContractShutdown } from "@praetorial/common/shutdown.js";
import { isArchiveJobDue, runScheduledArchive, ArchiveStore, type ArchiveJobClient } from "./archiveJob.js";
import { buildArchiveWiring, realArchiveFactories, type ArchiveFactories } from "./archiveProd.js";
import { livenessAlarms, buildAlarmChannel } from "./liveness.js";
import { ServiceAlertRaiser, runVersionCheck } from "../../monitor/src/serviceAlerts.js";
import { LogOnlyAlertChannel } from "../../monitor/src/alertChannel.js";

interface KeeperState {
  maxBetId: number;
  // action key -> last-attempted ISO timestamp, for rate limiting repeat
  // attempts on an action that's already in flight or just failed.
  lastAttempt: Record<string, string>;
}

const RATE_LIMIT_MS = 30_000;

function actionKey(a: KeeperAction): string {
  return `${a.kind}:${a.bet_id}`;
}

function loadState(statePath: string): KeeperState {
  if (fs.existsSync(statePath)) {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  }
  return { maxBetId: 0, lastAttempt: {} };
}

function saveState(statePath: string, state: KeeperState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

const PAYOUT_PAGE = 200;

/** DR-SVC-1: `pending_payouts_view(from, limit)` pages over LIFETIME ledger
 * ids (done lines included, `from` = first id to return), so a single
 * {from:0,limit:200} read hides every line past the 200th ever scheduled.
 * Page until a short page comes back. */
async function fetchAllPayoutLines(client: NearClient, contractId: string): Promise<PendingPayout[]> {
  const all: PendingPayout[] = [];
  let from = 0;
  for (;;) {
    const page = await client.view<PendingPayout[]>(contractId, "pending_payouts_view", { from, limit: PAYOUT_PAGE });
    all.push(...page);
    if (page.length < PAYOUT_PAGE) break;
    const next = Math.max(...page.map((p) => Number(p.id))) + 1;
    if (!(next > from)) break;
    from = next;
  }
  return all;
}

export async function tick(opts: {
  client: NearClient;
  escrowContract: string;
  logger: TxLogger;
  statePath: string;
  resolverSecretSeedHex?: string;
  decisionsPath?: string;
  attachedNearYocto?: bigint;
}): Promise<KeeperAction[]> {
  const { client, escrowContract, logger, statePath } = opts;
  const state = loadState(statePath);

  const { bets, newMaxId } = await discoverAllBets(client, escrowContract, state.maxBetId);
  state.maxBetId = newMaxId;

  // OQ-T11: distinct bet_ids with at least one not-yet-done ledger
  // line -> one drain_payouts action each (not one action per payout
  // id -- the contract batches/caps internally at MAX_DRAIN_BATCH).
  const payouts = await fetchAllPayoutLines(client, escrowContract);
  const duePayoutBetIds = [...new Set(payouts.filter((p) => !p.done).map((p) => p.bet_id))];

  const nowNs = Date.now() * 1_000_000;
  const actions = planActions(bets, nowNs, duePayoutBetIds);

  // D-AUDIT5: the keeper runs with a function-call-scoped access key by
  // default, and NEAR protocol forbids ANY attached deposit on ANY
  // action of a FunctionCall-permission key, regardless of method --
  // so the default here MUST be zero (credit mode: the contract draws
  // compute cost from the keeper's prepaid `keeper_credit` pool, see
  // `request_resolution` in contracts/escrow/src/lib.rs). A keeper
  // instead holding a full-access key (or a BYO-wallet variant) that
  // wants to attach NEAR directly must opt in explicitly via
  // `opts.attachedNearYocto` / KEEPER_ATTACH_NEAR_YOCTO -- never the
  // other way around, since the scoped-key posture is the safe default
  // and a hardcoded non-zero default previously made every
  // request_resolution from a scoped-key keeper fail at the NEAR
  // runtime before it ever reached the contract.
  const attached = opts.attachedNearYocto ?? 0n;
  const executed: KeeperAction[] = [];

  for (const action of actions) {
    const key = actionKey(action);
    const last = state.lastAttempt[key];
    if (last && Date.now() - new Date(last).getTime() < RATE_LIMIT_MS) {
      logger.log({ service: "keeper", action: action.kind, status: "skipped", detail: "rate-limited", bet_id: (action as any).bet_id });
      continue;
    }
    state.lastAttempt[key] = new Date().toISOString();
    try {
      if (action.kind === "expire") {
        const r = await client.call<any>(escrowContract, "expire", { bet_id: action.bet_id });
        logger.log({ service: "keeper", action: "expire", bet_id: action.bet_id, status: "ok", tx_hash: r?.transaction?.hash });
      } else if (action.kind === "request_resolution") {
        if (attached > MAX_ATTACHED_NEAR_YOCTO) throw new Error("per-call NEAR cap exceeded");
        // Zero attached deposit is the scoped-key (credit-mode) shape a
        // FunctionCall-permission key can actually submit -- attaching
        // any deposit, even 0 expressed via callPayable's near-api-js
        // path, is fine for a full-access key but a plain `call` makes
        // the no-deposit intent explicit and matches what a scoped key
        // is physically capable of sending.
        const r = attached === 0n
          ? await client.call<any>(escrowContract, "request_resolution", { bet_id: action.bet_id }, 300)
          : await client.callPayable<any>(
              escrowContract,
              "request_resolution",
              { bet_id: action.bet_id },
              attached,
            );
        logger.log({ service: "keeper", action: "request_resolution", bet_id: action.bet_id, status: "ok", tx_hash: r?.transaction?.hash });
      } else if (action.kind === "finalize") {
        const r = await client.call<any>(escrowContract, "finalize", { bet_id: action.bet_id }, 300);
        logger.log({ service: "keeper", action: "finalize", bet_id: action.bet_id, status: "ok", tx_hash: r?.transaction?.hash });
      } else if (action.kind === "void_after_deadline") {
        const r = await client.call<any>(escrowContract, "void_after_deadline", { bet_id: action.bet_id }, 300);
        logger.log({ service: "keeper", action: "void_after_deadline", bet_id: action.bet_id, status: "ok", tx_hash: r?.transaction?.hash });
      } else if (action.kind === "drain_payouts") {
        // OQ-T11: limit chosen generously above the contract's own
        // MAX_DRAIN_BATCH -- drain_payouts clamps internally, so this
        // just means "drain as much of this bet as fits in one call".
        const r = await client.call<any>(escrowContract, "drain_payouts", { bet_id: action.bet_id, limit: 20 }, 300);
        logger.log({ service: "keeper", action: "drain_payouts", bet_id: action.bet_id, status: "ok", tx_hash: r?.transaction?.hash });
      }
      executed.push(action);
    } catch (err: any) {
      logger.log({ service: "keeper", action: action.kind, status: "error", detail: String(err?.message ?? err), bet_id: (action as any).bet_id });
    }
  }

  // Testnet-only resolver stand-in: submit a signed outcome for any bet
  // sitting in Resolving whose contract-pinned outcome_pubkey
  // (resolver_keys() view, D-KEY1) matches our test key.
  if (opts.resolverSecretSeedHex) {
    const keypair = resolverKeypairFromSeedHex(opts.resolverSecretSeedHex);
    const decisions = loadDecisions(opts.decisionsPath);
    for (const [id, bet] of bets) {
      try {
        const res = await maybeSubmitOutcome(client, escrowContract, id, bet, keypair, decisions);
        if (res.submitted) {
          logger.log({ service: "keeper-resolver-sim", action: "submit_outcome", bet_id: id, status: "ok", detail: res.result?.outcome });
        }
      } catch (err: any) {
        logger.log({ service: "keeper-resolver-sim", action: "submit_outcome", bet_id: id, status: "error", detail: String(err?.message ?? err) });
      }
    }
  }

  saveState(statePath, state);
  return executed;
}

interface KeeperMultiState {
  maxBetIds: Record<string, number>;
  lastAttempt: Record<string, string>;
  /** LH3: `${contract}:${betId}` -> ns (decimal string) of the last archive attempt. */
  lastArchive?: Record<string, string>;
}

/** LH3: optional archive wiring for tickMulti. */
export interface ArchiveWiring {
  client: ArchiveJobClient;
  store: ArchiveStore;
  /** The bet's RAW term sheet (sha256 must equal envelope.terms_hash); null = not available. */
  getRawTerms(contractId: string, betId: number): Promise<string | null>;
  /** Injectable clock (ms), default Date.now. */
  nowMs?: () => number;
}

function loadMultiState(statePath: string): KeeperMultiState {
  if (fs.existsSync(statePath)) {
    let raw: any;
    try {
      raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch {
      // Truncated/corrupt (crash mid-write): the state is only a scan
      // frontier + rate-limit hints, all re-derivable from chain. Starting
      // fresh is safe; throwing here would brick the keeper forever.
      return { maxBetIds: {}, lastAttempt: {} };
    }
    // Back-compat: an old single-contract state file has `maxBetId`
    // (number), not `maxBetIds` (per-contract record) -- migrate it
    // forward under its own contract id rather than discarding
    // progress and rescanning from 1.
    if (raw && typeof raw.maxBetId === "number" && !raw.maxBetIds) {
      return { maxBetIds: {}, lastAttempt: raw.lastAttempt ?? {}, lastArchive: raw.lastArchive ?? {} };
    }
    return { maxBetIds: raw.maxBetIds ?? {}, lastAttempt: raw.lastAttempt ?? {}, lastArchive: raw.lastArchive ?? {} };
  }
  return { maxBetIds: {}, lastAttempt: {} };
}

function saveMultiState(statePath: string, state: KeeperMultiState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  // Atomic replace: a crash can leave the old file or the new one, never a torn one.
  const tmp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}

function contractActionKey(ca: ContractAction): string {
  return `${ca.contractId}:${ca.action.kind}:${ca.action.bet_id}`;
}

/** D-UPGRADE1 multi-contract tick: discovers bets across every
 * configured escrow contract, checks each contract's (mocked)
 * is_shutdown view, and plans/executes actions per planActionsForContracts
 * -- emergency_refund for every open bet on a shut-down contract,
 * normal policy actions everywhere else. A single-entry `contracts`
 * list (the common case today) behaves exactly like the legacy
 * single-contract tick(). */
export async function tickMulti(opts: {
  client: NearClient;
  contracts: EscrowContractRef[];
  logger: TxLogger;
  statePath: string;
  resolverSecretSeedHex?: string;
  decisionsPath?: string;
  attachedNearYocto?: bigint;
  archive?: ArchiveWiring;
  /** LH5: injectable clock (ms) for tests; defaults to Date.now. */
  nowMs?: () => number;
  /** LH5: liveness alarm raiser (log + optional webhook). */
  alarm?: ServiceAlertRaiser;
  /** MON4: request_resolution success/failure history -> outlayer_unhealthy (+ recovery). */
  outlayer?: OutlayerHealthTracker;
  /** MON4b: archive-run results -> source_unreachable (+ recovery) and nearai 402. */
  sourceFeed?: SourceCheckFeed;
}): Promise<ContractAction[]> {
  const { client, contracts, logger, statePath } = opts;
  const clock = opts.nowMs ?? Date.now;
  const state = loadMultiState(statePath);

  const { bets, newMaxIds, failed } = await discoverAllBetsMultiTolerant(client, contracts, state.maxBetIds);
  state.maxBetIds = newMaxIds;
  for (const f of failed) {
    logger.log({ service: "keeper", action: "discover", status: "error", detail: `contract ${f.contractId} unreadable: ${f.error}` });
  }

  const shutdownContracts = new Set<string>();
  for (const contract of contracts) {
    if (await checkContractShutdown(client, contract.id)) shutdownContracts.add(contract.id);
  }

  const pendingPayoutBetIds: { contractId: string; betId: number }[] = [];
  for (const contract of contracts) {
    try {
      const payouts = await fetchAllPayoutLines(client, contract.id);
      for (const betId of new Set(payouts.filter((p) => !p.done).map((p) => p.bet_id))) {
        pendingPayoutBetIds.push({ contractId: contract.id, betId });
      }
    } catch (err: any) {
      logger.log({ service: "keeper", action: "pending_payouts_view", status: "error", detail: String(err?.message ?? err) });
    }
  }

  const nowNs = clock() * 1_000_000;
  const actions = planActionsForContracts(bets, nowNs, shutdownContracts, pendingPayoutBetIds);

  const attached = opts.attachedNearYocto ?? 0n;
  const executed: ContractAction[] = [];

  for (const ca of actions) {
    const { contractId, action } = ca;
    const key = contractActionKey(ca);
    const last = state.lastAttempt[key];
    if (last && clock() - new Date(last).getTime() < RATE_LIMIT_MS) {
      logger.log({ service: "keeper", action: action.kind, status: "skipped", detail: "rate-limited", bet_id: action.bet_id, contract_id: contractId } as any);
      continue;
    }
    state.lastAttempt[key] = new Date(clock()).toISOString();
    // Durable BEFORE the tx is sent: a crash/restart mid-action must not
    // re-fire the same (credit-spending) action on the next boot.
    saveMultiState(statePath, state);
    try {
      if (action.kind === "expire") {
        const r = await client.call<any>(contractId, "expire", { bet_id: action.bet_id });
        logger.log({ service: "keeper", action: "expire", bet_id: action.bet_id, status: "ok", tx_hash: r?.transaction?.hash, contract_id: contractId } as any);
      } else if (action.kind === "request_resolution") {
        if (attached > MAX_ATTACHED_NEAR_YOCTO) throw new Error("per-call NEAR cap exceeded");
        const r = attached === 0n
          ? await client.call<any>(contractId, "request_resolution", { bet_id: action.bet_id }, 300)
          : await client.callPayable<any>(contractId, "request_resolution", { bet_id: action.bet_id }, attached);
        logger.log({ service: "keeper", action: "request_resolution", bet_id: action.bet_id, status: "ok", tx_hash: r?.transaction?.hash, contract_id: contractId } as any);
        await mon4Observe(opts, true, "");
      } else if (action.kind === "finalize") {
        const r = await client.call<any>(contractId, "finalize", { bet_id: action.bet_id }, 300);
        logger.log({ service: "keeper", action: "finalize", bet_id: action.bet_id, status: "ok", tx_hash: r?.transaction?.hash, contract_id: contractId } as any);
      } else if (action.kind === "void_after_deadline") {
        const r = await client.call<any>(contractId, "void_after_deadline", { bet_id: action.bet_id }, 300);
        logger.log({ service: "keeper", action: "void_after_deadline", bet_id: action.bet_id, status: "ok", tx_hash: r?.transaction?.hash, contract_id: contractId } as any);
      } else if (action.kind === "drain_payouts") {
        const r = await client.call<any>(contractId, "drain_payouts", { bet_id: action.bet_id, limit: 20 }, 300);
        logger.log({ service: "keeper", action: "drain_payouts", bet_id: action.bet_id, status: "ok", tx_hash: r?.transaction?.hash, contract_id: contractId } as any);
      } else if (action.kind === "emergency_refund") {
        // D-UPGRADE1: mocked chain method -- modeled, not invented
        // beyond what's documented in common/src/shutdown.ts; the
        // contract doesn't implement this today.
        const r = await client.call<any>(contractId, "emergency_refund", { bet_id: action.bet_id }, 300);
        logger.log({ service: "keeper", action: "emergency_refund", bet_id: action.bet_id, status: "ok", tx_hash: r?.transaction?.hash, contract_id: contractId } as any);
      }
      executed.push(ca);
    } catch (err: any) {
      logger.log({ service: "keeper", action: action.kind, status: "error", detail: String(err?.message ?? err), bet_id: action.bet_id, contract_id: contractId } as any);
      if (action.kind === "request_resolution") await mon4Observe(opts, false, String(err?.message ?? err));
    }
  }

  if (opts.alarm) {
    try { await opts.alarm.raise(livenessAlarms(bets, nowNs)); } catch (err: any) {
      logger.log({ service: "keeper", action: "liveness_alarm", status: "error", detail: String(err?.message ?? err) } as any);
    }
  }

  // KEEPSUBMIT1: relay the resolver's stored signed result (bet.last_resolution_raw) to the permissionless submit_outcome.
  // Never signs; the contract re-verifies the signature. A failure is logged and retried next tick (the bet is still in a relayable status).
  const relayed = new Set<string>();
  for (const [k, tb] of bets) {
    const plan = planOutcomeRelay(tb.contractId, tb.betId, tb.bet);
    if (!plan.ok) continue;
    const base = { service: "keeper-outcome-relay", action: "submit_outcome", bet_id: tb.betId, contract_id: tb.contractId } as any;
    try {
      const r = await client.call<any>(tb.contractId, "submit_outcome", plan.args as unknown as Record<string, unknown>, 300);
      relayed.add(k);
      logger.log({ ...base, status: "ok", tx_hash: r?.transaction?.hash, detail: `${plan.outcome} run_no=${plan.run_no}` });
    } catch (err: any) {
      logger.log({ ...base, status: "error", detail: String(err?.message ?? err) });
    }
  }

  if (opts.resolverSecretSeedHex) {
    const keypair = resolverKeypairFromSeedHex(opts.resolverSecretSeedHex);
    const decisions = loadDecisions(opts.decisionsPath);
    for (const [k, tb] of bets) {
      if (relayed.has(k)) continue;
      try {
        const res = await maybeSubmitOutcome(client, tb.contractId, tb.betId, tb.bet, keypair, decisions);
        if (res.submitted) {
          logger.log({ service: "keeper-resolver-sim", action: "submit_outcome", bet_id: tb.betId, status: "ok", detail: res.result?.outcome, contract_id: tb.contractId } as any);
        }
      } catch (err: any) {
        logger.log({ service: "keeper-resolver-sim", action: "submit_outcome", bet_id: tb.betId, status: "error", detail: String(err?.message ?? err), contract_id: tb.contractId } as any);
      }
    }
  }

  if (opts.archive) {
    state.lastArchive ??= {};
    await runArchiveDuties(opts.archive, client, logger, bets, state.lastArchive, () => saveMultiState(statePath, state), opts.sourceFeed);
  }

  saveMultiState(statePath, state);
  return executed;
}

/** LH3: for every live bet that is due (first sight, then every 6 h),
 * run the resolver archive job and store the verified snapshots, write
 * the manifest and log its sha256. Every failure is logged and swallowed
 * per bet: archiving must never stop the keeper's other duties. Never
 * calls submit_exhibits (the contract refuses it during Taken). */
async function runArchiveDuties(
  a: ArchiveWiring,
  client: NearClient,
  logger: TxLogger,
  bets: Map<string, { contractId: string; betId: number; bet: any }>,
  lastArchive: Record<string, string>,
  persist: () => void,
  feed?: SourceCheckFeed,
): Promise<void> {
  const nowNs = BigInt((a.nowMs ?? Date.now)()) * 1_000_000n;
  for (const [, tb] of bets) {
    const key = `${tb.contractId}:${tb.betId}`;
    const last = lastArchive[key];
    if (!isArchiveJobDue(tb.bet, { lastArchivedAtNs: last === undefined ? null : BigInt(last) }, nowNs)) continue;
    const betIdStr = String(tb.betId);
    const base = { service: "keeper", action: "archive", bet_id: tb.betId, contract_id: tb.contractId } as any;
    try {
      const raw = await a.getRawTerms(tb.contractId, tb.betId);
      if (raw === null) {
        logger.log({ ...base, status: "skipped", detail: "raw term sheet unavailable" });
        continue;
      }
      const [, attestPubkey] = await client.view<[string, string, string]>(tb.contractId, "resolver_keys", {});
      lastArchive[key] = nowNs.toString();
      persist(); // durable before the (billable) job is sent
      const { stored, failed, raw: runRaw } = await runScheduledArchive(a.client, a.store, betIdStr, attestPubkey, tb.bet.envelope.terms_hash, raw, tb.contractId);
      await feed?.observeRun({ contractId: tb.contractId, betId: tb.betId }, { stored, failed, raw: runRaw }, Number(nowNs));
      for (const f of failed) logger.log({ ...base, status: "error", detail: `source ${f.id}: ${f.reason}` });
      logger.log({ ...base, status: "ok", detail: `stored ${stored.length} snapshot(s), ${failed.length} failed` });
      if (a.store.dir) {
        const m = a.store.writeManifest(betIdStr);
        if (m) logger.log({ ...base, action: "archive_manifest", status: "ok", detail: `manifest sha256=${m.sha256} path=${m.path}` });
      }
    } catch (err: any) {
      logger.log({ ...base, status: "error", detail: String(err?.message ?? err) });
      if (feed && err instanceof Error && lastArchive[key] === nowNs.toString()) await feed.observeRun({ contractId: tb.contractId, betId: tb.betId }, err, Number(nowNs));
    }
  }
}

import { SourceCheckFeed } from "./sourceFeed.js";
import { planOutcomeRelay } from "@praetorial/common/outcomeRelay.js";
import { writeHeartbeat, OutlayerHealthTracker, SourceCheckTracker, alertForNearAiError } from "../../monitor/src/opsAlerts.js";

/** MON4: feed one request_resolution outcome to the OutLayer tracker and the NEAR AI 402 detector. */
async function mon4Observe(opts: { alarm?: ServiceAlertRaiser; outlayer?: OutlayerHealthTracker; nowMs?: () => number }, ok: boolean, detail: string): Promise<void> {
  if (!opts.alarm) return;
  const nowNs = (opts.nowMs ?? Date.now)() * 1_000_000;
  try {
    const alerts = [];
    const o = opts.outlayer?.record(ok, nowNs, detail);
    if (o) alerts.push(o);
    if (!ok) { const n = alertForNearAiError("keeper", detail); if (n) alerts.push(n); }
    if (alerts.length) await opts.alarm.raise(alerts);
  } catch { /* alerts never break the tick */ }
}

/** LH3b: injectable seams so main()'s production wiring is testable offline. */
export interface MainDeps {
  env?: Record<string, string | undefined>;
  makeNearClient?: (cfg: ReturnType<typeof loadServiceConfig>, signer: { accountId: string; privateKey: string }) => Promise<NearClient>;
  tickMulti?: typeof tickMulti;
  archiveFactories?: ArchiveFactories;
}

export async function main(deps: MainDeps = {}): Promise<void> {
  // loadServiceConfig reads process.env; an injected env is applied to it for this run.
  if (deps.env) for (const [k, v] of Object.entries(deps.env)) if (v !== undefined) process.env[k] = v;
  const env = deps.env ?? process.env;
  const cfg = loadServiceConfig();
  const keyPath = env.KEEPER_KEY_FILE;
  if (!keyPath) throw new Error("KEEPER_KEY_FILE env var required");
  const key = loadKeyFile(keyPath);
  const accountId = env.KEEPER_ACCOUNT_ID ?? key.account_id;
  if (!accountId) throw new Error("KEEPER_ACCOUNT_ID env var required (key file has no account_id)");

  const mkClient = deps.makeNearClient ?? (async (c, signer) => { const nc = new NearClient(c, signer); await nc.init(); return nc; });
  const client = await mkClient(cfg, { accountId, privateKey: key.private_key });
  const tick = deps.tickMulti ?? tickMulti;

  const logger = new TxLogger(env.KEEPER_LOG_FILE ?? "./data/keeper-tx-log.jsonl");
  const statePath = env.KEEPER_STATE_FILE ?? "./data/keeper-state.json";
  const intervalMs = Number(env.KEEPER_POLL_INTERVAL_MS ?? 15_000);
  const once = env.KEEPER_RUN_ONCE === "1";

  // LH3b: production archive adapters (OutLayer archive client signed by the
  // dedicated attest signer, D-ATTEST2; getRawTerms from the escrow view).
  // Enabled by default; inert (logged) until ARCHIVE_ATTEST_KEY_FILE is set.
  const archive = buildArchiveWiring(
    env, client, logger,
    deps.archiveFactories ?? realArchiveFactories(cfg, client, async (ac) => {
      const ak = loadKeyFile(ac.attestKeyFile!);
      const id = ac.attestAccountId ?? ak.account_id;
      if (!id) throw new Error("ARCHIVE_ATTEST_ACCOUNT_ID required (attest key file has no account_id)");
      const nc = await mkClient(cfg, { accountId: id, privateKey: ak.private_key });
      return nc.account;
    }),
  );

  // D-DSY1: contract_version() vs ESCROW_CONTRACTS label, at startup and on
  // every discovery refresh (tick). Alert only; never refuses to run.
  const versionRaiser = new ServiceAlertRaiser(new LogOnlyAlertChannel((m) => console.error(m)));

  // LH5: liveness alarm = log line + optional KEEPER_ALARM_WEBHOOK_URL webhook.
  const alarm = new ServiceAlertRaiser(buildAlarmChannel(env));
  // MON4: OUTLAYER_FAIL_THRESHOLD (default 3) consecutive failed request_resolution runs within OUTLAYER_FAIL_WINDOW_MS (default 30m).
  const sourceFeed = new SourceCheckFeed(new SourceCheckTracker(Number(env.SOURCE_FAIL_THRESHOLD ?? 3)), alarm);
  const outlayer = new OutlayerHealthTracker(Number(env.OUTLAYER_FAIL_THRESHOLD ?? 3), Number(env.OUTLAYER_FAIL_WINDOW_MS ?? 30 * 60_000) * 1_000_000);

  // MON4: heartbeat file for the monitor's service_heartbeat_missing alert (HEARTBEAT_DIR; unset = off).
  const hbDir = env.HEARTBEAT_DIR;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (hbDir) { try { writeHeartbeat(hbDir, "keeper", Date.now()); } catch (e) { console.error("heartbeat write failed", e); } }
    try {
      await runVersionCheck(client, cfg.escrowContracts, versionRaiser);
      // D-AUDIT5: unset (the scoped-key default) means tick() uses
      // credit mode (0 attached, drawn from keeper_credit); set this
      // only for a full-access-key / BYO-wallet keeper that should
      // attach NEAR directly instead.
      const attachEnv = env.KEEPER_ATTACH_NEAR_YOCTO;
      // D-UPGRADE1: tickMulti over cfg.escrowContracts handles both the
      // legacy single-ESCROW_CONTRACT_ID deployment (a one-entry list)
      // and a real multi-version ESCROW_CONTRACTS deployment the same
      // way, including emergency_refund on any contract that reports
      // itself shut down.
      await tick({
        client,
        contracts: cfg.escrowContracts,
        archive,
        alarm,
        outlayer,
        sourceFeed,
        logger,
        statePath,
        resolverSecretSeedHex: env.PRAETORIAL_RESOLVER_SECRET_SEED_HEX,
        decisionsPath: env.RESOLVER_DECISIONS_FILE,
        attachedNearYocto: attachEnv !== undefined ? BigInt(attachEnv) : undefined,
      });
    } catch (err) {
      console.error("keeper tick failed", err);
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

if (process.argv[1] && process.argv[1].endsWith("runner.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
