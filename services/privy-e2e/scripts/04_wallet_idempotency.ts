// Step (a): prove getOrCreateUserWallet() is idempotent -- same email
// in twice returns the exact same wallet id + implicit account id, a
// different email gets a genuinely different wallet.
import { getOrCreateUserWallet } from "../lib/walletService.js";

const EMAIL_A = process.env.PRIVY_E2E_EMAIL_A ?? "praetorial-e2e+wallet-user-a@example.com";
const EMAIL_B = process.env.PRIVY_E2E_EMAIL_B ?? "praetorial-e2e+wallet-user-b@example.com";

async function main() {
  console.log(`first call for ${EMAIL_A} (expect created:true, a fresh Privy user+wallet)...`);
  const first = await getOrCreateUserWallet(EMAIL_A);
  console.log(JSON.stringify(first, null, 2));

  console.log(`second call for ${EMAIL_A} (expect created:false, SAME wallet/account ids, no Privy call)...`);
  const second = await getOrCreateUserWallet(EMAIL_A);
  console.log(JSON.stringify(second, null, 2));

  const sameWallet = first.row.walletId === second.row.walletId;
  const sameAccount = first.row.implicitAccountId === second.row.implicitAccountId;
  const secondWasIdempotent = second.created === false;

  console.log(`\ncall for a DIFFERENT email ${EMAIL_B} (expect a genuinely different wallet)...`);
  const otherUser = await getOrCreateUserWallet(EMAIL_B);
  const differentFromA = otherUser.row.walletId !== first.row.walletId;

  const result = {
    step: "wallet_idempotency",
    emailA: EMAIL_A,
    firstCall: { created: first.created, walletId: first.row.walletId, accountId: first.row.implicitAccountId },
    secondCall: { created: second.created, walletId: second.row.walletId, accountId: second.row.implicitAccountId },
    sameWalletAcrossCalls: sameWallet,
    sameAccountAcrossCalls: sameAccount,
    secondCallWasIdempotentHit: secondWasIdempotent,
    emailB: EMAIL_B,
    otherUserWalletId: otherUser.row.walletId,
    otherUserIsDifferentWallet: differentFromA,
    pass: sameWallet && sameAccount && secondWasIdempotent && differentFromA,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) {
    console.error("IDEMPOTENCY TEST FAILED");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL:", err?.body ?? err);
  process.exit(1);
});
