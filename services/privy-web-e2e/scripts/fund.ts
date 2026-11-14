// Step 3 (standalone): fund a NEAR implicit account from the
// Praetorial funder, at most 0.5 NEAR (task's hard cap; we send 0.3).
// Usage: node --import tsx scripts/fund.ts <implicitAccountId>
import fs from "node:fs";
import { LocalSigner, loadKeyFile } from "../lib/localSigner.js";
import { FUNDER_ID, CRED_DIR, FUND_AMOUNT_YOCTO, MAX_FUND_YOCTO } from "../lib/config.js";
import { viewAccountExists, viewAccountBalanceYocto } from "../lib/rpc.js";

// Idempotent on purpose: the funder is a SHARED testnet account used
// across this whole repo's test suites, and this script is called on
// every `npm run e2e` run. Re-sending 0.3 NEAR every single run would
// drain it fast for no reason -- if the account already has enough to
// pay gas for this harness's one small transfer-back test, skip.
const ALREADY_FUNDED_THRESHOLD_YOCTO = 50_000_000_000_000_000_000_000n; // 0.05 NEAR

async function main() {
  const accountId = process.argv[2];
  if (!accountId) throw new Error("usage: fund.ts <implicitAccountId>");
  if (!/^[0-9a-f]{64}$/.test(accountId)) throw new Error(`not a NEAR implicit account id: ${accountId}`);
  if (FUND_AMOUNT_YOCTO > MAX_FUND_YOCTO) throw new Error("refusing: FUND_AMOUNT_YOCTO exceeds the 0.5 NEAR task cap");

  const existedBefore = await viewAccountExists(accountId);
  const balanceBefore = await viewAccountBalanceYocto(accountId);

  if (balanceBefore !== null && balanceBefore >= ALREADY_FUNDED_THRESHOLD_YOCTO) {
    console.log(`${accountId} already has ${balanceBefore} yoctoNEAR (>= 0.05 NEAR) -- skipping funding, not re-sending.`);
    fs.mkdirSync("./data", { recursive: true });
    fs.writeFileSync(
      "./data/fund.json",
      JSON.stringify({ accountId, existedBefore, skipped: true, balanceBeforeYocto: balanceBefore.toString(), txHash: null }, null, 2),
    );
    return;
  }

  const funderKey = loadKeyFile(`${CRED_DIR}/${FUNDER_ID}.json`);
  const funder = new LocalSigner(FUNDER_ID, funderKey.private_key);
  await funder.init();

  console.log(`funding ${accountId} with 0.3 NEAR from ${FUNDER_ID} (existed before: ${existedBefore})...`);
  const result: any = await funder.sendNear(accountId, FUND_AMOUNT_YOCTO);
  const txHash = result?.transaction?.hash;
  console.log("fund tx:", txHash);

  fs.mkdirSync("./data", { recursive: true });
  fs.writeFileSync(
    "./data/fund.json",
    JSON.stringify({ accountId, existedBefore, skipped: false, amountYocto: FUND_AMOUNT_YOCTO.toString(), txHash }, null, 2),
  );
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
