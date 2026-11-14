// Step (c): what happens to a NEAR implicit account before it's ever
// funded, what the first deposit actually does onchain, and what the
// real storage/gas minimums are. Uses throwaway ed25519 keys (NOT
// Privy wallets) for the amount-threshold probes below, purely because
// this is testing NEAR PROTOCOL behavior (implicit-account creation
// semantics), identical for a Privy-held key or a software one, and
// doing it with disposable keys avoids burning Privy API wallet
// quota for a non-Privy-specific question. Wallet B (a real Privy
// wallet, still unfunded from script 04) is used for the one
// Privy-specific before/after check at the end.
import fs from "node:fs";
import nacl from "tweetnacl";
import { provider, withRetry } from "../lib/rpc.js";
import { LocalSigner, loadKeyFile } from "../lib/localSigner.js";
import { FUNDER_ID, CRED_DIR } from "../lib/config.js";
import { findByEmail } from "../lib/walletStore.js";

const EMAIL_B = process.env.PRIVY_E2E_EMAIL_B ?? "praetorial-e2e+wallet-user-b@example.com";

async function viewAccountSafe(accountId: string): Promise<{ exists: boolean; detail: any }> {
  const p = provider();
  try {
    const res = await withRetry(() => p.query({ request_type: "view_account", account_id: accountId, finality: "final" } as any), `view_account(${accountId})`, 3);
    return { exists: true, detail: res };
  } catch (err: any) {
    return { exists: false, detail: String(err?.message ?? err) };
  }
}

async function viewAccessKeyListSafe(accountId: string): Promise<{ hasKeys: boolean; detail: any }> {
  const p = provider();
  try {
    const res: any = await withRetry(() => p.query({ request_type: "view_access_key_list", account_id: accountId, finality: "final" } as any), `view_access_key_list(${accountId})`, 3);
    return { hasKeys: (res.keys ?? []).length > 0, detail: res };
  } catch (err: any) {
    return { hasKeys: false, detail: String(err?.message ?? err) };
  }
}

async function main() {
  const funderKey = loadKeyFile(`${CRED_DIR}/${FUNDER_ID}.json`);
  const funder = new LocalSigner(FUNDER_ID, funderKey.private_key);
  await funder.init();

  const probes = [
    { label: "1 yoctoNEAR", amount: 1n },
    { label: "0.000001 NEAR (1e18 yocto)", amount: 1_000_000_000_000_000_000n },
    { label: "0.001 NEAR (1e21 yocto)", amount: 1_000_000_000_000_000_000_000n },
    { label: "0.01 NEAR (1e22 yocto)", amount: 10_000_000_000_000_000_000_000n },
  ];

  const probeResults: any[] = [];
  for (const probe of probes) {
    const kp = nacl.sign.keyPair();
    const accountId = Buffer.from(kp.publicKey).toString("hex");
    const before = await viewAccountSafe(accountId);
    let fundTxHash: string | undefined;
    let fundError: string | undefined;
    try {
      const res: any = await funder.sendNear(accountId, probe.amount);
      fundTxHash = res?.transaction?.hash;
    } catch (err: any) {
      fundError = String(err?.message ?? err);
    }
    await new Promise((r) => setTimeout(r, 1500));
    const after = await viewAccountSafe(accountId);
    const keys = after.exists ? await viewAccessKeyListSafe(accountId) : { hasKeys: false, detail: "n/a (account does not exist)" };
    probeResults.push({
      probe: probe.label,
      amountYocto: probe.amount.toString(),
      accountId,
      existedBefore: before.exists,
      fundTxHash,
      fundError,
      existsAfter: after.exists,
      balanceAfter: after.exists ? after.detail.amount : null,
      hasFullAccessKeyAfter: keys.hasKeys,
      accessKeyDetail: keys.hasKeys ? keys.detail.keys?.[0]?.access_key?.permission : null,
    });
    console.log(`[${probe.label}] existedBefore=${before.exists} fundTxHash=${fundTxHash ?? "(none)"} fundError=${fundError ?? "(none)"} existsAfter=${after.exists} hasFullAccessKey=${keys.hasKeys}`);
  }

  // Privy-specific before/after: wallet B, created in script 04 but
  // never funded -- confirm it genuinely does not exist onchain yet.
  const rowB = findByEmail(EMAIL_B);
  let privyBefore: any = null;
  if (rowB) {
    privyBefore = await viewAccountSafe(rowB.implicitAccountId);
    console.log(`\nPrivy wallet B (${rowB.implicitAccountId}) before any funding: exists=${privyBefore.exists}`);
  }

  const record = { step: "account_lifecycle", probes: probeResults, privyWalletBAccountId: rowB?.implicitAccountId, privyWalletBExistedBeforeFunding: privyBefore?.exists ?? null };
  fs.writeFileSync("./data/account_lifecycle.json", JSON.stringify(record, null, 2));
  console.log("\n" + JSON.stringify(record, null, 2));
}

main().catch((err) => {
  console.error("FATAL:", err?.body ?? err);
  process.exit(1);
});
