// G4: full lifecycle matrix on testnet, one bet per path, monitor run
// after every single state-changing tx (gate G7). Each path is an
// isolated function so a failure in one doesn't block the others; run
// with `node --import tsx e2e/g4_lifecycle_matrix.ts <path-name|all>`.
//
// Direct signed calls are used instead of the keeper loop for full
// control over sequencing (the keeper's own permissionless triggers are
// already covered by services/e2e/run.ts + policy.test.ts); this script
// still only ever calls methods that are permissionless on the contract
// (per README: "every permissioned-looking action here is actually
// permissionless on the contract side").
import fs from "node:fs";
import { NearClient } from "@praetorial/common/nearClient.js";
import { loadServiceConfig, loadKeyFile } from "@praetorial/common/config.js";
import { TxLogger } from "@praetorial/common/logger.js";
import nacl from "tweetnacl";
import { generateResolverKeypair, resolverKeypairFromSeedHex, signOutcome } from "@praetorial/common/resolverSign.js";
import { buildSourceCheckMessage } from "@praetorial/common/sourceCheck.js";
import { buildOpenMsg } from "@praetorial/common/openMsg.js";
import type { Envelope, Bet, SubmittedResult, PendingPayout } from "@praetorial/common/types.js";
import { envelopeDeposits } from "@praetorial/common/storageCharge.js";
import { checkAfterStep } from "../monitor/src/snapshot.js";
import type { LifecycleAction } from "../monitor/src/invariants.js";
import { discoverAllBets } from "@praetorial/common/discovery.js";

const CRED_DIR = process.env.NEAR_CREDENTIALS_DIR ?? `${process.env.HOME}/.near-credentials/testnet`;
function keyFor(accountId: string) {
  return loadKeyFile(`${CRED_DIR}/${accountId}.json`);
}

const cfg = loadServiceConfig();
const ESCROW = cfg.escrowContract;
const INTENTS = cfg.intentsContract;
const USDC = cfg.usdcTokenId;

const MAKER_ID = process.env.E2E_MAKER_ID ?? "maker1.praetorial-dev-1101.testnet";
const TAKER_ID = process.env.E2E_TAKER_ID ?? "taker1.praetorial-dev-1101.testnet";
const KEEPER_ID = process.env.E2E_KEEPER_ID ?? "keeper.praetorial-dev-1101.testnet";
const OPERATOR_ID = process.env.E2E_OPERATOR_ID ?? "praetorial-dev-1101.testnet";
const ARBITER_ID = process.env.E2E_ARBITER_ID ?? "arbiter1.praetorial-dev-1101.testnet";
const FEE_ACCOUNT_ID = process.env.E2E_FEE_ACCOUNT_ID ?? "fee.praetorial-dev-1101.testnet";

const RESULTS_PATH = "./data/g4-lifecycle-results.json";
const TXLOG_PATH = "./data/g4-tx-log.jsonl";
const ALL_BET_IDS_PATH = "./data/g4-all-bet-ids.json";

interface PathResult {
  path: string;
  betId: number | null;
  startedAt: string;
  finishedAt?: string;
  status: "pass" | "fail";
  steps: { action: string; tx_hash?: string; monitor_ok: boolean; violations: string[] }[];
  finalBetStatus?: string | null;
  error?: string;
}

// Contract-wide I-2 is checked as a delta from a one-time baseline
// balance (see snapshot.ts's checkAfterStep doc), scoped to ONLY the
// bets this matrix run itself creates -- the escrow contract also still
// holds several older bets from earlier sessions (services v0 E2E,
// g3_round_trip) that this script never touches and has no way to
// reconstruct the history of from view calls alone. Both the bet-id
// list and the baseline balance are persisted so separate CLI
// invocations (one per path) share them.
const BASELINE_PATH = "./data/g4-baseline-balance.json";
function loadAllBetIds(): number[] {
  if (!fs.existsSync(ALL_BET_IDS_PATH)) return [];
  return JSON.parse(fs.readFileSync(ALL_BET_IDS_PATH, "utf8"));
}
function saveAllBetIds(ids: number[]) {
  fs.mkdirSync("./data", { recursive: true });
  fs.writeFileSync(ALL_BET_IDS_PATH, JSON.stringify(ids));
}
function recordBetId(id: number) {
  const ids = loadAllBetIds();
  if (!ids.includes(id)) {
    ids.push(id);
    saveAllBetIds(ids);
  }
}
// BUG FIX (found live, 2026-11-02): this used to capture the baseline
// LAZILY on the first checkAfterStep() call, which by construction runs
// AFTER that step's own tx (e.g. "take") already landed -- so the very
// first bet's own funding was silently baked into the "baseline" instead
// of being money this run is supposed to track, permanently
// under-counting trackedTotal's expected delta by that amount. Baseline
// must be captured once, explicitly, before ANY bet in this run is
// opened. getOrCaptureBaseline() now only ever reads the persisted file;
// captureBaselineNow() is the one writer, called once at the top of
// main() before any path runs.
async function getOrCaptureBaseline(client: NearClient): Promise<bigint> {
  if (fs.existsSync(BASELINE_PATH)) {
    return BigInt(JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")));
  }
  return captureBaselineNow(client);
}
async function captureBaselineNow(client: NearClient): Promise<bigint> {
  const bal = await client.view<string>(INTENTS, "mt_balance_of", { account_id: ESCROW, token_id: USDC });
  fs.mkdirSync("./data", { recursive: true });
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(bal));
  console.log(`captured G4 baseline escrow USDC balance: ${bal}`);
  return BigInt(bal);
}
// kept for reference/debugging only -- not used in the I-2 check itself.
void discoverAllBets;

function loadResults(): PathResult[] {
  if (!fs.existsSync(RESULTS_PATH)) return [];
  return JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8"));
}
function saveResult(r: PathResult) {
  const all = loadResults().filter((x) => x.path !== r.path);
  all.push(r);
  fs.mkdirSync("./data", { recursive: true });
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(all, null, 2));
}

