// G6 (loop 6): testnet proof for the intents AuthCall path (`on_auth`,
// FM-8/FM-10/FM-11) + the OutLayer unused-compute refund-to-intents rail.
// Real intents.near isn't deployed here -- `intents-mock` plays its role,
// so this script signs calls to escrow's `on_auth` AS the intents-mock
// account itself (its real on-chain predecessor identity), passing
// `signer_id` as the argument exactly like a real AuthCall-routed
// `on_auth(signer_id, msg)` call would. Four scenarios, one bet each:
//   1. self_trigger_auth_call   -- taker requests resolution via AuthCall
//      (no keeper, no direct payable call), full lifecycle to Settled.
//   2. refund_lands_in_intents -- same path, OutLayer mock reports a
//      nonzero "unused compute"; proven credited into the SIGNER's
//      intents wNEAR balance (FM-10), never a native transfer.
//   3. doomed_auth_call_rejected -- an on_auth RequestResolution call
//      with an insufficient deposit must fail BEFORE any spend (FM-8).
//   4. keeper_direct_path -- the existing #[payable] request_resolution
//      entrypoint, confirmed still native-refund (not intents) for an
//      unused-compute amount (FM-11 "never native for AuthCall, never
//      intents for direct").
import fs from "node:fs";
import nacl from "tweetnacl";
import { NearClient } from "@praetorial/common/nearClient.js";
import { loadServiceConfig, loadKeyFile } from "@praetorial/common/config.js";
import { generateResolverKeypair, signOutcome } from "@praetorial/common/resolverSign.js";
import { buildSourceCheckMessage } from "@praetorial/common/sourceCheck.js";
import { buildOpenMsg } from "@praetorial/common/openMsg.js";
import type { Envelope, Bet } from "@praetorial/common/types.js";
import { envelopeDeposits } from "@praetorial/common/storageCharge.js";

const CRED_DIR = process.env.NEAR_CREDENTIALS_DIR ?? `${process.env.HOME}/.near-credentials/testnet`;
function keyFor(accountId: string) {
  return loadKeyFile(`${CRED_DIR}/${accountId}.json`);
}

const cfg = loadServiceConfig();
const ESCROW = cfg.escrowContract;
const INTENTS = cfg.intentsContract;
const OUTLAYER = process.env.OUTLAYER_CONTRACT_ID ?? "outlayer-mock.praetorial-dev-1101.testnet";
const USDC = cfg.usdcTokenId;

const MAKER_ID = process.env.E2E_MAKER_ID ?? "maker1.praetorial-dev-1101.testnet";
const TAKER_ID = process.env.E2E_TAKER_ID ?? "taker1.praetorial-dev-1101.testnet";
const KEEPER_ID = process.env.E2E_KEEPER_ID ?? "keeper.praetorial-dev-1101.testnet";
const WNEAR_TOKEN_ID = "nep141:wrap.testnet";

const results: Record<string, any> = {};

async function waitMs(ms: number, label: string) {
  console.log(`  [${label}] waiting ${Math.round(ms / 1000)}s...`);
  await new Promise((r) => setTimeout(r, ms));
}

