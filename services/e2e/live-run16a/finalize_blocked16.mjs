// Records the BLOCKED-ON-PM finding + balances into live-run16/results.json (read-only RPC).
import { balance, mk } from "./lib.mjs";
const { load, save } = mk("../live-run16/results.json");
const r = load();
r.item = 16; r.status = "BLOCKED-ON-PM: OutLayer request_execution rejects escrow args";
r.finding = {
  request_resolution_tx: "6U8HN1hWiESqhfVgZFna3MMCHcVMYB438EoLu9jCnKEJ (escrow-side Success; cross-contract call to outlayer.testnet FAILED)",
  outlayer_error: "Smart contract panicked: Failed to deserialize input from JSON. Error: `missing field `source` at line 1 column 12229`",
  consequence: "on_resolution recorded {\"error\":\"outlayer_call_failed\"}; compute deposit returned to keeper_credit (150000000000000000000000 yocto intact); bet 1 stays Resolving until resolve deadline / void path; no AI judge run, no outcome, no payout. GATE-04 NOT closed.",
  cause_hypothesis: "live outlayer.testnet request_execution now requires a `source` field in its args; escrow's request_execution payload (contracts/escrow/src/lib.rs, written against the older OutLayer API / mock-outlayer) omits it. Not verified against OutLayer docs/ABI in this run.",
  options: ["A (rec): escrow-code change on a new feat/ branch: add `source` per current OutLayer ABI (inspect outlayer.testnet ABI/docs first), update mock-outlayer + tests, then redeploy via the same wipe/delete path (needs another ~6 tNEAR cycle: escrow holds ~6.1 tNEAR) ", "B: try an existing contract-side knob if OutlayerConfig already exposes the source shape (it does not: only wasm_base_url/secrets_profile/secrets_account_id)", "C: have keeper call outlayer directly (off-contract) -- breaks the on_resolution trust path; not recommended"],
  not_changed: "no escrow contract code changed (scope rule)",
};
r.balances_after = { dev: await balance("praetorial-dev-1101.testnet"), escrow: await balance("praetorial-e2e-2611052236.praetorial-dev-1101.testnet"), keeper: await balance("keeper.praetorial-dev-1101.testnet"), attest1: await balance("attest1.praetorial-dev-1101.testnet") };
save(r); console.log(JSON.stringify(r.balances_after));
