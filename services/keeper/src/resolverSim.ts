// TESTNET-ONLY. Stands in for OutLayer actually judging + signing a
// result (see common/src/resolverSign.ts doc comment for the full
// rationale). Reads a forced outcome from a local decisions file keyed
// by bet_id (defaults to "YES" if unspecified) purely so the E2E run is
// deterministic and inspectable; a real deployment deletes this module
// and relies on OutLayer's own TEE signature instead.
import fs from "node:fs";
import type { NearClient } from "@praetorial/common/nearClient.js";
import type { Bet, SubmittedResult } from "@praetorial/common/types.js";
import { signOutcome, type ResolverKeypair } from "@praetorial/common/resolverSign.js";

export interface ResolverDecisions {
  [bet_id: string]: "YES" | "NO" | "VOID";
}

export function loadDecisions(path: string | undefined): ResolverDecisions {
  if (!path || !fs.existsSync(path)) return {};
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

/** Submits a signed outcome for a bet sitting in Resolving with no
 * outcome yet. Returns the tx hash, or null if nothing to do. */
export async function maybeSubmitOutcome(
  client: NearClient,
  escrowContract: string,
  betId: number,
  bet: Bet,
  keypair: ResolverKeypair,
  decisions: ResolverDecisions,
): Promise<{ submitted: boolean; result?: SubmittedResult }> {
  // D3 (D-AUDIT3, 2026-11-02): widened from Taken|Resolving so this
  // simulator can exercise a re-judge round end to end -- after a
  // challenge (Challenged) or an Evidence-round escalation, a fresh
  // `request_resolution` moves the bet back through Resolving, but a
  // test/simulation driving the ENTIRE challenge->evidence->re-judge
  // path needs to be able to submit an outcome while the bet still
  // reads as Challenged/Evidence between steps too (the contract
  // itself gates the real admission; this guard only decides whether
  // the simulator bothers trying).
  const resolvableStatuses = ["Taken", "Resolving", "Challenged", "Evidence"];
  if (!resolvableStatuses.includes(bet.status)) return { submitted: false };
  if (bet.outcome !== null) return { submitted: false };
  // D-KEY1: the trusted key is the contract's own pinned resolver_keys()
  // view (outcome_pubkey), never a bet envelope field -- Envelope no
  // longer carries resolver_pubkey at all (see contracts/escrow/src/lib.rs).
  const [outcomePubkey] = await client.view<[string, string, string]>(escrowContract, "resolver_keys", {});
  if (outcomePubkey !== keypair.publicKeyHex) return { submitted: false };

  const outcome = decisions[String(betId)] ?? "YES";
  // SEAM FIX (Seam audit v1, 2026-11-02): this used to be `bet.runs_used`,
  // which starts at 0 while the contract's `next_expected_run_no` inits
  // to 1 and requires `result.run_no == bet.next_expected_run_no`
  // (contracts/escrow/src/lib.rs submit_outcome, I-7/FM-13 strict run
  // order). `runs_used` only reaches the right value by coincidence on a
  // bet's second submission onward; the very first `submit_outcome` call
  // from this simulator always sent run_no=0 and was rejected with "run_no
  // out of order". `next_expected_run_no` is the field the contract
  // actually checks against and is already on the Bet view
  // (services/common/src/types.ts) -- use it directly, no derivation.
  const runNo = bet.next_expected_run_no;
  const result: SubmittedResult = {
    bet_id: betId,
    terms_hash: bet.envelope.terms_hash,
    outcome,
    element_results_hash: "0".repeat(64),
    run_no: runNo,
    // String, not a JS number -- see types.ts doc on checked_until.
    checked_until: (BigInt(Date.now()) * 1_000_000n).toString(),
    judge_pair_index: 0, // JC1s: signed judge pair (the sim's single pair)
  };
  const sig = signOutcome(escrowContract, result, keypair.secretKey);
  await client.call(escrowContract, "submit_outcome", { result, signature_hex: sig }, 60);
  return { submitted: true, result };
}