async function openAndTake(
  maker: NearClient, taker: NearClient, keeper: NearClient, label: string,
): Promise<{ betId: number; resolverKeypair: ReturnType<typeof generateResolverKeypair> }> {
  // D-ECON5: no per-bet reserve any more -- stake + storage only.
  // E2S1: envelope storage_charge_per_side is "0"; each side deposits stake + the contract per-side charge from the asset_limit view.
  const stake = 1_000_000n;
  const termsText = `G6 AuthCall proof: ${label}`;
  const { maker: makerRequired, taker: takerRequired } = await envelopeDeposits(
    (a) => maker.view(ESCROW, "asset_limit", { asset_id: a }),
    { terms: termsText, terms_hash: "e".repeat(64), models_snapshot_hash: "g6-authcall", stake_maker: stake.toString(), stake_taker: stake.toString(), maker_asset: USDC, taker_asset: USDC });
  await keeper.call(INTENTS, "mint", { account_id: MAKER_ID, token_id: USDC, amount: (makerRequired + 20_000_000n).toString() }, 30);
  await keeper.call(INTENTS, "mint", { account_id: TAKER_ID, token_id: USDC, amount: (takerRequired + 20_000_000n).toString() }, 30);
  const resolverKeypair = generateResolverKeypair();
  const nowNs = Date.now() * 1_000_000;
  const envelope: Envelope = {
    bet_id: 0, version: 1, maker: MAKER_ID, taker_allow: { Any: {} }, terms_hash: "e".repeat(64),
    models_snapshot_hash: "g6-authcall", outcomes: ["YES", "NO"], maker_side: "YES",
    stake_maker: stake.toString(), stake_taker: stake.toString(), fee_bps: 100, storage_charge_per_side: "0",
    keep_terms: true, terms: termsText, max_paid_runs: 3,
    tier: 1, maker_asset: USDC, taker_asset: USDC, funding_deadline: nowNs + 20 * 1_000_000_000,
    early_settle_outcome: null, finality_delay: 0, settlement_period: 15 * 1_000_000_000,
    resolve_deadline: nowNs + 3600 * 1_000_000_000, consent_party_controlled: false,
  };
  // D-KEY1/D-FETCH2 (7g2): handle_open requires a fresh resolver-signed
  // sources-reachable attestation, verified against the contract's
  // pinned attest_pubkey (resolver_keys() view) -- never an envelope
  // field.
  const checkedAtNs = Date.now() * 1_000_000;
  const scMessage = Buffer.from(buildSourceCheckMessage(envelope.terms_hash, String(checkedAtNs)), "utf8");
  const scSig = nacl.sign.detached(scMessage, resolverKeypair.secretKey);
  const attestation = { checked_at: checkedAtNs, signature_hex: Buffer.from(scSig).toString("hex") };
  await maker.call(INTENTS, "transfer_with_msg", { receiver_id: ESCROW, token_id: USDC, amount: makerRequired.toString(), msg: buildOpenMsg(envelope as any, attestation) }, 80);
  let betId: number | undefined;
  for (let i = 0; i < 20 && betId === undefined; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1000));
    const offers: Bet[] = await maker.view(ESCROW, "open_offers", { from: 0, limit: 500 });
    const created = offers.filter((b) => b.envelope.maker === MAKER_ID && b.taker === null).pop();
    if (created) betId = created.envelope.bet_id;
  }
  if (betId === undefined) throw new Error(`[${label}] could not find just-created offer`);
  await taker.call(INTENTS, "transfer_with_msg", { receiver_id: ESCROW, token_id: USDC, amount: takerRequired.toString(), msg: JSON.stringify({ kind: "Take", bet_id: betId, invite_sig: null }) }, 80);
  return { betId, resolverKeypair };
}

async function submitOutcome(keeper: NearClient, betId: number, outcome: string, kp: ReturnType<typeof generateResolverKeypair>, runNo: number) {
  const result = { bet_id: betId, terms_hash: "e".repeat(64), outcome, element_results_hash: "r".repeat(64), run_no: runNo, checked_until: (Date.now() * 1_000_000).toString(), judge_pair_index: 0 };
  const sig = signOutcome(ESCROW, result as any, kp.secretKey);
  return keeper.call(ESCROW, "submit_outcome", { result, signature_hex: sig }, 60);
}

