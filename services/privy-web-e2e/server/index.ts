// The server half of the Option-1 round trip. It NEVER signs for the
// user: it builds the exact bytes to sign, runs the allowlist check,
// hands back only a hash, and -- once the browser's own Privy session
// signs it client-side -- verifies the signature against the
// account's public key before ever broadcasting. No app secret is
// loaded by this process at all (it doesn't need one).
import express from "express";
import { randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import { transactions as T } from "near-api-js";
import { buildUnsignedTx, attachSignature, broadcast, waitForFinal } from "../lib/nearRaw.js";
import { assertTransferAllowed, PolicyViolation } from "../lib/signerPolicy.js";
import { FUNDER_ID, INTENTS_MAINNET_CONTRACT, MAX_TRANSFER_BACK_YOCTO } from "../lib/config.js";
import { mainnetViewFunction } from "../lib/rpc.js";
import { borshEncodeNep413, hashNep413, randomNonce, buildIntentsTransferMessage, type Nep413Payload } from "../lib/nep413.js";

const app = express();
app.use(express.json());

const pendingTx = new Map<string, { tx: InstanceType<typeof T.Transaction>; hash32: Buffer; accountId: string }>();
const pendingNep413 = new Map<string, { payload: Nep413Payload; hash32: Buffer; accountId: string }>();

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Step (3): build a plain NEAR Transfer from the user's own implicit
// account back to the funder -- policy-capped, allowlisted receiver.
app.post("/api/transfer/build", async (req, res) => {
  try {
    const { accountId, publicKeyHex, amountYocto } = req.body as {
      accountId: string;
      publicKeyHex: string;
      amountYocto: string;
    };
    if (!/^[0-9a-f]{64}$/.test(accountId)) throw new PolicyViolation("accountId is not a NEAR implicit account id");
    const amount = BigInt(amountYocto);
    assertTransferAllowed(FUNDER_ID, amount);

    const action = T.transfer(amount);
    const { tx, hash32 } = await buildUnsignedTx(accountId, publicKeyHex, FUNDER_ID, [action]);
    const txId = randomUUID();
    pendingTx.set(txId, { tx, hash32: Buffer.from(hash32), accountId });
    res.json({ ok: true, txId, hashHex: "0x" + Buffer.from(hash32).toString("hex"), receiverId: FUNDER_ID, amountYocto: amount.toString() });
  } catch (err: any) {
    const rejectedBeforePrivy = err instanceof PolicyViolation;
    res.status(rejectedBeforePrivy ? 403 : 500).json({ ok: false, rejectedBeforePrivy, error: String(err?.message ?? err) });
  }
});

// After the browser's Privy session signs the hash we handed back.
app.post("/api/transfer/submit", async (req, res) => {
  try {
    const { txId, signatureHex, publicKeyHex } = req.body as { txId: string; signatureHex: string; publicKeyHex: string };
    const pending = pendingTx.get(txId);
    if (!pending) return res.status(404).json({ ok: false, error: "unknown txId" });

    const sigBytes = Buffer.from(signatureHex.replace(/^0x/, ""), "hex");
    const pubKeyBytes = Buffer.from(publicKeyHex.replace(/^0x/, ""), "hex");
    const valid = nacl.sign.detached.verify(pending.hash32, sigBytes, pubKeyBytes);
    if (!valid) {
      return res.status(400).json({ ok: false, error: "signature does not verify against the account's public key -- refusing to broadcast" });
    }
    // Defense in depth: the implicit account id itself IS the hex
    // public key -- confirm they match, not just that *some* valid
    // ed25519 signature was supplied.
    if (pending.accountId !== publicKeyHex.replace(/^0x/, "").toLowerCase()) {
      return res.status(400).json({ ok: false, error: "publicKeyHex does not match the implicit account id this tx was built for" });
    }

    const signed = attachSignature(pending.tx, signatureHex);
    const result = await broadcast(signed);
    const txHash = result?.transaction?.hash;
    const final = await waitForFinal(txHash, pending.accountId);
    const status = final?.status ?? result?.status;
    const succeeded = status?.SuccessValue !== undefined || status?.SuccessReceiptId !== undefined;
    pendingTx.delete(txId);
    res.json({ ok: succeeded, txHash, status, explorer: `https://testnet.nearblocks.io/txns/${txHash}` });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

// Step (4): build a NEP-413 intents Transfer-with-msg payload for the
// user's account to sign client-side, same mechanism as a native tx.
app.post("/api/nep413/build", async (req, res) => {
  try {
    const { accountId } = req.body as { accountId: string };
    if (!/^[0-9a-f]{64}$/.test(accountId)) throw new Error("accountId is not a NEAR implicit account id");
    const deadline = new Date(Date.now() + 5 * 60_000).toISOString();
    const message = buildIntentsTransferMessage({
      signerId: accountId,
      receiverId: FUNDER_ID,
      tokenId: "nep141:usdc.near",
      amount: "1",
      deadlineIso: deadline,
    });
    const nonce = randomNonce();
    const payload: Nep413Payload = { message, nonce, recipient: INTENTS_MAINNET_CONTRACT };
    const hash32 = hashNep413(payload);
    const nep413Id = randomUUID();
    pendingNep413.set(nep413Id, { payload, hash32, accountId });
    res.json({
      ok: true,
      nep413Id,
      hashHex: "0x" + hash32.toString("hex"),
      message,
      nonceB64: nonce.toString("base64"),
      recipient: INTENTS_MAINNET_CONTRACT,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

// Verify the signature locally, then call simulate_intents on mainnet
// view-only -- nothing is executed, nothing is spent.
app.post("/api/nep413/submit", async (req, res) => {
  try {
    const { nep413Id, signatureHex, publicKeyHex } = req.body as { nep413Id: string; signatureHex: string; publicKeyHex: string };
    const pending = pendingNep413.get(nep413Id);
    if (!pending) return res.status(404).json({ ok: false, error: "unknown nep413Id" });

    const sigBytes = Buffer.from(signatureHex.replace(/^0x/, ""), "hex");
    const pubKeyBytes = Buffer.from(publicKeyHex.replace(/^0x/, ""), "hex");
    const valid = nacl.sign.detached.verify(pending.hash32, sigBytes, pubKeyBytes);
    if (!valid) {
      return res.status(400).json({ ok: false, error: "NEP-413 signature does not verify against the account's public key" });
    }

    const bs58 = (await import("bs58")).default;
    const publicKeyNear = "ed25519:" + bs58.encode(pubKeyBytes);
    const signatureNear = "ed25519:" + bs58.encode(sigBytes);

    const multiPayload = {
      signed: [
        {
          standard: "nep413",
          payload: {
            recipient: pending.payload.recipient,
            nonce: pending.payload.nonce.toString("base64"),
            message: pending.payload.message,
          },
          public_key: publicKeyNear,
          signature: signatureNear,
        },
      ],
    };

    let simResult: any = null;
    let simError: string | null = null;
    try {
      simResult = await mainnetViewFunction(INTENTS_MAINNET_CONTRACT, "simulate_intents", multiPayload);
    } catch (err: any) {
      simError = String(err?.message ?? err);
    }

    res.json({
      ok: true,
      signatureVerifiedLocally: true,
      multiPayload,
      simulateIntentsResult: simResult,
      simulateIntentsError: simError,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

const PORT = Number(process.env.PORT ?? 8787);
app.listen(PORT, () => {
  console.log(`privy-web-e2e server listening on :${PORT}`);
});
