// Steps 4+5 (combined): the Privy-held wallet signs and broadcasts its
// FIRST real NEAR transaction via Privy's raw_sign -- a
// transfer_with_msg(Open) call that both proves native tx signing
// works end-to-end with the real vendor, and opens a bet on the
// testnet escrow (maker side). Goes through the allowlist policy
// (lib/signerPolicy.ts) exactly like a production call would.
import fs from "node:fs";
import nacl from "tweetnacl";
import { PrivyPolicySigner } from "../lib/privySigner.js";
import { generateResolverKeypair } from "../lib/resolverSign.js";
import { ESCROW, INTENTS, USDC, MAX_TRANSFER_AMOUNT_USDC_6DP } from "../lib/config.js";
import { viewFunction } from "../lib/rpc.js";
// D-KEY1/D-FETCH2 (7g2): reuse the shared services/common sourcecheck
// message builder instead of re-deriving the message format here --
// privy-e2e has no @praetorial/common path alias of its own, so this is
// a plain relative import across the services/ workspace.
import { buildSourceCheckMessage } from "../../common/src/sourceCheck.js";
import { buildOpenMsg } from "../../common/src/openMsg.js";

async function main() {
  const user = JSON.parse(fs.readFileSync("./data/privy_user.json", "utf8"));
  const accountId: string = user.implicitAccountId;
  const walletId: string = user.walletId;

  const policy = { escrowContract: ESCROW, intentsContract: INTENTS, usdcTokenId: USDC, maxTransferAmount: MAX_TRANSFER_AMOUNT_USDC_6DP };
  const signer = new PrivyPolicySigner(accountId, user.address, walletId, policy);

  const stakeMaker = 1_000_000n; // 1.00 USDC @ 6dp
  // D-ECON5: no per-bet reserve any more -- stake + storage only.
  const storageChargePerSide = 2_000n;
  const makerRequired = stakeMaker + storageChargePerSide;

  const resolverKeypair = generateResolverKeypair();
  const resolverSeedHex = Buffer.from(resolverKeypair.secretKey.slice(0, 32)).toString("hex");

  const nowNs = Date.now() * 1_000_000;
  const envelope = {
    bet_id: 0,
    version: 1,
    maker: accountId,
    taker_allow: { Any: {} },
    terms_hash: "e".repeat(64),
    models_snapshot_hash: "privy-e2e-v1",
    outcomes: ["YES", "NO"],
    maker_side: "YES",
    stake_maker: stakeMaker.toString(),
    stake_taker: stakeMaker.toString(),
    fee_bps: 100,
    storage_charge_per_side: storageChargePerSide.toString(),
    keep_terms: true,
    terms: "Praetorial Privy+NEAR E2E v1 -- maker funded and signed via real Privy raw_sign",
    max_paid_runs: 3,
    tier: 1,
    maker_asset: USDC,
    taker_asset: USDC,
    funding_deadline: nowNs + 120 * 1_000_000_000,
    early_settle_outcome: null,
    finality_delay: 0,
    settlement_period: 15 * 1_000_000_000,
    resolve_deadline: nowNs + 3600 * 1_000_000_000,
    consent_party_controlled: false,
  };

  // D-KEY1/D-FETCH2 (7g2): handle_open requires a fresh resolver-signed
  // sources-reachable attestation, verified against the contract's
  // pinned attest_pubkey (resolver_keys() view) -- never an envelope
  // field.
  const checkedAtNs = Date.now() * 1_000_000;
  const scMessage = Buffer.from(buildSourceCheckMessage(envelope.terms_hash, String(checkedAtNs)), "utf8");
  const scSig = nacl.sign.detached(scMessage, resolverKeypair.secretKey);
  const attestation = { checked_at: checkedAtNs, signature_hex: Buffer.from(scSig).toString("hex") };

  console.log(`opening bet as ${accountId} via Privy raw_sign (wallet ${walletId})...`);
  const { txHash, result } = await signer.call(
    INTENTS,
    "transfer_with_msg",
    { receiver_id: ESCROW, token_id: USDC, amount: makerRequired.toString(), msg: buildOpenMsg(envelope as any, attestation) },
    80,
  );
  console.log("Privy-signed open tx:", txHash);

  let created: any;
  for (let attempt = 0; attempt < 20 && !created; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
    const offers: any[] = await viewFunction(ESCROW, "open_offers", { from: 0, limit: 200 });
    created = offers.filter((b) => b.envelope.maker === accountId && b.taker === null).pop();
  }
  if (!created) throw new Error("could not find the just-created open offer");

  const record = {
    step: "open_bet_via_privy",
    ok: true,
    accountId,
    walletId,
    openTxHash: txHash,
    betId: created.envelope.bet_id,
    resolverPublicKeyHex: resolverKeypair.publicKeyHex,
    resolverSeedHex, // test-only stand-in key; not Privy/user key material, see resolverSign.ts doc
    makerRequired: makerRequired.toString(),
    envelope,
  };
  fs.writeFileSync("./data/open_bet.json", JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ ...record, resolverSeedHex: "[omitted from log]" }, null, 2));
}

main().catch((err) => {
  console.error("FATAL:", err?.body ?? err);
  process.exit(1);
});
