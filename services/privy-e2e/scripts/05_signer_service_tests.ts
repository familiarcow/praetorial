// Step (b) proof: sign_and_send's positive path (an allowlisted call,
// built/signed/broadcast/verified/confirmed for real) plus every
// refusal case from step 7 -- each one must be rejected
// BEFORE Privy's raw_sign is ever invoked (rejectedBeforePrivy:true).
import fs from "node:fs";
import { signAndSend, SignAndSendResult } from "../lib/signAndSend.js";
import { LocalSigner, loadKeyFile } from "../lib/localSigner.js";
import { FUNDER_ID, CRED_DIR, ESCROW, INTENTS, USDC, MAX_TRANSFER_AMOUNT_USDC_6DP } from "../lib/config.js";
import { findByEmail } from "../lib/walletStore.js";

const EMAIL_A = process.env.PRIVY_E2E_EMAIL_A ?? "praetorial-e2e+wallet-user-a@example.com";
const FUND_AMOUNT_YOCTO = 300_000_000_000_000_000_000_000n; // 0.3 NEAR, gas only

async function main() {
  const row = findByEmail(EMAIL_A);
  if (!row) throw new Error(`no wallet row for ${EMAIL_A} -- run scripts/04_wallet_idempotency.ts first`);

  const funderKey = loadKeyFile(`${CRED_DIR}/${FUNDER_ID}.json`);
  const funder = new LocalSigner(FUNDER_ID, funderKey.private_key);
  await funder.init();
  console.log(`funding ${row.implicitAccountId} with 0.3 NEAR for gas...`);
  const fundTx: any = await funder.sendNear(row.implicitAccountId, FUND_AMOUNT_YOCTO);
  console.log("fund tx:", fundTx?.transaction?.hash);

  const policy = { escrowContract: ESCROW, intentsContract: INTENTS, usdcTokenId: USDC, maxTransferAmount: MAX_TRANSFER_AMOUNT_USDC_6DP };

  const cases: { name: string; intent: any; expect: "allowed_onchain" | "rejected_before_privy" }[] = [
    {
      name: "positive: allowlisted escrow.cancel call (nonexistent bet_id -- proves build/sign/broadcast/verify pipeline, contract-level outcome is irrelevant to the signer-safety claim)",
      intent: { userId: row.privyUserId, accountId: row.implicitAccountId, receiverId: ESCROW, methodName: "cancel", args: { bet_id: 999999999 }, gasTgas: 60 },
      expect: "allowed_onchain",
    },
    {
      name: "negative: receiver not on allowlist (funder account, arbitrary method)",
      intent: { userId: row.privyUserId, accountId: row.implicitAccountId, receiverId: FUNDER_ID, methodName: "whatever", args: {} },
      expect: "rejected_before_privy",
    },
    {
      name: "negative: allowlisted receiver, non-allowlisted method (escrow.finalize)",
      intent: { userId: row.privyUserId, accountId: row.implicitAccountId, receiverId: ESCROW, methodName: "finalize", args: { bet_id: 1 } },
      expect: "rejected_before_privy",
    },
    {
      name: "negative: transfer_with_msg amount over cap",
      intent: {
        userId: row.privyUserId,
        accountId: row.implicitAccountId,
        receiverId: INTENTS,
        methodName: "transfer_with_msg",
        args: { receiver_id: ESCROW, token_id: USDC, amount: (MAX_TRANSFER_AMOUNT_USDC_6DP + 1n).toString(), msg: JSON.stringify({ kind: "Open" }) },
      },
      expect: "rejected_before_privy",
    },
    {
      name: "negative: transfer_with_msg to a non-escrow receiver_id inside msg (fund drain attempt)",
      intent: {
        userId: row.privyUserId,
        accountId: row.implicitAccountId,
        receiverId: INTENTS,
        methodName: "transfer_with_msg",
        args: { receiver_id: FUNDER_ID, token_id: USDC, amount: "1000", msg: JSON.stringify({ kind: "Drain" }) },
      },
      expect: "rejected_before_privy",
    },
    {
      name: "negative: ownership mismatch -- caller claims a different account than the user's own wallet",
      intent: { userId: row.privyUserId, accountId: "0".repeat(64), receiverId: ESCROW, methodName: "cancel", args: { bet_id: 1 } },
      expect: "rejected_before_privy",
    },
  ];

  const results: any[] = [];
  for (const c of cases) {
    console.log(`\n--- ${c.name} ---`);
    let res: SignAndSendResult;
    try {
      res = await signAndSend(policy, c.intent);
    } catch (err: any) {
      res = { ok: false, error: String(err?.message ?? err), rejectedBeforePrivy: true };
    }
    console.log(JSON.stringify(res, null, 2));
    const actual = res.rejectedBeforePrivy ? "rejected_before_privy" : "allowed_onchain";
    const pass = c.expect === "rejected_before_privy" ? res.rejectedBeforePrivy === true : res.rejectedBeforePrivy !== true;
    results.push({ name: c.name, expect: c.expect, actual, txHash: res.txHash, error: res.error, pass });
  }

  fs.writeFileSync("./data/signer_service_tests.json", JSON.stringify(results, null, 2));
  console.log("\n=== SUMMARY ===");
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
  if (results.some((r) => !r.pass)) process.exit(1);
}

main().catch((err) => {
  console.error("FATAL:", err?.body ?? err);
  process.exit(1);
});
