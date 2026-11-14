// Testnet E2E: create a bet, take it, let the keeper (with its
// testnet-only resolver-sim) drive it through resolution -> proposed ->
// settlement -> finalize with no manual calls after setup. Records every
// tx hash via the keeper's own TxLogger.
//
// Setup (maker opens, taker takes) is done here with each party's own
// key, exactly like a user/agent would via the relayer — not by the
// keeper, which never touches stake money.
import fs from "node:fs";
import nacl from "tweetnacl";
import { NearClient } from "@praetorial/common/nearClient.js";
import { loadServiceConfig, loadKeyFile } from "@praetorial/common/config.js";
import { TxLogger } from "@praetorial/common/logger.js";
import { generateResolverKeypair } from "@praetorial/common/resolverSign.js";
import { buildSourceCheckMessage } from "@praetorial/common/sourceCheck.js";
import { buildOpenMsg } from "@praetorial/common/openMsg.js";
import type { Envelope, Bet } from "@praetorial/common/types.js";
import { envelopeDeposits } from "@praetorial/common/storageCharge.js";
import { tick } from "../keeper/src/runner.js";

const CRED_DIR = process.env.NEAR_CREDENTIALS_DIR ?? `${process.env.HOME}/.near-credentials/testnet`;

function keyFor(accountId: string) {
  return loadKeyFile(`${CRED_DIR}/${accountId}.json`);
}

