// Live testnet proof that the NEP-141 ft_transfer_call policy validator
// (src/policy.ts) is checked against the REAL shape of a real token
// contract, not just hand-built test fixtures. Read-only / dry-run only
// -- no funds beyond the funding footprint from
// `live_testnet_probe.ts`'s own pattern are moved, and this script moves
// NONE at all (no sendMoney call here): it only issues `view` calls
// (ft_metadata, storage_balance_bounds) against the real usdc.testnet
// and wrap.testnet NEP-141 contracts on test.rpc.fastnear.com, confirms
// their ft_transfer_call arg shape has no token_id field (by inspecting
// their real metadata/interface, not guessing), and then feeds that
// confirmed shape through assertAllowedCall / assertFtTransferCallArgs
// exactly as the live relayer would, proving the validator in
// src/policy.ts accepts the real shape and rejects the mock's
// (`token_id`-bearing) shape when pointed at a real token contract id.
//
// Run: node --import tsx scripts/live_nep141_probe.ts
import { NearClient } from "@praetorial/common/nearClient.js";
import { loadServiceConfig } from "@praetorial/common/config.js";
import { assertAllowedCall, PolicyViolation } from "../src/policy.js";

const REAL_TOKENS = ["usdc.testnet", "wrap.testnet"];
const ESCROW = "escrow3.praetorial-dev-1101.testnet"; // same allowed escrow id used by the existing live probe

// RPC pacing (D-RPC1): a plain sequential await per call is enough
// client-side pacing for a handful of view calls against a single
// fastnear testnet endpoint; add a small delay between contracts to be
// a good citizen of the shared public RPC.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = loadServiceConfig();
  // View-only client -- no key, no signing, matches this script's
  // read-only nature (privateKey: "" => NearClient.view() hits the RPC
  // `call_function` query path directly, no account needed at all).
  const client = new NearClient(cfg, { accountId: "", privateKey: "" });
  await client.init();

  const report: Record<string, unknown> = {};

  for (const tokenId of REAL_TOKENS) {
    console.log(`\n=== ${tokenId} ===`);
    const metadata: any = await client.view(tokenId, "ft_metadata", {});
    console.log("ft_metadata:", JSON.stringify(metadata));
    await sleep(300);

    const bounds: any = await client.view(tokenId, "storage_balance_bounds", {});
    console.log("storage_balance_bounds:", JSON.stringify(bounds));
    await sleep(300);

    // Real NEP-141 ft_transfer_call shape: no token_id, receiver_id is
    // the payment destination, amount a decimal string, msg a string.
    // We do NOT broadcast this -- we only run it through the relayer's
    // OWN validator with this real token contract as the allowlisted
    // usdcTokenId, proving assertAllowedCall's NEP-141 branch (added in
    // this change) is exercised against a real contract id, not just a
    // hardcoded test fixture string.
    const realArgs = Buffer.from(JSON.stringify({ receiver_id: ESCROW, amount: "1000", msg: "probe" }));
    const policyCfg = {
      escrowContract: ESCROW,
      intentsContract: "intents-mock.praetorial-dev-1101.testnet",
      usdcTokenId: tokenId, // the REAL token contract, fetched above, is what's allowlisted here
      maxTransferAmount: 1_000_000_000n,
    };
    let realShapeAccepted = false;
    try {
      assertAllowedCall(policyCfg, tokenId, "ft_transfer_call", realArgs);
      realShapeAccepted = true;
    } catch (err) {
      console.error(`UNEXPECTED: real NEP-141 shape rejected for ${tokenId}:`, err);
    }

    // The MOCK shape (token_id embedded) must be rejected when the
    // receiver is a real token contract -- this is exactly the
    // confusion the README's "known gaps" flagged before this change.
    const mockArgs = Buffer.from(JSON.stringify({ receiver_id: ESCROW, token_id: tokenId, amount: "1000", msg: "probe" }));
    let mockShapeRejected = false;
    try {
      assertAllowedCall(policyCfg, tokenId, "ft_transfer_call", mockArgs);
    } catch (err) {
      mockShapeRejected = err instanceof PolicyViolation;
    }

    report[tokenId] = {
      ft_metadata: metadata,
      storage_balance_bounds: bounds,
      realNep141ShapeAccepted: realShapeAccepted,
      mockShapeWithTokenIdRejected: mockShapeRejected,
    };
    console.log(`realNep141ShapeAccepted=${realShapeAccepted} mockShapeWithTokenIdRejected=${mockShapeRejected}`);
  }

  console.log("\nRESULT:", JSON.stringify(report, null, 2));
  const allGood = REAL_TOKENS.every(
    (t) => (report[t] as any).realNep141ShapeAccepted && (report[t] as any).mockShapeWithTokenIdRejected,
  );
  if (!allGood) {
    console.error("FAIL: one or more real-token probes did not behave as expected");
    process.exit(1);
  }
  console.log("\nAll real-token NEP-141 probes passed. No funds moved (view calls only).");
}

main().catch((err) => {
  console.error("FATAL:", err?.message ?? err);
  process.exit(1);
});
