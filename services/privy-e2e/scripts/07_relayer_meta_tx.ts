// Step (d): can a 0-NEAR Privy user act at all? Two findings tested
// live:
//  1. An implicit account must exist onchain (>=1 yoctoNEAR received)
//     before ANY tx can reference it as a sender -- NEP-366 meta-tx
//     needs a real access-key nonce, which only exists once the
//     account has been created onchain at all. So "zero NEAR" only
//     works in the sense of "no GAS-worthy balance", not "never
//     touched onchain" -- someone still has to send it >=1 yoctoNEAR
//     once. We test exactly that: the smallest possible footprint.
//  2. services/relayer's CURRENT implementation does NOT support this
//     -- its own doc comment says testnet mock-intents requires
//     signer==sender, i.e. it only forwards a tx the sender ALREADY
//     signed with their own key; it is not a real meta-tx relayer.
//     This script bypasses that service and builds a genuine NEP-366
//     DelegateAction by hand, signed via Privy's real raw_sign, to
//     test the mechanism itself (regardless of this repo's relayer
//     service catching up to it) -- and records the gap explicitly.
import fs from "node:fs";
import { transactions as T, utils } from "near-api-js";
import { buildDelegateAction, encodeDelegateAction } from "@near-js/transactions";
import { createHash } from "node:crypto";
import { getOrCreateUserWallet } from "../lib/walletService.js";
import { rawSign } from "../lib/privy.js";
import { publicKeyFromHex } from "../lib/nearRaw.js";
import { LocalSigner, loadKeyFile } from "../lib/localSigner.js";
import { FUNDER_ID, CRED_DIR } from "../lib/config.js";
import { viewAccessKeyNonce, provider, withRetry } from "../lib/rpc.js";

const EMAIL_C = process.env.PRIVY_E2E_EMAIL_C ?? "praetorial-e2e+wallet-user-c@example.com";

async function main() {
  const { row } = await getOrCreateUserWallet(EMAIL_C);
  console.log("Privy wallet C:", row.walletId, row.implicitAccountId);

  const funderKey = loadKeyFile(`${CRED_DIR}/${FUNDER_ID}.json`);
  const funder = new LocalSigner(FUNDER_ID, funderKey.private_key);
  await funder.init();

  // Minimal-footprint funding: exactly 1 yoctoNEAR, just enough to
  // make the account exist onchain with a registered full access key
  // (per script 06's finding) -- NOT enough to pay for a single unit
  // of gas. This is the "0-NEAR user" starting point.
  console.log("funding wallet C with exactly 1 yoctoNEAR (registers the access key, pays for nothing)...");
  const fundTx: any = await funder.sendNear(row.implicitAccountId, 1n);
  console.log("fund tx:", fundTx?.transaction?.hash);
  await new Promise((r) => setTimeout(r, 1500));

  const pubKey = publicKeyFromHex(row.publicKeyHex);
  const nonce = await viewAccessKeyNonce(row.implicitAccountId, pubKey.toString());
  const blockInfo: any = await withRetry(() => provider().block({ finality: "final" }), "block(final)");
  const maxBlockHeight = BigInt(blockInfo.header.height) + 200n;

  // The delegated action itself: transfer the account's entire 1
  // yoctoNEAR back to the funder. Trivial by design -- the point is
  // proving the SIGNING mechanism (Privy raw_sign over a NEP-366
  // hash), not moving meaningful value. Native Transfer is used here
  // deliberately (this is a standalone protocol-mechanics probe, NOT
  // going through lib/signAndSend.ts's FunctionCall-only allowlist,
  // which is the production path for actual user funds).
  const delegateAction = buildDelegateAction({
    senderId: row.implicitAccountId,
    receiverId: FUNDER_ID,
    actions: [T.transfer(1n as any)],
    nonce,
    maxBlockHeight,
    publicKey: pubKey,
  });
  const encoded = encodeDelegateAction(delegateAction as any);
  const hash32 = createHash("sha256").update(Buffer.from(encoded)).digest();

  console.log("asking Privy to raw_sign the NEP-366 DelegateAction hash...");
  let sig;
  let privyError: string | undefined;
  try {
    sig = await rawSign(row.walletId, hash32);
  } catch (err: any) {
    privyError = String(err?.message ?? err);
  }

  if (!sig) {
    const record = { step: "relayer_meta_tx", ok: false, gap: "Privy raw_sign on the DelegateAction hash failed", privyError };
    fs.writeFileSync("./data/relayer_meta_tx.json", JSON.stringify(record, null, 2));
    console.error(JSON.stringify(record, null, 2));
    process.exit(1);
  }

  const sigBytes = Buffer.from(sig.signatureHex, "hex");
  const { actionCreators } = await import("@near-js/transactions");
  const outerAction = actionCreators.signedDelegate({
    delegateAction: delegateAction as any,
    signature: new T.Signature({ keyType: 0, data: sigBytes }) as any,
  });

  console.log("relayer (funder) wraps the SignedDelegate in its own outer tx and broadcasts...");
  let outerResult: any;
  let relayError: string | undefined;
  try {
    // NEP-366: the OUTER transaction's receiverId must be the
    // DELEGATE's senderId (the user's own account) -- the runtime
    // then executes the inner actions as if originating from that
    // account against delegateAction.receiverId (FUNDER_ID here).
    // Sending the outer tx to FUNDER_ID instead (my first attempt)
    // fails nearcore's DelegateActionSenderDoesNotMatchTxReceiver check.
    outerResult = await (funder.account as any).signAndSendTransaction({ receiverId: row.implicitAccountId, actions: [outerAction] });
  } catch (err: any) {
    relayError = String(err?.message ?? err);
  }

  const record = {
    step: "relayer_meta_tx",
    ok: !!outerResult && !relayError,
    walletId: row.walletId,
    accountId: row.implicitAccountId,
    minimalFundingTx: fundTx?.transaction?.hash,
    outerTxHash: outerResult?.transaction?.hash,
    relayError,
    finalStatus: outerResult?.status ?? null,
    gapNote:
      "services/relayer's current implementation (relayer.ts submitSignedTransfer) requires signer===sender " +
      "and does NOT implement NEP-366 DelegateAction relaying at all -- this script bypasses it to test the " +
      "underlying Privy-signing mechanism directly. A real 'testnet relayer path' for meta-tx does not exist " +
      "in this repo yet; see README gap list.",
  };
  fs.writeFileSync("./data/relayer_meta_tx.json", JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record, null, 2));
}

main().catch((err) => {
  console.error("FATAL:", err?.body ?? err);
  process.exit(1);
});
