// Live testnet proof: a fresh 0-NEAR implicit account signs a real
// NEP-366 DelegateAction (FunctionCall `cancel` on escrow3, a
// view-safe/no-op-for-funds allowed method since the account is party to
// no bet) and our Relayer verifies + broadcasts it, paying gas from
// praetorial-dev-1101.testnet. Spend: 1 yoctoNEAR funding + relayer gas
// only (<0.01 NEAR), nowhere near the 0.2 NEAR ceiling.
import { KeyPair, utils } from "near-api-js";
import { actionCreators, buildDelegateAction, Signature, SCHEMA } from "@near-js/transactions";
import * as borsh from "borsh";
import { createHash } from "node:crypto";
import { NearClient } from "@praetorial/common/nearClient.js";
import { loadServiceConfig, loadKeyFile } from "@praetorial/common/config.js";
import { Relayer, chainPortFromClient } from "../src/relayer.js";

const CRED_DIR = `${process.env.HOME}/.near-credentials/testnet`;
const FUNDER_ID = "praetorial-dev-1101.testnet";
const ESCROW = "escrow3.praetorial-dev-1101.testnet";
const INTENTS = "intents-mock.praetorial-dev-1101.testnet";

async function main() {
  const cfg = loadServiceConfig();
  const funderKey = loadKeyFile(`${CRED_DIR}/${FUNDER_ID}.json`);
  const funderClient = new NearClient(cfg, { accountId: FUNDER_ID, privateKey: funderKey.private_key });
  await funderClient.init();

  // Fresh implicit account, zero NEAR. ed25519 implicit account id = hex(pubkey).
  const userKey = KeyPair.fromRandom("ed25519");
  const pub = userKey.getPublicKey();
  const pubHex = Buffer.from((pub as any).data).toString("hex");
  console.log("fresh user implicit account:", pubHex);

  console.log("funding with exactly 1 yoctoNEAR (minimal footprint, registers access key)...");
  const fundTx: any = await (funderClient as any).account.sendMoney(pubHex, 1n);
  console.log("fund tx:", fundTx?.transaction?.hash);
  // The implicit account's full-access key IS userKey by construction of a
  // NEAR implicit account (sendMoney to a hex pubkey creates it with that
  // key as a full-access key) -- no addKey step needed.
  await new Promise((r) => setTimeout(r, 2000));

  const nonce = await (async () => {
    const provider = (funderClient as any).account.connection.provider;
    const res: any = await provider.query({
      request_type: "view_access_key",
      finality: "final",
      account_id: pubHex,
      public_key: pub.toString(),
    });
    return BigInt(res.nonce) + 1n;
  })();
  const blockInfo: any = await (funderClient as any).account.connection.provider.block({ finality: "final" });
  const maxBlockHeight = BigInt(blockInfo.header.height) + 100n;

  const delegateAction = buildDelegateAction({
    senderId: pubHex,
    receiverId: ESCROW,
    actions: [actionCreators.functionCall("cancel", { bet_id: 999999999 }, 30_000_000_000_000n, 0n)],
    nonce,
    maxBlockHeight,
    publicKey: pub as any,
  });
  const { encodeDelegateAction } = await import("@near-js/transactions");
  const encoded = encodeDelegateAction(delegateAction);
  const hash = createHash("sha256").update(Buffer.from(encoded)).digest();
  const sig = userKey.sign(hash);
  const signature = new Signature({ keyType: 0, data: sig.signature });
  const bytes = borsh.serialize(SCHEMA.SignedDelegate, { delegateAction, signature });
  const base64 = Buffer.from(bytes).toString("base64");
  console.log("signed delegate bytes:", bytes.length);

  const relayer = new Relayer(chainPortFromClient(funderClient), {
    escrowContract: ESCROW,
    intentsContract: INTENTS,
    usdcTokenId: process.env.USDC_TOKEN_ID ?? "usdc.fakes.testnet",
    maxTransferAmount: 1_000_000_000n,
    maxBlockHeightFuture: 1200n,
    perCallSponsorshipYocto: 5_000_000_000_000_000_000_000n,
    maxRequestsPerWindow: 20,
    windowMs: 60_000,
    dailyBudgetYocto: 100_000_000_000_000_000_000_000n,
  });

  console.log("relaying (verify -> policy -> guards -> broadcast)...");
  const result = await relayer.relay(base64);
  console.log("RESULT txHash:", result.txHash);
  console.log(JSON.stringify({ ok: true, userImplicitAccountId: pubHex, fundTxHash: fundTx?.transaction?.hash, relayTxHash: result.txHash }));
}

main().catch((err) => {
  console.error("FATAL:", err?.message ?? err);
  process.exit(1);
});
