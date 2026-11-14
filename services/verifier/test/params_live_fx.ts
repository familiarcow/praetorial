// PA1b: grafts a synthetic-but-realistic PA1 params history (+ the three PA1 views) onto the RECORDED R3e live fixture, so the
// live path (collectLive -> history -> E2) is exercised offline. Shapes: indexer receipt = test/fixtures/v1c/r3e_live_rpc.json;
// event lines = the contract's emit code (same format as test/fixtures/pa1b/build.mjs).
import { editCallArgs, ESCROW } from "./live_replay.js";

export const DAY = 86_400_000_000_000n;
export const T = 1794100000000000000n; // after every recorded R3e tx
export const USDC = "nep141:usdc.testnet";
export interface PChange { fee_bps: number | null; assets: { asset_id: string; min_fee_per_side: string | null; min_per_side: string | null; max_per_side: string | null }[] }
const f = (v: string | null) => (v === null ? "null" : `"${v}"`);
export const eventLine = (ev: string, c: PChange, proposed: bigint, effective: bigint) =>
  `EVENT_JSON:{"standard":"praetorial-escrow","version":"1.0.0","event":"${ev}","data":[{"fee_bps":${c.fee_bps ?? "null"},"assets":[${c.assets.map((a) => `{"asset_id":"${a.asset_id}","min_fee_per_side":${f(a.min_fee_per_side)},"min_per_side":${f(a.min_per_side)},"max_per_side":${f(a.max_per_side)}}`).join(",")}],"proposed_at_ns":${proposed},"effective_at_ns":${effective}}]}`;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const viewResult = (text: string) => ({ block_hash: "x", block_height: 1, logs: [], result: Array.from(Buffer.from(text)) });

export function addTx(fx: any, name: string, method: string, atNs: bigint, logs: string[], ok = true) {
  fx.transactions[name] = {
    transaction: { hash: name, actions: [{ FunctionCall: { method_name: method, args: b64({}), gas: 1, deposit: "0" } }] },
    receipts: [{
      execution_outcome: { block_timestamp: atNs.toString(), outcome: { logs, status: ok ? { SuccessValue: "" } : { Failure: {} } } },
      receipt: { receiver_id: ESCROW, predecessor_id: "guardian.testnet", receipt_id: `r-${name}`, receipt: { Action: { actions: [{ FunctionCall: { method_name: method, args: b64({}), gas: 1, deposit: "0" } }] } } },
    }],
  };
  fx.accountTxs.push({ transaction_hash: name, tx_block_timestamp: atNs.toString() });
}

/** Upgrades the recorded R3e new() args to PA1-era (min fee + cap per asset) and grafts: propose fee 150 + usdc limits at T, apply at T+24h+1s. */
export function graftParams(fx: any, o: { applyDelayNs?: bigint; viewFee?: number; skipApply?: boolean } = {}) {
  editCallArgs(fx, "new", (a) => {
    for (const [id, l] of a.asset_limits) { l.min_fee_per_side = id === USDC ? "1" : "1"; l.min_fee_cap_per_side = id === USDC ? "2500000" : "0"; }
  });
  const change: PChange = { fee_bps: 150, assets: [{ asset_id: USDC, min_fee_per_side: "250000", min_per_side: "20000000", max_per_side: "250000000" }] };
  const eff = T + DAY;
  addTx(fx, "PA1bProposeTx", "propose_params", T, [eventLine("params_proposed", change, T, eff)]);
  if (!o.skipApply) addTx(fx, "PA1bApplyTx", "apply_params", eff + (o.applyDelayNs ?? 1_000_000_000n), [eventLine("params_applied", change, T, eff)]);
  const lim = (min: string, max: string, fee: string, cap: string) => ({ min_per_side: min, max_per_side: max, min_fee_per_side: fee, min_fee_cap_per_side: cap, run_price: "5000", min_bond: "5000000", min_objection: "1000000" });
  const args = JSON.parse(Buffer.from(Object.values<any>(fx.transactions).flatMap((t) => t.transaction.actions ?? []).find((a: any) => a.FunctionCall?.method_name === "new").FunctionCall.args, "base64").toString());
  const btc = args.asset_limits.find((x: any) => x[0] === "nep141:btc.mock.testnet")[1];
  fx.rpc["call_function|protocol_fee_bps|{}"] = viewResult(String(o.viewFee ?? 150));
  fx.rpc[`call_function|asset_limit|{"asset_id":"${USDC}"}`] = viewResult(JSON.stringify(lim("20000000", "250000000", "250000", "2500000")));
  fx.rpc[`call_function|asset_limit|{"asset_id":"nep141:btc.mock.testnet"}`] = viewResult(JSON.stringify(lim(btc.min_per_side, btc.max_per_side, "1", "1")));
  fx.rpc["call_function|pending_params|{}"] = viewResult("null");
  return change;
}
