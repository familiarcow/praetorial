# RUNBOOK: a bet stuck in `Resolving` (or out of AI runs)

LIFE1, from SM1 CON-2 / CON-3 / LIFE-9 (`spikes/sm1/REPORT.md`). The escrow `bets.praetorial.near` is frozen. These states
cannot be fixed on chain; this page is what the operator does instead. Every chain step below is a **read-only RPC view**
unless it says otherwise. Never run `emergency_shutdown` without familiarcow (see "Last resort").

## How you hear about it

The monitor Worker raises (Telegram, same digest as every alert, repeated every cooldown while the condition holds):

| alert | severity | meaning |
|---|---|---|
| `bet_stuck_resolving` "…stuck in Resolving with a ruling (YES/NO/VOID) set: no permissionless exit" | CRITICAL | **CON-2.** A challenge re-judge run finished but its output can never be applied. `request_resolution`, `finalize` and `void_after_deadline` all refuse the bet. Only a party's `concede` or a contract-wide emergency shutdown moves it. |
| `bet_stuck_resolving` "…stuck in Resolving with no ruling" | WARNING | **LIFE-9 / CON-3, round 0.** The first run's output can't be applied. The keeper calls `void_after_deadline` after `resolve_deadline` and both sides get their stakes back. |
| `resolution_exhausted` | WARNING | **CON-3.** An AI bet is back in `Taken` with no result and every paid run used. Nothing can resolve it; same refund at `resolve_deadline`. |

The bet page shows the same case to both bettors in plain words ("Re-check failed" / "No result"), with what happens next and
the date of the automatic refund, so they are not left on "The AI is working out who won".

The alert fires right away when the stored output is unusable, and after 1 h for any `Resolving` bet whose run never produced
an applicable result (an OutLayer run takes minutes).

## 1. Read the bet (read-only)

```bash
BET=<id>
curl -s https://free.rpc.fastnear.com -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"bets.praetorial.near\",\"method_name\":\"get_bet\",\"args_base64\":\"$(printf '{"bet_id":%s}' $BET | base64)\"}}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(Buffer.from(JSON.parse(s).result.result).toString());
    console.log({status:b.status,outcome:b.outcome,runs:`${b.runs_used}/${b.envelope.max_paid_runs}`,bonds:b.bonds.length,pending_run_no:b.pending_run_no,
    next_check_ns:b.next_check_ns,first_unavailable_ns:b.first_unavailable_ns,retry_count:b.retry_count,resolve_deadline:new Date(b.envelope.resolve_deadline/1e6).toISOString(),
    maker:b.envelope.maker,taker:b.taker,maker_side:b.envelope.maker_side});console.log("last_resolution_raw:",b.last_resolution_raw)})'
```

## 2. Find the cause (`last_resolution_raw`)

| what the raw output looks like | cause | prevent the next one |
|---|---|---|
| `{"error":"no_live_judge_key", …}` | The resolver ran with **no `NEAR_AI_API_KEY`** bound in OutLayer (NOKEY1: it deliberately returns an unsigned error object). | Re-bind the key: `scripts/mainnet-night/40-bind-secret.sh` (RUNBOOK.md step on secrets). Every bet requested while it is missing gets stuck the same way. Check the key before anything else. |
| has `result` but `signing_error` instead of `signing` | The resolver could not sign (OutLayer signing key unavailable). | OutLayer side; escalate. |
| signed `result.outcome` = `RETRY…` with `next_check_ns` in the past | The keeper did not relay the RETRY before its `next_check_ns` (keeper down or behind). | Check the keeper heartbeat / `keeper_stall` alerts and its NEAR balance. The keeper now skips relaying a RETRY it knows is late (it would only burn gas). |
| signed `VOID:unavailable` while `first_unavailable_ns` is < 7 d old and `retry_count` < 7 | The resolver signed a VOID the recovery ladder refuses. | Resolver bug; write it up. |
| signed result whose `model_not_found[].observed_ns` is > 1 h old | Relayed too late. | As for the late RETRY. |

## 3. What to do

### No ruling set (WARNING, round 0 / runs exhausted)
Nothing on chain is needed. The keeper calls `void_after_deadline` after `resolve_deadline` (the page and the alert show the
date) and both sides get their stakes back. Optionally contact the bettors: either of them may `concede` to end it sooner (the
other side is then paid as the winner).

### Ruling set (CRITICAL, CON-2): no permissionless exit
1. Fix the cause (step 2) so no other bet gets stuck.
2. Contact both bettors. The clean way out is **`concede` by the side the standing ruling went against**: the contract then pays
   out exactly the standing ruling and returns **every** challenge bond and objection deposit (`concede_bond_refund`,
   `concede_objection_refund`). That is the same money result as a finalize in which the challenger's bond was refunded instead
   of forfeited. The bet page tells that side this in plain words, and the Concede button is already offered on a Resolving bet.
   If the standing ruling is VOID, either side conceding hands the pot to the other side, so agree it with both bettors first.
3. If nobody concedes, the money stays locked. There is no other per-bet exit in the frozen contract.

### Last resort (familiarcow only)
`emergency_shutdown` (guardian `praetorial.near`) is **contract-wide and irreversible**: every open bet is then refunded with
`emergency_refund` (permissionless; the keeper sends it for every non-final bet) and no new bets can ever be made on this
contract. RUNBOOK.md: "Never run `emergency_shutdown` on mainnet." Only familiarcow decides this, and only if the locked amount
justifies ending the whole contract.

## 4. Why the resolver is not changed

SM1 asked for the resolver to "never return an unsigned object: map every failure to a signed RETRY or VOID (or null)". On a
failed promise or a `null` output the contract restores the prior status and the bet can be requested again (D-RESOLVE4a), which
would turn the NOKEY1 case into a plain retry. That is a resolver code change, which changes the wasm whose hash
(`8791413f…`) is pinned on chain in `resolver_wasm_hash`. The LIFE1 rules forbid landing it, so it is written up here and not
done:

- `resolver/wasm-bin/src/main.rs` `envelope_output_at_with`: return `Value::Null` instead of `no_key_refusal()` when the judge key
  is missing, and return `Value::Null` instead of an object carrying `signing_error` when signing fails.
- It cannot reach this escrow at all: `resolver_wasm_hash` and the resolver signing keys tied to it (`outcome_pubkey`) are set
  once at `new()` and are "never changeable by the guardian or anyone else -- only redeploy/upgrade swaps them" (lib.rs,
  D-KEY1). The contract is frozen, so the change only makes sense for a future escrow deployment.

Off-chain mitigations that are in place instead (LIFE1):
- the keeper does not relay a signed result `submit_outcome` would refuse (late RETRY, stale observation, early VOID:unavailable),
  and backs off any refused action instead of resending it every minute;
- the keeper asks for the challenge re-judge itself (SM1 #1), so a challenged ruling is no longer left until `resolve_deadline`;
- the monitor raises the alerts above;
- the bet page explains each case.
