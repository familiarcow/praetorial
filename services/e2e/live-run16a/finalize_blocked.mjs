import { mk, balance } from "./lib.mjs";
const { load, save } = mk("results.json");
const ESC = "praetorial-e2e-2611052236.praetorial-dev-1101.testnet";
const r = load();
r.status = "BLOCKED-ON-PM";
r.blocker = {
  step: "16a(3) delete account",
  error: "DeleteAccountWithLargeState (NEAR protocol refuses DeleteAccount when the account's contract state exceeds 10,000 bytes)",
  measured_state_bytes: 12356, state_keys: 20, limit_bytes: 10000, over_by_bytes: 2356,
  attempts: 2, failed_delete_tx_ids: ["3PXEfgcHGGJ1yuxv3MkKuRXkBmWVDjxnwnDe7ojMPmZ2"],
  effect: "account NOT deleted; still holds old wasm 692b24fd..8006; only gas burned (~0.0256 NEAR per attempt)",
  why_no_workaround_inside_scope: "the escrow has no method that removes bets/payouts/asset-limit state; main's wasm cannot be re-init'd over existing state (new() is #[init]); clearing state needs new contract code or a throwaway wipe-wasm = a migration, which D-E2E1/item 16 forbids improvising",
  options: [
    "A (recommended): deploy a throwaway 'wipe' wasm (a few lines: storage_clear/storage_remove over the 20 known keys behind a method only the account itself can call) to the account, call it, then delete + recreate as planned. Needs PM approval: new non-escrow code and a deploy over the item-8 account; testnet only, no escrow contract change.",
    "B: drop the same-name requirement: create a NEW sub-account (praetorial-e2e-<ts>.praetorial-dev-1101.testnet) and deploy there, leaving the item-8 escrow as is. Budget problem: dev holds only ~0.94 tNEAR and the old escrow's 6.47 stays locked, so it needs a PM-granted top-up (faucet/top-up currently forbidden).",
    "C: add a guardian-gated state-purge method to the escrow contract (TDD'd contract change). Not recommended: extra attack surface in a contract headed to mainnet, for a testnet convenience.",
  ],
};
r.balances = r.balances ?? {};
r.balances.dev_now = await balance("praetorial-dev-1101.testnet"); r.balances.escrow_now = await balance(ESC);
save(r); console.log(JSON.stringify(r.balances));
