// Step 3: fund the Privy implicit account with native NEAR (gas) from
// the funder, and mint it a USDC balance in mock-intents (the testnet
// faucet stand-in for a real USDC deposit) so it can open a bet.
import fs from "node:fs";
import { LocalSigner, loadKeyFile } from "../lib/localSigner.js";
import { FUNDER_ID, CRED_DIR, INTENTS, USDC } from "../lib/config.js";
import { viewFunction } from "../lib/rpc.js";

const FUND_AMOUNT_YOCTO = 300_000_000_000_000_000_000_000n; // 0.3 NEAR, gas only
const MINT_AMOUNT = 50_000_000n; // 50 USDC @ 6dp -- plenty for a 1 USDC-ish stake + reserve + storage

async function main() {
  const user = JSON.parse(fs.readFileSync("./data/privy_user.json", "utf8"));
  const accountId: string = user.implicitAccountId;

  const funderKey = loadKeyFile(`${CRED_DIR}/${FUNDER_ID}.json`);
  const funder = new LocalSigner(FUNDER_ID, funderKey.private_key);
  await funder.init();

  console.log(`funding ${accountId} with ${FUND_AMOUNT_YOCTO} yoctoNEAR (0.3 NEAR) from ${FUNDER_ID}...`);
  const fundResult: any = await funder.sendNear(accountId, FUND_AMOUNT_YOCTO);
  const fundTxHash = fundResult?.transaction?.hash;
  console.log("funding tx:", fundTxHash);

  console.log(`minting ${MINT_AMOUNT} USDC (6dp) to ${accountId} in mock-intents (${INTENTS})...`);
  const mintResult: any = await funder.call(INTENTS, "mint", { account_id: accountId, token_id: USDC, amount: MINT_AMOUNT.toString() }, 30);
  const mintTxHash = mintResult?.transaction?.hash;
  console.log("mint tx:", mintTxHash);

  const usdcBalance = await viewFunction<string>(INTENTS, "mt_balance_of", { account_id: accountId, token_id: USDC });

  const record = {
    step: "fund_and_mint",
    ok: true,
    accountId,
    fundTxHash,
    fundAmountYocto: FUND_AMOUNT_YOCTO.toString(),
    mintTxHash,
    mintAmountUsdc6dp: MINT_AMOUNT.toString(),
    usdcBalanceAfterMint: usdcBalance,
  };
  fs.writeFileSync("./data/fund_and_mint.json", JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record, null, 2));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