async function main() {
  const cfg = loadServiceConfig();
  const escrow = cfg.escrowContract;
  const intents = cfg.intentsContract;
  const makerId = process.env.E2E_MAKER_ID ?? "maker1.praetorial-dev-1101.testnet";
  const takerId = process.env.E2E_TAKER_ID ?? "taker1.praetorial-dev-1101.testnet";
  const keeperId = process.env.E2E_KEEPER_ID ?? "keeper.praetorial-dev-1101.testnet";

  const makerClient = new NearClient(cfg, { accountId: makerId, privateKey: keyFor(makerId).private_key });
  const takerClient = new NearClient(cfg, { accountId: takerId, privateKey: keyFor(takerId).private_key });
  const keeperKey = keyFor(keeperId);
  const keeperClient = new NearClient(cfg, { accountId: keeperId, privateKey: keeperKey.private_key });
  await Promise.all([makerClient.init(), takerClient.init(), keeperClient.init()]);

  const logger = new TxLogger("./data/e2e-tx-log.jsonl");
  const log = (action: string, detail: string, tx_hash?: string) =>
    logger.log({ service: "e2e", action, status: "ok", detail, tx_hash });

  // 1. Resolver keypair (testnet stand-in for OutLayer's TEE key).
  const resolverKeypair = generateResolverKeypair();
  const resolverSeedHex = Buffer.from(resolverKeypair.secretKey.slice(0, 32)).toString("hex");
  log("resolver_keypair_generated", `pubkey=${resolverKeypair.publicKeyHex}`);

  // 2. Mint test USDC to maker/taker via mock-intents faucet (testnet only).
  const tokenId = cfg.usdcTokenId;
  const stakeMaker = 1_000_000n;
  const stakeTaker = 1_000_000n;
  // D-ECON5: no per-bet reserve any more -- stake + storage only.
  // E2S1: envelope storage_charge_per_side is "0"; each side deposits stake + the contract per-side charge from the asset_limit view.
  const termsText = "E2E test bet: does the service layer reach Settled with no manual calls?";
  const { maker: makerRequired, taker: takerRequired } = await envelopeDeposits(
    (a) => makerClient.view(escrow, "asset_limit", { asset_id: a }),
    { terms: termsText, terms_hash: "e".repeat(64), models_snapshot_hash: "services-e2e-v0", stake_maker: stakeMaker.toString(), stake_taker: stakeTaker.toString(), maker_asset: tokenId, taker_asset: tokenId });

  await keeperClient.call(intents, "mint", { account_id: makerId, token_id: tokenId, amount: makerRequired.toString() }, 30);
  await keeperClient.call(intents, "mint", { account_id: takerId, token_id: tokenId, amount: takerRequired.toString() }, 30);
  log("mint_test_usdc", `maker=${makerRequired} taker=${takerRequired} token=${tokenId}`);

  // 3. Maker opens the bet (short funding/settlement windows for a fast
  // E2E run; resolve_deadline generous so the resolver-sim has headroom).
  const nowNs = Date.now() * 1_000_000;
  // Generous funding window: mint (x2) + open + take are 4 sequential
  // signed testnet txs, each of which can involve a nonce retry (seen in
  // practice); 20s was too tight and caused handle_take's own
  // `block_timestamp() > funding_deadline` check to correctly reject a
  // late take (contract behaved right; the E2E script's budget was
  // wrong). 180s covers worst-case RPC latency with headroom.
  const fundingDeadline = nowNs + 180 * 1_000_000_000; // +180s
  const settlementPeriod = 30 * 1_000_000_000; // 30s
  const resolveDeadline = nowNs + 7200 * 1_000_000_000; // +2h

  const envelope: Envelope = {
    bet_id: 0,
    version: 1,
    maker: makerId,
    taker_allow: { Any: {} },
    terms_hash: "e".repeat(64),
    models_snapshot_hash: "services-e2e-v0",
    outcomes: ["YES", "NO"],
    maker_side: "YES",
    stake_maker: stakeMaker.toString(),
    stake_taker: stakeTaker.toString(),
    fee_bps: 100,
    storage_charge_per_side: "0",
    keep_terms: true,
    terms: termsText,
    max_paid_runs: 2,
    tier: 1,
    // NOTE (7g2): the Rust Envelope struct has no `arbiter` field at all
    // (D-REF1 removed arbiter_fee/arbiter already) -- this is stale on
    // the TS Envelope type too (out of scope for 7g2's resolver-key
    // peripherals list; left as-is here only to keep this type-checking
    // against the current types.ts, not sent to the contract as JSON
    // since the contract struct simply has no such field to populate).
    maker_asset: tokenId,
    taker_asset: tokenId,
    funding_deadline: fundingDeadline,
    early_settle_outcome: null,
    finality_delay: 0,
    settlement_period: settlementPeriod,
    resolve_deadline: resolveDeadline,
    consent_party_controlled: false,
  };

  // D-KEY1/D-FETCH2 (7g2): handle_open now requires a fresh resolver-signed
  // sources-reachable attestation for this exact term sheet, verified
  // against the contract's pinned attest_pubkey -- never an envelope
  // field. Signed here with the same resolverKeypair this script already
  // generated (the testnet resolver stand-in).
  const checkedAtNs = Date.now() * 1_000_000;
  const scMessage = Buffer.from(buildSourceCheckMessage(envelope.terms_hash, String(checkedAtNs)), "utf8");
  const scSig = nacl.sign.detached(scMessage, resolverKeypair.secretKey);
  const attestation = { checked_at: checkedAtNs, signature_hex: Buffer.from(scSig).toString("hex") };

  const openResult: any = await makerClient.call(
    intents,
    "transfer_with_msg",
    {
      receiver_id: escrow,
      token_id: tokenId,
      amount: makerRequired.toString(),
      msg: buildOpenMsg(envelope as any, attestation),
    },
    80,
  );
  log("open", `maker=${makerId} amount=${makerRequired}`, openResult?.transaction?.hash);

  // Discover the bet_id the contract assigned (next_bet_id - 1, found via
  // open_offers since the contract just created it as Open).
  const offers: Bet[] = await makerClient.view(escrow, "open_offers", { from: 0, limit: 50 });
  const created = offers.filter((b) => b.envelope.maker === makerId && b.taker === null).pop();
  if (!created) throw new Error("could not find the just-created open offer");
  const betId = created.envelope.bet_id;
  log("discovered_bet_id", `bet_id=${betId}`);

  // 4. Taker takes it.
  const takeResult: any = await takerClient.call(
    intents,
    "transfer_with_msg",
    {
      receiver_id: escrow,
      token_id: tokenId,
      amount: takerRequired.toString(),
      msg: JSON.stringify({ kind: "Take", bet_id: betId, invite_sig: null }),
    },
    80,
  );
  log("take", `taker=${takerId} bet_id=${betId}`, takeResult?.transaction?.hash);

  const betAfterTake: Bet | null = await makerClient.view(escrow, "get_bet", { bet_id: betId });
  log("post_take_status", `status=${betAfterTake?.status}`);

  // 5. Resolver decision file: force YES for this run (testnet-only).
  const decisionsPath = "./data/e2e-resolver-decisions.json";
  fs.mkdirSync("./data", { recursive: true });
  fs.writeFileSync(decisionsPath, JSON.stringify({ [String(betId)]: "YES" }));

  // 6. Drive the keeper loop: wait for funding_deadline, then poll ticks
  // until the bet reaches Settled. No manual contract calls from here on.
  const statePath = "./data/e2e-keeper-state.json";
  if (fs.existsSync(statePath)) fs.rmSync(statePath);
  const deadlineWaitMs = Math.max(0, fundingDeadline / 1_000_000 - Date.now()) + 2000;
  console.log(`waiting ${Math.round(deadlineWaitMs / 1000)}s for funding_deadline to pass...`);
  await new Promise((r) => setTimeout(r, deadlineWaitMs));

  const maxTicks = 40;
  let finalBet: Bet | null = null;
  for (let i = 0; i < maxTicks; i++) {
    const executed = await tick({
      client: keeperClient,
      escrowContract: escrow,
      logger,
      statePath,
      resolverSecretSeedHex: resolverSeedHex,
      decisionsPath,
      attachedNearYocto: BigInt("10000000000000000000000"), // 0.01 NEAR
    });
    finalBet = await makerClient.view(escrow, "get_bet", { bet_id: betId });
    console.log(`tick ${i}: status=${finalBet?.status} executed=${executed.map((a) => a.kind).join(",") || "-"}`);
    if (finalBet?.status === "Settled" || finalBet?.status === "Voided") break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  log("final_status", `bet_id=${betId} status=${finalBet?.status} outcome=${finalBet?.outcome}`);

  const payouts: any[] = await makerClient.view(escrow, "pending_payouts_view", { from: 0, limit: 50 });
  const betPayouts = payouts.filter((p) => p.bet_id === betId);
  log("payouts", JSON.stringify(betPayouts.map((p) => ({ id: p.id, receiver: p.receiver, amount: p.amount, reason: p.reason, done: p.done }))));

  if (finalBet?.status !== "Settled" && finalBet?.status !== "Voided") {
    throw new Error(`E2E did not reach a terminal state within ${maxTicks} ticks; last status=${finalBet?.status}`);
  }
  console.log("E2E COMPLETE. See ./data/e2e-tx-log.jsonl and ./data/keeper-tx-log.jsonl for every tx hash.");
}

main().catch((err) => {
  console.error("E2E FAILED:", err);
  process.exit(1);
});
