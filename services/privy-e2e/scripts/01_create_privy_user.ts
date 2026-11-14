// Step 1-2 of the task: create a real Privy test user (server-side,
// REST API) with a NEAR wallet, and record the wallet id + implicit
// account id. Never uses familiarcow's real email -- a placeholder alias
// under a domain we don't control any mailbox for, clearly a test fixture.
import fs from "node:fs";
import { createUserWithNearWallet, getUser } from "../lib/privy.js";
import { implicitAccountIdFromPublicKeyHex } from "../lib/nearRaw.js";

const TEST_EMAIL = process.env.PRIVY_E2E_EMAIL ?? "praetorial-e2e+privy-near-1@example.com";
const OUT = "./data/privy_user.json";

async function main() {
  console.log(`creating Privy user ${TEST_EMAIL} with an inline NEAR wallet...`);
  let user;
  try {
    user = await createUserWithNearWallet(TEST_EMAIL);
  } catch (err: any) {
    console.error("createUserWithNearWallet FAILED:", err.message);
    fs.mkdirSync("./data", { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ step: "create_user", ok: false, error: err.message, status: err.status, body: err.body }, null, 2));
    process.exit(1);
  }
  console.log("user created:", user.id);
  const nearWallet = (user.linked_accounts ?? []).find((a: any) => a.type === "wallet" && a.chain_type === "near") ?? (user.wallets ?? []).find((w: any) => w.chain_type === "near");
  if (!nearWallet) {
    console.error("no near wallet found on created user; full user object:", JSON.stringify(user, null, 2));
    process.exit(1);
  }
  const address: string = nearWallet.address ?? nearWallet.wallet_address;
  const walletId: string = nearWallet.id ?? nearWallet.wallet_id;
  let implicitAccountId: string;
  try {
    implicitAccountId = implicitAccountIdFromPublicKeyHex(address);
  } catch {
    implicitAccountId = address; // fall back to whatever Privy returned verbatim
  }
  const record = {
    step: "create_user",
    ok: true,
    privyUserId: user.id,
    email: TEST_EMAIL,
    walletId,
    address,
    implicitAccountId,
    rawLinkedAccount: nearWallet,
  };
  fs.mkdirSync("./data", { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record, null, 2));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
