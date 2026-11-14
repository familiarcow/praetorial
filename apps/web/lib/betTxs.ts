// V1 (familiarcow 2026-11-11: "We should be able to verify the results of every action"): the read side of the bet's on-chain record.
//  - fetchBetTxs: every action of one bet with its tx hash, signer, who acted and the exact amounts (the indexer's GET /bet/txs,
//    built by services/common/src/betTxIndex.ts from the escrow's public tx history). Null = not available (indexer down or not
//    deployed with V1 yet): the Verify sheets say so and link to the escrow's explorer page instead.
//  - fetchChainFacts: what the escrow itself says (resolver_keys, outlayer_config, code hash, access keys) + the exact get_bet text.
// Read-only: indexer GET and RPC views. No keys, no transactions.
import { INDEXER_URL, ESCROW_CONTRACT_ID } from "./config";
import { requireService } from "./network";
import { viewFunctionText, viewAccountLock } from "./rpc";

/** Mirrors services/common/src/betTxIndex.ts BetTx exactly. */
export type BetTxKind =
  | "create" | "take" | "cancel" | "expire" | "reclaim" | "referee-change" | "request-result" | "ruling" | "challenge"
  | "objection" | "evidence" | "concede" | "referee-rule" | "finalize" | "payout" | "refund" | "amend" | "extend-window" | "prune";
export interface BetTxMove { account: string; token: string; amount: string }
export interface BetTx {
  bet_id: number; hash: string; at_ns: string; kind: BetTxKind; method: string; signer: string; actor: string; ok: boolean;
  moved_in: BetTxMove[]; moved_out: BetTxMove[]; outcome?: string; run_no?: number; round?: number;
  signed?: { result_json: string; signature_hex: string }; program?: { wasm_hash: string; url: string };
}

export async function fetchBetTxs(betId: number, contractId: string = ESCROW_CONTRACT_ID): Promise<BetTx[] | null> {
  try {
    const base = requireService("indexer", INDEXER_URL);
    const r = await fetch(`${base}/bet/txs?bet_id=${betId}&contract_id=${encodeURIComponent(contractId)}`);
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) ? (j as BetTx[]) : null;
  } catch { return null; }
}

export interface ChainFacts {
  outcomeKey: string; attestKey: string; wasmHash: string; wasmBaseUrl: string;
  codeHashB58: string | null; accessKeys: number | null;
  /** The exact get_bet view text (u64 digits intact) for the verification file. */
  betText: string | null;
  judgeChain: { model_a: string; model_b: string }[] | null;
}

export async function fetchChainFacts(betId: number, contractId: string = ESCROW_CONTRACT_ID): Promise<ChainFacts> {
  const [keysT, olcT, betText, chainT, lock] = await Promise.all([
    viewFunctionText(contractId, "resolver_keys"),
    viewFunctionText(contractId, "outlayer_config"),
    viewFunctionText(contractId, "get_bet", { bet_id: betId }).catch(() => null),
    viewFunctionText(contractId, "judge_chain").catch(() => null),
    viewAccountLock(contractId).catch(() => null),
  ]);
  const keys = JSON.parse(keysT) as string[];
  const olc = JSON.parse(olcT) as { wasm_base_url: string };
  return {
    outcomeKey: keys[0], attestKey: keys[1], wasmHash: keys[2], wasmBaseUrl: olc.wasm_base_url,
    codeHashB58: lock?.codeHashB58 ?? null, accessKeys: lock ? lock.accessKeys : null, betText,
    judgeChain: chainT ? (JSON.parse(chainT) as ChainFacts["judgeChain"]) : null,
  };
}
