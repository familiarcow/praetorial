import { balance, results, save } from "./lib.mjs";
const r = results(); if (r.finalized) { console.log("already finalized"); process.exit(0); }
const add = (step, hash, note) => r.txs.unshift({ step, hash, url: `https://testnet.nearblocks.io/txns/${hash}`, note });
add("fastfs_upload_chunk3", "3PG3vpmzCM9RhJiakwcmBrUzcWTU9gLyGE45NFS6SaAd");
add("fastfs_upload_chunk2", "8x1hNTGm2ZKvwwZTHnZznqn9BisAw55Tp5b4zgvdbdLX");
add("fastfs_upload_chunk1", "4QTVz72jrrzbkUn1g2aixdb5piJF2QB7U9YdzedQmvqf", "resolver wasm cd853f8f..19d7 uploaded; pinned = fastfs url + sha256 in escrow new()");
r.txs.push({ step: "report_pubkey_FROM_escrow (the one that returned keys)", hash: "BCqdT9Fomqq4YHVMSnPV2WJbG1Rkd5i8xxqfkihLGwzh", url: "https://testnet.nearblocks.io/txns/BCqdT9Fomqq4YHVMSnPV2WJbG1Rkd5i8xxqfkihLGwzh" });
r.txs.push({ step: "wasted_report_pubkey_inline_input_ran_default_judge", hash: "7aPstrCzoC8pSyFkL92KWaYVir4xRVMes2rxPPJeE4qG", url: "https://testnet.nearblocks.io/txns/7aPstrCzoC8pSyFkL92KWaYVir4xRVMes2rxPPJeE4qG", note: "inline JSON arg not delivered to stdin; use --input file" });
r.txs.push({ step: "wasted_sourcecheck_from_dev1101_attest_key_5643..1e14_mismatch", hash: "4aCeS3fCH6FWxiQxqc2ZaLbFRq1fDY5Zgi9VEtYxwbap", url: "https://testnet.nearblocks.io/txns/4aCeS3fCH6FWxiQxqc2ZaLbFRq1fDY5Zgi9VEtYxwbap", note: "FINDING: attest key differs by calling account (dev1101 -> 5643..., escrow -> 861e...)" });
r.balances.parent_after = await balance("praetorial-dev-1101.testnet");
r.balances.escrow_final = await balance(r.escrow_account);
r.pubkeys = { outcome: r.outcome_pubkey, attest: r.attest_pubkey, outcome_near: "ed25519:2NQjNtxvPJqQgihzuQcsAtiTR8NELREDSjib2JEpo3Gi" };
r.not_exercised = "Judge-resolved settle NOT exercised on this deployment (Jason deadline 2028; NEAR AI spend not allowed); proven live earlier (RES-01). Both bets settled via mutual_settle 50/50 + drain_payouts.";
save(r);
console.log(JSON.stringify(r.balances), r.txs.length);