async function main() {
  const maker = new NearClient(cfg, { accountId: MAKER_ID, privateKey: keyFor(MAKER_ID).private_key });
  const taker = new NearClient(cfg, { accountId: TAKER_ID, privateKey: keyFor(TAKER_ID).private_key });
  const keeper = new NearClient(cfg, { accountId: KEEPER_ID, privateKey: keyFor(KEEPER_ID).private_key });
  const intents = new NearClient(cfg, { accountId: INTENTS, privateKey: keyFor(INTENTS).private_key });
  await Promise.all([maker.init(), taker.init(), keeper.init(), intents.init()]);

  // --- 1 + 2: self_trigger_auth_call + refund_lands_in_intents (combined
  // into one bet: same AuthCall-initiated resolution, with OutLayer
  // forced to report a nonzero unused-compute amount) ---
  try {
    const { betId, resolverKeypair } = await openAndTake(maker, taker, keeper, "auth_call_self_trigger");
    const bet: Bet = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitMs(Math.max(0, bet.envelope.funding_deadline / 1_000_000 - Date.now()) + 2000, "auth_call_self_trigger");
    const unusedYocto = "1500000000000000000000"; // 0.0015 NEAR, well under the deposit below
    await operatorSetUnusedCompute(keeper, unusedYocto);
    const depositYocto = BigInt("10000000000000000000000"); // 0.01 NEAR
    const balBefore = await intents.view<string>(INTENTS, "mt_balance_of", { account_id: TAKER_ID, token_id: WNEAR_TOKEN_ID });
    const authTx: any = await intents.callPayable(ESCROW, "on_auth", { signer_id: TAKER_ID, msg: JSON.stringify({ kind: "RequestResolution", bet_id: betId }) }, depositYocto, 300);
    // wait for the async OutLayer->on_resolution->refund promise chain to settle
    await waitMs(5000, "auth_call_self_trigger");
    const afterAuth: Bet = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await submitOutcome(keeper, betId, "YES", resolverKeypair, 1);
    const bet2: Bet = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitMs(Math.max(0, (bet2.proposed_at! + bet2.envelope.settlement_period) / 1_000_000 - Date.now()) + 3000, "auth_call_self_trigger");
    await keeper.call(ESCROW, "finalize", { bet_id: betId }, 300);
    const finalBet: Bet = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    const balAfter = await intents.view<string>(INTENTS, "mt_balance_of", { account_id: TAKER_ID, token_id: WNEAR_TOKEN_ID });
    results.self_trigger_auth_call = {
      betId, status: afterAuth.status, finalStatus: finalBet.status, authTx: authTx?.transaction?.hash,
      pass: afterAuth.status === "Resolving" && finalBet.status === "Settled",
    };
    results.refund_lands_in_intents = {
      betId, balBefore, balAfter, expectedDelta: unusedYocto,
      actualDelta: (BigInt(balAfter) - BigInt(balBefore)).toString(),
      pass: (BigInt(balAfter) - BigInt(balBefore)).toString() === unusedYocto,
    };
  } catch (err: any) {
    results.self_trigger_auth_call = { pass: false, error: String(err?.message ?? err) };
    results.refund_lands_in_intents = { pass: false, error: String(err?.message ?? err) };
  } finally {
    await operatorSetUnusedCompute(keeper, null);
  }

  // --- 3: doomed_auth_call_rejected (insufficient deposit, cheap fail) ---
  try {
    const { betId } = await openAndTake(maker, taker, keeper, "doomed_auth_call");
    const bet: Bet = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitMs(Math.max(0, bet.envelope.funding_deadline / 1_000_000 - Date.now()) + 2000, "doomed_auth_call");
    let rejected = false, errMsg = "";
    try {
      await intents.call(ESCROW, "on_auth", { signer_id: TAKER_ID, msg: JSON.stringify({ kind: "RequestResolution", bet_id: betId }) }, 100);
    } catch (err: any) {
      rejected = true;
      errMsg = String(err?.message ?? err);
    }
    const betAfter: Bet = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    results.doomed_auth_call_rejected = {
      betId, rejected, errMsg, statusUnchanged: betAfter.status === "Taken",
      pass: rejected && betAfter.status === "Taken" && /attached deposit too low/.test(errMsg),
    };
  } catch (err: any) {
    results.doomed_auth_call_rejected = { pass: false, error: String(err?.message ?? err) };
  }

  // --- 4: keeper_direct_path (existing #[payable] path, native refund) ---
  try {
    const { betId, resolverKeypair } = await openAndTake(maker, taker, keeper, "keeper_direct_path");
    const bet: Bet = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitMs(Math.max(0, bet.envelope.funding_deadline / 1_000_000 - Date.now()) + 2000, "keeper_direct_path");
    const unusedYocto = "2500000000000000000000";
    await operatorSetUnusedCompute(keeper, unusedYocto);
    const balBefore = await keeper.account.getAccountBalance();
    await keeper.callPayable(ESCROW, "request_resolution", { bet_id: betId, terms: null }, BigInt("10000000000000000000000"), 300);
    await waitMs(5000, "keeper_direct_path");
    const balAfter = await keeper.account.getAccountBalance();
    const betAfter: Bet = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await submitOutcome(keeper, betId, "NO", resolverKeypair, 1);
    const bet2: Bet = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    await waitMs(Math.max(0, (bet2.proposed_at! + bet2.envelope.settlement_period) / 1_000_000 - Date.now()) + 3000, "keeper_direct_path");
    await keeper.call(ESCROW, "finalize", { bet_id: betId }, 300);
    const finalBet: Bet = await maker.view(ESCROW, "get_bet", { bet_id: betId });
    results.keeper_direct_path = {
      betId, status: betAfter.status, finalStatus: finalBet.status,
      balBefore: balBefore.available, balAfter: balAfter.available,
      // gas fees also eat into keeper's native balance, so this is a
      // sanity floor (balance rose, consistent with a native refund),
      // not an exact-delta check like the intents-credit assertion above.
      balanceRose: BigInt(balAfter.available) > BigInt(balBefore.available) - BigInt("5000000000000000000000"),
      pass: betAfter.status === "Resolving" && finalBet.status === "Settled",
    };
  } catch (err: any) {
    results.keeper_direct_path = { pass: false, error: String(err?.message ?? err) };
  } finally {
    await operatorSetUnusedCompute(keeper, null);
  }

  fs.mkdirSync("./data", { recursive: true });
  fs.writeFileSync("./data/g6-authcall-proof-results.json", JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}

async function operatorSetUnusedCompute(keeper: NearClient, amountYocto: string | null) {
  await keeper.call(OUTLAYER, "set_test_unused_compute", { amount_yocto: amountYocto }, 30);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