const logger = new TxLogger(TXLOG_PATH);

async function main() {
  const which = process.argv[2] ?? "all";

  const maker = new NearClient(cfg, { accountId: MAKER_ID, privateKey: keyFor(MAKER_ID).private_key });
  const taker = new NearClient(cfg, { accountId: TAKER_ID, privateKey: keyFor(TAKER_ID).private_key });
  const keeper = new NearClient(cfg, { accountId: KEEPER_ID, privateKey: keyFor(KEEPER_ID).private_key });
  const operator = new NearClient(cfg, { accountId: OPERATOR_ID, privateKey: keyFor(OPERATOR_ID).private_key });
  const arbiter = new NearClient(cfg, { accountId: ARBITER_ID, privateKey: keyFor(ARBITER_ID).private_key });
  await Promise.all([maker.init(), taker.init(), keeper.init(), operator.init(), arbiter.init()]);
  if (!fs.existsSync(BASELINE_PATH)) {
    await captureBaselineNow(maker);
  }

  // Lifetime bond/objection-deposit total ever sent per bet, tracked here
  // because `finalize` both clear `bet.bonds` /
  // `bet.objection_deposits` on-chain in the same tx that pays them out --
  // see extraFundsInYocto's doc in monitor/src/snapshot.ts. We know the
  // exact amount because we're the ones sending the transfer. Declared
  // before `paths`/the run loop below (not after) so it's initialized
  // before any path closure that captures it ever runs.
  const extraFundsInByBet = new Map<number, bigint>();
  function addExtraFundsIn(betId: number, amount: bigint) {
    extraFundsInByBet.set(betId, (extraFundsInByBet.get(betId) ?? 0n) + amount);
  }

  const paths: Record<string, () => Promise<PathResult>> = {
    yes: () => pathYesNo("yes", "YES"),
    no: () => pathYesNo("no", "NO"),
    void_deadline: pathVoidDeadline,
    cancel: pathCancel,
    expire: pathExpire,
    reclaim: pathReclaim,
    challenge_bond_lost: pathChallengeBondLost,
    challenge_bond_won: pathChallengeBondWon,
    objection_rejected: pathObjectionRejected,
    objection_upheld: pathObjectionUpheld,
    // BUG FIX (found live, 2026-11-02): these used to point at a stub
    // (pathArbiterPick) / be reassigned to the real implementation via
    // `paths.arbiter_pick = pathArbiterPickImpl` AFTER the run loop
    // below -- a statement that only executes once the whole loop
    // finishes, so `which === "arbiter_pick"` always ran the half-built
    // stub, never the real path. Function declarations are hoisted, so
    // referencing the *Impl names directly here (defined further down
    // the file) works correctly at call time.
    arbiter_pick: pathArbiterPickImpl,
    mutual_settle_removed: pathMutualSettleRemoved,
    amend_then_resolve: pathAmendThenResolve,
    prune: pathPrune,
    pause_during_open_bet: pathPauseDuringOpenBet,
    failed_payout_retry: pathFailedPayoutRetry,
  };

  const order = which === "all" ? Object.keys(paths) : [which];
  for (const name of order) {
    const fn = paths[name];
    if (!fn) {
      console.error(`unknown path: ${name}`);
      continue;
    }
    console.log(`\n=== PATH: ${name} ===`);
    try {
      const result = await fn();
      saveResult(result);
      console.log(`=== ${name}: ${result.status.toUpperCase()} (betId=${result.betId}, finalStatus=${result.finalBetStatus}) ===`);
    } catch (err: any) {
      const result: PathResult = {
        path: name,
        betId: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: "fail",
        steps: [],
        error: String(err?.message ?? err),
      };
      saveResult(result);
      console.error(`=== ${name}: FAIL (${result.error}) ===`);
    }
  }

  // helper closures need access to outer scope vars; declared below as
  // nested functions so TS lets them share maker/taker/keeper/etc.
  async function step(
    r: PathResult,
    action: LifecycleAction,
    betId: number,
    txPromise: Promise<any>,
    opts: { expectBlocked?: boolean } = {},
  ): Promise<any> {
    let txHash: string | undefined;
    let blocked = false;
    let txResult: any;
    try {
      txResult = await txPromise;
      txHash = txResult?.transaction?.hash;
    } catch (err: any) {
      blocked = true;
      if (!opts.expectBlocked) throw err;
    }
    // schedule_payout's cross-contract mt_transfer (and its
    // on_payout_result callback flipping done=true) is async relative to
    // the tx we just awaited landing; an immediate view can race ahead
    // of that callback and see a payout row still `done:false` with the
    // intents balance already moved (or vice versa). A short settle
    // delay avoids false I-2/I-4 positives from pure async timing.
    await new Promise((res) => setTimeout(res, 3000));
    const allIds = loadAllBetIds();
    const baseline = await getOrCaptureBaseline(maker);
    const mon = await checkAfterStep({
      client: maker, // view-only reads; any initialized client works for views
      escrowContract: ESCROW,
      intentsContract: INTENTS,
      usdcTokenId: USDC,
      betId,
      allBetIdsForContractWide: allIds,
      accounts: { feeAccount: FEE_ACCOUNT_ID, keeper: KEEPER_ID },
      action,
      actionWasBlocked: blocked,
      baselineBalanceYocto: baseline,
      extraFundsInYocto: extraFundsInByBet.get(betId) ?? 0n,
    });
    r.steps.push({
      action,
      tx_hash: txHash,
      monitor_ok: mon.ok,
      violations: mon.violations.map((v) => `${v.invariant}: ${v.detail}`),
    });
    logger.log({ service: "g4", action, bet_id: betId, status: mon.ok ? "ok" : "VIOLATION", tx_hash: txHash });
    if (!mon.ok) {
      console.error(`  MONITOR VIOLATION after ${action} on bet ${betId}:`, mon.violations);
    } else {
      console.log(`  [monitor ok] after ${action} (bet ${betId}, status=${mon.raw.betStatus})`);
    }
    return txResult;
  }

  async function openBet(
    label: string,
    envOverrides: Partial<Envelope>,
    stakeMaker = 1_000_000n,
    stakeTaker = 1_000_000n,
  ): Promise<{ betId: number; resolverKeypair: ReturnType<typeof generateResolverKeypair>; resolverSeedHex: string }> {
    // D-ECON5: no per-bet reserve any more -- stake + storage only.
  // E2S1: envelope storage_charge_per_side is "0"; each side deposits stake + the contract per-side charge from the asset_limit view.
    const { maker: makerRequired, taker: takerRequired } = await envelopeDeposits(
      (a) => maker.view(ESCROW, "asset_limit", { asset_id: a }),
      {
        terms: envOverrides.terms ?? `G4 lifecycle matrix path: ${label}`,
        terms_hash: envOverrides.terms_hash ?? "e".repeat(64),
        models_snapshot_hash: envOverrides.models_snapshot_hash ?? "g4-lifecycle-matrix",
        stake_maker: stakeMaker.toString(), stake_taker: stakeTaker.toString(),
        maker_asset: envOverrides.maker_asset ?? USDC, taker_asset: envOverrides.taker_asset ?? USDC,
      });

    await keeper.call(INTENTS, "mint", { account_id: MAKER_ID, token_id: USDC, amount: (makerRequired + 20_000_000n).toString() }, 30);
    await keeper.call(INTENTS, "mint", { account_id: TAKER_ID, token_id: USDC, amount: (takerRequired + 20_000_000n).toString() }, 30);

    const resolverKeypair = generateResolverKeypair();
    const resolverSeedHex = Buffer.from(resolverKeypair.secretKey.slice(0, 32)).toString("hex");

    const nowNs = Date.now() * 1_000_000;
    const envelope: Envelope = {
      bet_id: 0,
      version: 1,
      maker: MAKER_ID,
      taker_allow: { Any: {} },
      terms_hash: "e".repeat(64),
      models_snapshot_hash: "g4-lifecycle-matrix",
      outcomes: ["YES", "NO"],
      maker_side: "YES",
      stake_maker: stakeMaker.toString(),
      stake_taker: stakeTaker.toString(),
      fee_bps: 100,
      storage_charge_per_side: "0",
      keep_terms: true,
      terms: `G4 lifecycle matrix path: ${label}`,
      max_paid_runs: 3,
      tier: 1,
      maker_asset: USDC,
      taker_asset: USDC,
      funding_deadline: nowNs + 60 * 1_000_000_000,
      early_settle_outcome: null,
      finality_delay: 0,
      settlement_period: 15 * 1_000_000_000,
      resolve_deadline: nowNs + 3600 * 1_000_000_000,
      consent_party_controlled: false,
      ...envOverrides,
    };

    // D-KEY1/D-FETCH2 (7g2): handle_open requires a fresh resolver-signed
    // sources-reachable attestation, verified against the contract's
    // pinned attest_pubkey (resolver_keys() view) -- never an envelope
    // field.
    const checkedAtNs = Date.now() * 1_000_000;
    const scMessage = Buffer.from(buildSourceCheckMessage(envelope.terms_hash, String(checkedAtNs)), "utf8");
    const scSig = nacl.sign.detached(scMessage, resolverKeypair.secretKey);
    const attestation = { checked_at: checkedAtNs, signature_hex: Buffer.from(scSig).toString("hex") };

    const openResult: any = await maker.call(
      INTENTS,
      "transfer_with_msg",
      { receiver_id: ESCROW, token_id: USDC, amount: makerRequired.toString(), msg: buildOpenMsg(envelope as any, attestation) },
      80,
    );
    // RACE (found in pause_during_open_bet, loop 5): a single immediate
    // view right after the `transfer_with_msg` await returned could still
    // miss the just-created offer -- the await resolves once our own tx
    // is final, but the view call can land on an RPC node whose indexed
    // state lags that by a block or two under load (eventual consistency
    // across nodes, not a correctness bug in the contract). Poll briefly
    // instead of a single read so we wait for the offer to actually be
    // visible before giving up.
    let created: Bet | undefined;
    for (let attempt = 0; attempt < 20 && !created; attempt++) {
      if (attempt > 0) await new Promise((res) => setTimeout(res, 1000));
      const offers: Bet[] = await maker.view(ESCROW, "open_offers", { from: 0, limit: 200 });
      created = offers.filter((b) => b.envelope.maker === MAKER_ID && b.taker === null).pop();
    }
    if (!created) throw new Error(`[${label}] could not find the just-created open offer`);
    const betId = created.envelope.bet_id;
    recordBetId(betId);
    return { betId, resolverKeypair, resolverSeedHex };
  }

  async function takeBet(betId: number, stakeTaker = 1_000_000n): Promise<any> {
    // D-ECON5: no per-bet reserve any more -- stake + storage only.
  // E2S1: envelope storage_charge_per_side is "0"; each side deposits stake + the contract per-side charge from the asset_limit view.
    const liveBet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    if (!liveBet) throw new Error(`takeBet: bet ${betId} not found`);
    const takerRequired = (await envelopeDeposits(
      (a) => maker.view(ESCROW, "asset_limit", { asset_id: a }),
      { ...liveBet.envelope, stake_taker: stakeTaker.toString() })).taker;
    return taker.call(
      INTENTS,
      "transfer_with_msg",
      { receiver_id: ESCROW, token_id: USDC, amount: takerRequired.toString(), msg: JSON.stringify({ kind: "Take", bet_id: betId, invite_sig: null }) },
      80,
    );
  }

  async function submitOutcome(betId: number, outcome: "YES" | "NO" | "VOID", resolverKeypair: ReturnType<typeof generateResolverKeypair>, runNo: number) {
    const bet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    const result: SubmittedResult = {
      bet_id: betId,
      terms_hash: bet!.envelope.terms_hash,
      outcome,
      element_results_hash: "0".repeat(64),
      run_no: runNo,
      // String, not a JS number (see types.ts doc): this ns timestamp
      // exceeds Number.MAX_SAFE_INTEGER, which is the root cause this
      // harness used to hit as intermittent "bad signature" rejections.
      checked_until: (BigInt(Date.now()) * 1_000_000n).toString(),
      judge_pair_index: 0, // JC1s
    };
    const sig = signOutcome(ESCROW, result, resolverKeypair.secretKey);
    return keeper.call(ESCROW, "submit_outcome", { result, signature_hex: sig }, 60);
  }

  // OQ-T11: finalize now only persist the payout ledger
  // (status Finalized) -- drain_payouts is the ONLY thing that actually
  // fires transfers and promotes Finalized -> Settled, once the ledger
  // is fully drained (MAX_DRAIN_BATCH=10 per call, so a bet with more
  // payout lines than that needs more than one call). Every path below
  // that used to assert `status === "Settled"` right after finalize or
  // the committing call must drive this loop first.
  async function drainUntilSettled(r: PathResult, betId: number, maxCalls = 10): Promise<void> {
    for (let i = 0; i < maxCalls; i++) {
      const fullyPaid = await maker.view<boolean>(ESCROW, "is_fully_paid", { bet_id: betId });
      if (fullyPaid) return;
      await step(r, "drain_payouts" as LifecycleAction, betId, keeper.call(ESCROW, "drain_payouts", { bet_id: betId, limit: 20 }, 300));
    }
  }

  async function waitUntilNs(targetNs: number, label: string) {
    const waitMs = Math.max(0, targetNs / 1_000_000 - Date.now()) + 2000;
    console.log(`  [${label}] waiting ${Math.round(waitMs / 1000)}s...`);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  async function pathYesNo(label: string, outcome: "YES" | "NO"): Promise<PathResult> {
    const r: PathResult = { path: label, betId: null, startedAt: new Date().toISOString(), status: "fail", steps: [] };
    const { betId, resolverKeypair } = await openBet(label, {});
    r.betId = betId;
    await step(r, "take" as LifecycleAction, betId, takeBet(betId));
    const bet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitUntilNs(bet!.envelope.funding_deadline, label);
    await step(r, "request_resolution", betId, keeper.callPayable(ESCROW, "request_resolution", { bet_id: betId, terms: null }, BigInt("10000000000000000000000"), 300));
    await step(r, "submit_outcome", betId, submitOutcome(betId, outcome, resolverKeypair, 1));
    const bet2: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitUntilNs(bet2!.proposed_at! + bet2!.envelope.settlement_period, label);
    await step(r, "finalize", betId, keeper.call(ESCROW, "finalize", { bet_id: betId }, 300));
    await drainUntilSettled(r, betId);
    const finalBet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    r.finalBetStatus = finalBet?.status ?? null;
    r.finishedAt = new Date().toISOString();
    r.status = finalBet?.status === "Settled" && r.steps.every((s) => s.monitor_ok) ? "pass" : "fail";
    return r;
  }

  async function pathVoidDeadline(): Promise<PathResult> {
    const label = "void_deadline";
    const r: PathResult = { path: label, betId: null, startedAt: new Date().toISOString(), status: "fail", steps: [] };
    const nowNs = Date.now() * 1_000_000;
    const { betId } = await openBet(label, {
      funding_deadline: nowNs + 25 * 1_000_000_000,
      resolve_deadline: nowNs + 45 * 1_000_000_000, // short: expires before anyone resolves
    });
    r.betId = betId;
    await step(r, "take" as LifecycleAction, betId, takeBet(betId));
    const bet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitUntilNs(bet!.envelope.resolve_deadline, label);
    await step(r, "void_after_deadline", betId, keeper.call(ESCROW, "void_after_deadline", { bet_id: betId }, 300));
    const finalBet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    r.finalBetStatus = finalBet?.status ?? null;
    r.finishedAt = new Date().toISOString();
    r.status = finalBet?.status === "Voided" && r.steps.every((s) => s.monitor_ok) ? "pass" : "fail";
    return r;
  }

  async function pathCancel(): Promise<PathResult> {
    const label = "cancel";
    const r: PathResult = { path: label, betId: null, startedAt: new Date().toISOString(), status: "fail", steps: [] };
    const { betId } = await openBet(label, {});
    r.betId = betId;
    await step(r, "cancel", betId, maker.call(ESCROW, "cancel", { bet_id: betId }, 60));
    const finalBet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    r.finalBetStatus = finalBet?.status ?? null;
    r.finishedAt = new Date().toISOString();
    r.status = finalBet?.status === "Cancelled" && r.steps.every((s) => s.monitor_ok) ? "pass" : "fail";
    return r;
  }

  async function pathExpire(): Promise<PathResult> {
    const label = "expire";
    const r: PathResult = { path: label, betId: null, startedAt: new Date().toISOString(), status: "fail", steps: [] };
    const nowNs = Date.now() * 1_000_000;
    const { betId } = await openBet(label, { funding_deadline: nowNs + 20 * 1_000_000_000 });
    r.betId = betId;
    const bet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitUntilNs(bet!.envelope.funding_deadline, label);
    await step(r, "expire", betId, keeper.call(ESCROW, "expire", { bet_id: betId }, 60));
    const finalBet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    r.finalBetStatus = finalBet?.status ?? null;
    r.finishedAt = new Date().toISOString();
    r.status = finalBet?.status === "Expired" && r.steps.every((s) => s.monitor_ok) ? "pass" : "fail";
    return r;
  }

  async function pathReclaim(): Promise<PathResult> {
    const label = "reclaim";
    const r: PathResult = { path: label, betId: null, startedAt: new Date().toISOString(), status: "fail", steps: [] };
    const { betId } = await openBet(label, {});
    r.betId = betId;
    await step(r, "reclaim", betId, operator.call(ESCROW, "reclaim", { bet_id: betId }, 60));
    const finalBet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    r.finalBetStatus = finalBet?.status ?? null;
    r.finishedAt = new Date().toISOString();
    r.status = finalBet?.status === "Cancelled" && r.steps.every((s) => s.monitor_ok) ? "pass" : "fail";
    return r;
  }

  async function sendBond(who: NearClient, betId: number, round: number, amount = 5_000_000n) {
    addExtraFundsIn(betId, amount);
    return who.call(INTENTS, "transfer_with_msg", { receiver_id: ESCROW, token_id: USDC, amount: amount.toString(), msg: JSON.stringify({ kind: "Bond", bet_id: betId, round }) }, 80);
  }
  async function sendObjection(who: NearClient, betId: number, hash: string, isRebuttal: boolean, amount = 1_000_000n) {
    addExtraFundsIn(betId, amount);
    return who.call(INTENTS, "transfer_with_msg", { receiver_id: ESCROW, token_id: USDC, amount: amount.toString(), msg: JSON.stringify({ kind: "Objection", bet_id: betId, exhibit_hash: hash, is_rebuttal: isRebuttal }) }, 80);
  }

  async function toProposed(label: string, outcome: "YES" | "NO"): Promise<{ betId: number; resolverKeypair: ReturnType<typeof generateResolverKeypair> }> {
    const { betId, resolverKeypair } = await openBet(label, {});
    await takeBet(betId);
    const bet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitUntilNs(bet!.envelope.funding_deadline, label);
    await keeper.callPayable(ESCROW, "request_resolution", { bet_id: betId, terms: null }, BigInt("10000000000000000000000"), 300);
    await submitOutcome(betId, outcome, resolverKeypair, 1);
    return { betId, resolverKeypair };
  }

  async function pathChallengeBondLost(): Promise<PathResult> {
    const label = "challenge_bond_lost";
    const r: PathResult = { path: label, betId: null, startedAt: new Date().toISOString(), status: "fail", steps: [] };
    const { betId, resolverKeypair } = await toProposed(label, "YES"); // maker_side=YES wins round 0
    r.betId = betId;
    // taker (loser) challenges, round 1.
    await step(r, "challenge", betId, sendBond(taker, betId, 1));
    await step(r, "request_resolution", betId, keeper.callPayable(ESCROW, "request_resolution", { bet_id: betId, terms: null }, BigInt("10000000000000000000000"), 300));
    // Resolver re-judges the SAME outcome (YES again) -> bond lost.
    await step(r, "submit_outcome", betId, submitOutcome(betId, "YES", resolverKeypair, 2));
    const bet2: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitUntilNs(bet2!.proposed_at! + bet2!.envelope.settlement_period, label);
    await step(r, "finalize", betId, keeper.call(ESCROW, "finalize", { bet_id: betId }, 300));
    await drainUntilSettled(r, betId);
    const finalBet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    const payouts: PendingPayout[] = await maker.view(ESCROW, "pending_payouts_view", { from: 0, limit: 500 });
    const bondLost = payouts.some((p) => p.bet_id === betId && p.reason === "bond_lost_to_counterparty");
    r.finalBetStatus = finalBet?.status ?? null;
    r.finishedAt = new Date().toISOString();
    r.status = finalBet?.status === "Settled" && bondLost && r.steps.every((s) => s.monitor_ok) ? "pass" : "fail";
    return r;
  }

  async function pathChallengeBondWon(): Promise<PathResult> {
    const label = "challenge_bond_won";
    const r: PathResult = { path: label, betId: null, startedAt: new Date().toISOString(), status: "fail", steps: [] };
    const { betId, resolverKeypair } = await toProposed(label, "YES");
    r.betId = betId;
    await step(r, "challenge", betId, sendBond(taker, betId, 1));
    await step(r, "request_resolution", betId, keeper.callPayable(ESCROW, "request_resolution", { bet_id: betId, terms: null }, BigInt("10000000000000000000000"), 300));
    // Resolver flips to NO this round -> challenger (taker) won.
    await step(r, "submit_outcome", betId, submitOutcome(betId, "NO", resolverKeypair, 2));
    const bet2: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitUntilNs(bet2!.proposed_at! + bet2!.envelope.settlement_period, label);
    await step(r, "finalize", betId, keeper.call(ESCROW, "finalize", { bet_id: betId }, 300));
    await drainUntilSettled(r, betId);
    const finalBet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    const payouts: PendingPayout[] = await maker.view(ESCROW, "pending_payouts_view", { from: 0, limit: 500 });
    const bondWon = payouts.some((p) => p.bet_id === betId && p.reason === "bond_returned_won");
    r.finalBetStatus = finalBet?.status ?? null;
    r.finishedAt = new Date().toISOString();
    r.status = finalBet?.status === "Settled" && bondWon && r.steps.every((s) => s.monitor_ok) ? "pass" : "fail";
    return r;
  }

  async function pathObjectionRejected(): Promise<PathResult> {
    const label = "objection_rejected";
    const r: PathResult = { path: label, betId: null, startedAt: new Date().toISOString(), status: "fail", steps: [] };
    const { betId, resolverKeypair } = await toProposed(label, "YES");
    r.betId = betId;
    await step(r, "challenge", betId, sendBond(taker, betId, 1));
    await step(r, "object", betId, sendObjection(taker, betId, "a".repeat(40), false));
    await step(r, "request_resolution", betId, keeper.callPayable(ESCROW, "request_resolution", { bet_id: betId, terms: null }, BigInt("10000000000000000000000"), 300));
    // Outcome stays YES (same as when objection was filed) -> rejected, forfeited.
    await step(r, "submit_outcome", betId, submitOutcome(betId, "YES", resolverKeypair, 2));
    const bet2: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitUntilNs(bet2!.proposed_at! + bet2!.envelope.settlement_period, label);
    await step(r, "finalize", betId, keeper.call(ESCROW, "finalize", { bet_id: betId }, 300));
    await drainUntilSettled(r, betId);
    const finalBet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    const payouts: PendingPayout[] = await maker.view(ESCROW, "pending_payouts_view", { from: 0, limit: 500 });
    const rejected = payouts.some((p) => p.bet_id === betId && p.reason === "objection_deposit_forfeited");
    r.finalBetStatus = finalBet?.status ?? null;
    r.finishedAt = new Date().toISOString();
    r.status = finalBet?.status === "Settled" && rejected && r.steps.every((s) => s.monitor_ok) ? "pass" : "fail";
    return r;
  }

  async function pathObjectionUpheld(): Promise<PathResult> {
    const label = "objection_upheld";
    const r: PathResult = { path: label, betId: null, startedAt: new Date().toISOString(), status: "fail", steps: [] };
    const { betId, resolverKeypair } = await toProposed(label, "YES");
    r.betId = betId;
    await step(r, "challenge", betId, sendBond(taker, betId, 1));
    await step(r, "object", betId, sendObjection(taker, betId, "b".repeat(40), false));
    await step(r, "request_resolution", betId, keeper.callPayable(ESCROW, "request_resolution", { bet_id: betId, terms: null }, BigInt("10000000000000000000000"), 300));
    // Outcome flips to NO (different from when objection was filed) -> upheld, returned.
    await step(r, "submit_outcome", betId, submitOutcome(betId, "NO", resolverKeypair, 2));
    const bet2: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitUntilNs(bet2!.proposed_at! + bet2!.envelope.settlement_period, label);
    await step(r, "finalize", betId, keeper.call(ESCROW, "finalize", { bet_id: betId }, 300));
    await drainUntilSettled(r, betId);
    const finalBet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    const payouts: PendingPayout[] = await maker.view(ESCROW, "pending_payouts_view", { from: 0, limit: 500 });
    const upheld = payouts.some((p) => p.bet_id === betId && p.reason === "objection_deposit_returned");
    r.finalBetStatus = finalBet?.status ?? null;
    r.finishedAt = new Date().toISOString();
    r.status = finalBet?.status === "Settled" && upheld && r.steps.every((s) => s.monitor_ok) ? "pass" : "fail";
    return r;
  }

  async function pathArbiterPick(): Promise<PathResult> {
    const label = "arbiter_pick";
    const r: PathResult = { path: label, betId: null, startedAt: new Date().toISOString(), status: "fail", steps: [] };
    // D-REF1: arbiter_pick no longer pays an arbiter_fee -- the field
    // is gone from Envelope. The arbiter's ruling power is unchanged.
    const { betId } = await openBet(label, { arbiter: ARBITER_ID });
    r.betId = betId;
    await step(r, "take" as LifecycleAction, betId, takeBet(betId));
    // Challenge to reach Challenged status (arbiter_submit requires it).
    const bet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitUntilNs(bet!.envelope.funding_deadline, label);
    // Give the bet a standing outcome first so a bond is valid (requires Proposed|Evidence).
    // Simpler: drive straight to a bond via Evidence is not reachable without Proposed first,
    // so resolve once, then challenge into dispute, then let the arbiter decide instead of a re-judge.
    const resolverKeypair = generateResolverKeypair();
    // NOTE (7g2): the escrow contract's outcome_pubkey/attest_pubkey are
    // now pinned once at new() for the WHOLE contract (D-KEY1) -- a
    // per-bet envelope resolver key no longer exists, so this scenario's
    // own outcome signing must use whatever keypair the harness/deploy
    // pinned as outcome_pubkey, not a throwaway generated here.
    const freshBet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    const pinnedPubkeyKeypair = resolverKeypair; // placeholder, unused below
    void pinnedPubkeyKeypair;
    await step(r, "request_resolution", betId, keeper.callPayable(ESCROW, "request_resolution", { bet_id: betId, terms: null }, BigInt("10000000000000000000000"), 300));
    return r; // see note below: this path needs the bet's own resolver keypair, continued in pathArbiterPickImpl
  }

  // arbiter_pick needs the resolver keypair generated at open time, which
  // the simplified stub above doesn't retain -- implemented properly here.
  async function pathArbiterPickImpl(): Promise<PathResult> {
    const label = "arbiter_pick";
    const r: PathResult = { path: label, betId: null, startedAt: new Date().toISOString(), status: "fail", steps: [] };
    // D-REF1: arbiter_pick no longer pays an arbiter_fee -- the field
    // is gone from Envelope. The arbiter's ruling power is unchanged.
    const { betId, resolverKeypair } = await openBet(label, { arbiter: ARBITER_ID });
    r.betId = betId;
    await step(r, "take" as LifecycleAction, betId, takeBet(betId));
    const bet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitUntilNs(bet!.envelope.funding_deadline, label);
    await step(r, "request_resolution", betId, keeper.callPayable(ESCROW, "request_resolution", { bet_id: betId, terms: null }, BigInt("10000000000000000000000"), 300));
    await step(r, "submit_outcome", betId, submitOutcome(betId, "YES", resolverKeypair, 1));
    // Taker disagrees -> challenge -> Challenged -> both submit to arbiter.
    await step(r, "challenge", betId, sendBond(taker, betId, 1));
    await step(r, "arbiter_submit_maker", betId, maker.call(ESCROW, "arbiter_submit", { bet_id: betId, outcome: "YES", note_hash: "m".repeat(20) }, 60));
    await step(r, "arbiter_submit_taker", betId, taker.call(ESCROW, "arbiter_submit", { bet_id: betId, outcome: "NO", note_hash: "t".repeat(20) }, 60));
    const submissionHash = "NO:" + "t".repeat(20);
    await step(r, "arbiter_pick", betId, arbiter.call(ESCROW, "arbiter_pick", { bet_id: betId, submission_hash: submissionHash }, 60));
    const bet2: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitUntilNs(bet2!.proposed_at! + bet2!.envelope.settlement_period, label);
    await step(r, "finalize", betId, keeper.call(ESCROW, "finalize", { bet_id: betId }, 300));
    await drainUntilSettled(r, betId);
    const finalBet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    r.finalBetStatus = finalBet?.status ?? null;
    r.finishedAt = new Date().toISOString();
    r.status = finalBet?.status === "Settled" && finalBet?.outcome === "NO" && r.steps.every((s) => s.monitor_ok) ? "pass" : "fail";
    return r;
  }
  // 17e: D-SETTLE3 removed mutual_settle. Mid-dispute, the old door must be
  // shut: a call fails as an unknown method and the bet stays disputed.
  async function pathMutualSettleRemoved(): Promise<PathResult> {
    const label = "mutual_settle_removed";
    const r: PathResult = { path: label, betId: null, startedAt: new Date().toISOString(), status: "fail", steps: [] };
    const { betId } = await toProposed(label, "YES");
    r.betId = betId;
    await step(r, "challenge", betId, sendBond(taker, betId, 1));
    let rejected = false;
    try {
      await maker.call(ESCROW, "mutual_settle", { bet_id: betId, split_maker_bps: 5000 }, 60);
    } catch {
      rejected = true;
    }
    const finalBet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    r.finalBetStatus = finalBet?.status ?? null;
    r.finishedAt = new Date().toISOString();
    r.status = rejected && finalBet?.status !== "Settled" && finalBet?.status !== "Finalized" && r.steps.every((s) => s.monitor_ok) ? "pass" : "fail";
    return r;
  }

  async function pathAmendThenResolve(): Promise<PathResult> {
    const label = "amend_then_resolve";
    const r: PathResult = { path: label, betId: null, startedAt: new Date().toISOString(), status: "fail", steps: [] };
    const nowNs = Date.now() * 1_000_000;
    const { betId, resolverKeypair } = await openBet(label, { funding_deadline: nowNs + 50 * 1_000_000_000 });
    r.betId = betId;
    await step(r, "take" as LifecycleAction, betId, takeBet(betId));
    const newHash = "c".repeat(64);
    await step(r, "amend", betId, maker.call(ESCROW, "amend", { bet_id: betId, new_terms_hash: newHash }, 60));
    await step(r, "amend", betId, taker.call(ESCROW, "amend", { bet_id: betId, new_terms_hash: newHash }, 60));
    const afterAmend: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitUntilNs(afterAmend!.envelope.funding_deadline, label);
    await step(r, "request_resolution", betId, keeper.callPayable(ESCROW, "request_resolution", { bet_id: betId, terms: null }, BigInt("10000000000000000000000"), 300));
    await step(r, "submit_outcome", betId, submitOutcome(betId, "YES", resolverKeypair, 1));
    const bet2: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitUntilNs(bet2!.proposed_at! + bet2!.envelope.settlement_period, label);
    await step(r, "finalize", betId, keeper.call(ESCROW, "finalize", { bet_id: betId }, 300));
    await drainUntilSettled(r, betId);
    const finalBet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    r.finalBetStatus = finalBet?.status ?? null;
    r.finishedAt = new Date().toISOString();
    r.status = finalBet?.status === "Settled" && finalBet?.envelope.terms_hash === newHash && r.steps.every((s) => s.monitor_ok) ? "pass" : "fail";
    return r;
  }

  async function pathPrune(): Promise<PathResult> {
    const label = "prune";
    const r: PathResult = { path: label, betId: null, startedAt: new Date().toISOString(), status: "fail", steps: [] };
    const settledResult = await pathYesNo("prune_setup", "YES");
    const betId = settledResult.betId!;
    r.betId = betId;
    await step(r, "prune_terms_maker", betId, maker.call(ESCROW, "prune_terms", { bet_id: betId }, 60));
    await step(r, "prune_terms_taker", betId, taker.call(ESCROW, "prune_terms", { bet_id: betId }, 60));
    const finalBet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    r.finalBetStatus = finalBet?.status ?? null;
    r.finishedAt = new Date().toISOString();
    r.status = finalBet?.pruned === true && r.steps.every((s) => s.monitor_ok) ? "pass" : "fail";
    return r;
  }
  async function pathPauseDuringOpenBet(): Promise<PathResult> {
    const label = "pause_during_open_bet";
    const r: PathResult = { path: label, betId: null, startedAt: new Date().toISOString(), status: "fail", steps: [] };
    // Open+take BEFORE pausing, so this bet is already live when paused=true.
    const { betId, resolverKeypair } = await openBet(label, {});
    await takeBet(betId);
    r.betId = betId;
    await step(r, "pause", betId, operator.call(ESCROW, "pause", {}, 30));
    // A fresh open while paused must be blocked (I-5).
    const nowNs = Date.now() * 1_000_000;
    await keeper.call(INTENTS, "mint", { account_id: MAKER_ID, token_id: USDC, amount: "2000000" }, 30);
    const blockedEnvelope: Envelope = {
      bet_id: 0, version: 1, maker: MAKER_ID, taker_allow: { Any: {} }, terms_hash: "d".repeat(64),
      models_snapshot_hash: "g4", outcomes: ["YES", "NO"], maker_side: "YES",
      stake_maker: "1000000", stake_taker: "1000000", fee_bps: 100,
      storage_charge_per_side: "0", keep_terms: true, terms: "should be blocked by pause", max_paid_runs: 1, tier: 1, maker_asset: USDC, taker_asset: USDC,
      funding_deadline: nowNs + 60 * 1_000_000_000, early_settle_outcome: null, finality_delay: 0,
      settlement_period: 15 * 1_000_000_000, resolve_deadline: nowNs + 3600 * 1_000_000_000,
      consent_party_controlled: false,
    };
    const beforeOpenCount = (await maker.view<Bet[]>(ESCROW, "open_offers", { from: 0, limit: 500 })).length;
    // E2S1: required = stake(1_000_000) + per-side storage charge from the asset_limit view.
    const blockedRequired = (await envelopeDeposits((a) => maker.view(ESCROW, "asset_limit", { asset_id: a }), blockedEnvelope)).maker;
    await maker.call(INTENTS, "transfer_with_msg", { receiver_id: ESCROW, token_id: USDC, amount: blockedRequired.toString(), msg: JSON.stringify({ kind: "Open", envelope: blockedEnvelope }) }, 80);
    const afterOpenCount = (await maker.view<Bet[]>(ESCROW, "open_offers", { from: 0, limit: 500 })).length;
    const openWasBlocked = afterOpenCount === beforeOpenCount; // rejected -> refunded, no new offer
    const allIds = loadAllBetIds();
    const baselineForOpen = await getOrCaptureBaseline(maker);
    const monOpen = await checkAfterStep({ client: maker, escrowContract: ESCROW, intentsContract: INTENTS, usdcTokenId: USDC, betId, allBetIdsForContractWide: allIds, accounts: { feeAccount: FEE_ACCOUNT_ID, keeper: KEEPER_ID }, action: "open", actionWasBlocked: openWasBlocked, baselineBalanceYocto: baselineForOpen });
    r.steps.push({ action: "open_while_paused", monitor_ok: monOpen.ok, violations: monOpen.violations.map((v) => `${v.invariant}: ${v.detail}`) });
    // The already-Taken bet's resolve/finalize must still work while paused.
    const bet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitUntilNs(bet!.envelope.funding_deadline, label);
    await step(r, "request_resolution", betId, keeper.callPayable(ESCROW, "request_resolution", { bet_id: betId, terms: null }, BigInt("10000000000000000000000"), 300));
    await step(r, "submit_outcome", betId, submitOutcome(betId, "YES", resolverKeypair, 1));
    const bet2: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitUntilNs(bet2!.proposed_at! + bet2!.envelope.settlement_period, label);
    await step(r, "finalize", betId, keeper.call(ESCROW, "finalize", { bet_id: betId }, 300));
    await drainUntilSettled(r, betId);
    await step(r, "unpause", betId, operator.call(ESCROW, "unpause", {}, 30));
    const finalBet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    r.finalBetStatus = finalBet?.status ?? null;
    r.finishedAt = new Date().toISOString();
    r.status = finalBet?.status === "Settled" && openWasBlocked && r.steps.every((s) => s.monitor_ok) ? "pass" : "fail";
    return r;
  }

  async function pathFailedPayoutRetry(): Promise<PathResult> {
    const label = "failed_payout_retry";
    const r: PathResult = { path: label, betId: null, startedAt: new Date().toISOString(), status: "fail", steps: [] };
    const { betId, resolverKeypair } = await openBet(label, {});
    r.betId = betId;
    await step(r, "take" as LifecycleAction, betId, takeBet(betId));
    const bet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitUntilNs(bet!.envelope.funding_deadline, label);
    await step(r, "request_resolution", betId, keeper.callPayable(ESCROW, "request_resolution", { bet_id: betId, terms: null }, BigInt("10000000000000000000000"), 300));
    await step(r, "submit_outcome", betId, submitOutcome(betId, "YES", resolverKeypair, 1));
    const bet2: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitUntilNs(bet2!.proposed_at! + bet2!.envelope.settlement_period, label);
    // Force every mt_transfer to fail before finalize schedules payouts.
    await operator.call(INTENTS, "set_fail_mt_transfer", { fail: true }, 30);
    // OQ-T11: finalize now only persists the ledger (status Finalized);
    // the first drain is what actually attempts the (forced-failing)
    // transfers.
    await step(r, "finalize", betId, keeper.call(ESCROW, "finalize", { bet_id: betId }, 300));
    await step(r, "drain_payouts", betId, keeper.call(ESCROW, "drain_payouts", { bet_id: betId, limit: 20 }, 300));
    const payoutsAfterFail: PendingPayout[] = await maker.view(ESCROW, "pending_payouts_view", { from: 0, limit: 500 });
    const stillPending = payoutsAfterFail.filter((p) => p.bet_id === betId && !p.done);
    if (stillPending.length === 0) throw new Error("expected at least one payout row to fail and stay pending");
    await operator.call(INTENTS, "set_fail_mt_transfer", { fail: false }, 30);
    // drain_payouts merges retry semantics -- the SAME call picks the
    // still-pending (and now not-in_flight) lines back up, no separate
    // retry_payout action needed.
    while (true) {
      const stillOpen: PendingPayout[] = await maker.view(ESCROW, "pending_payouts_view", { from: 0, limit: 500 });
      if (stillOpen.filter((p) => p.bet_id === betId && !p.done).length === 0) break;
      await step(r, "drain_payouts", betId, keeper.call(ESCROW, "drain_payouts", { bet_id: betId, limit: 20 }, 300));
    }
    const payoutsAfterRetry: PendingPayout[] = await maker.view(ESCROW, "pending_payouts_view", { from: 0, limit: 500 });
    const allDone = payoutsAfterRetry.filter((p) => p.bet_id === betId).every((p) => p.done);
    const finalBet: Bet | null = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    r.finalBetStatus = finalBet?.status ?? null;
    r.finishedAt = new Date().toISOString();
    r.status = finalBet?.status === "Settled" && allDone && r.steps.every((s) => s.monitor_ok) ? "pass" : "fail";
    return r;
  }

  console.log("\nDone. See ./data/g4-lifecycle-results.json and ./data/g4-tx-log.jsonl");
}

main().catch((err) => {
  console.error("G4 MATRIX FAILED:", err);
  process.exit(1);
});
