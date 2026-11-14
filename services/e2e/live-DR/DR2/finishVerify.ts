// DR2 phase 2 when the bet is ALREADY Settled (keeper path finished it before the harness ran): verify-only.
// Run: npx tsx finishVerify.ts   (testnet, read-only: ESPN fetch + chain views + public tx indexer; no keys, no sends)
// Writes run/ground_truth.json, run/txs_bet35.json, run/money_check.json, run/bet_final.json.
import { readFileSync, writeFileSync } from "node:fs";
import { view, ESCROW, INTENTS, STAKE_TOKEN, FEE, RPC } from "./chain.js";
import { expectedDecisive, expectedVoid, paidTo, type BetView } from "./expected.js";
import { creditsFromReceipts, checkPerBetMoney } from "../harness/money.js";
import { fetchEspn, gameTruth } from "./groundTruth.js";
import { groundTruthRecord, classifyTxs, explainRuns, compareOutcome, type ChainTx } from "./verifyOnly.js";

const run = (f: string) => new URL(`./run/${f}`, import.meta.url);
const st = JSON.parse(readFileSync(run("state.json"), "utf8"));
const taken: BetView = JSON.parse(readFileSync(run("bet_taken.json"), "utf8"));
const KEEPER = "keeper.praetorial-dev-1101.testnet";

const bet = await view("get_bet", { bet_id: st.betId });
if (bet.status !== "Settled") throw new Error(`bet ${st.betId} is ${bet.status}, not Settled: use the playwright DR2_PHASE=finish path instead`);
writeFileSync(run("bet_final.json"), JSON.stringify(bet, null, 2));

// 1. ESPN truth (fetched now, i.e. AFTER the chain outcome existed: recorded as such)
const raw = await fetchEspn("basketball", "nba", st.date.replaceAll("-", ""));
const truth = gameTruth(raw, st.event_id, st.pick_abbr);
const gt = groundTruthRecord(truth, { betId: st.betId, fetchedAtIso: new Date().toISOString(), chainOutcomeAtFetch: bet.outcome, proposedAtNs: String(bet.proposed_at) });
writeFileSync(run("ground_truth.json"), JSON.stringify(gt, null, 2));
const cmp = compareOutcome(bet.outcome, truth.outcome);

// 2. tx history from the public indexer
const idx = "https://tx.test.fastnear.com";
const post = async (p: string, b: unknown) => (await fetch(idx + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json() as Promise<any>;
const acc = await post("/v0/account", { account_id: ESCROW, limit: 200 });
const since = BigInt(st.sinceNs) - 600_000_000_000n;
const hashes = [...new Set<string>((acc.account_txs as any[]).filter((r) => r.is_receiver && BigInt(r.tx_block_timestamp) >= since).map((r) => r.transaction_hash))];
const chainTxs: ChainTx[] = [];
for (let i = 0; i < hashes.length; i += 20) {
  const full = await post("/v0/transactions", { tx_hashes: hashes.slice(i, i + 20) });
  for (const t of full.transactions ?? []) {
    const logs: string[] = []; const walk = (o: any) => { if (o && typeof o === "object") { if (Array.isArray(o.logs)) logs.push(...o.logs); for (const v of Object.values(o)) walk(v); } }; walk(t);
    for (const a of t.transaction.actions ?? []) if (a.FunctionCall) chainTxs.push({ hash: t.transaction.hash, signer: t.transaction.signer_id, method: a.FunctionCall.method_name, argsB64: a.FunctionCall.args, tsNs: String(t.execution_outcome?.block_timestamp ?? 0), logs });
  }
}
const rows = classifyTxs(chainTxs, { betId: st.betId, keeper: KEEPER, taker: bet.taker, maker: st.maker });
const runs = explainRuns(rows, bet);
writeFileSync(run("txs_bet35.json"), JSON.stringify({ rows: rows.map(({ args, logs, ...r }) => ({ ...r, run_no: args.result?.run_no, outcome: args.result?.outcome, logs })), runs }, null, 2));

// 3. money from the finalize tx's receipts (DR1b method)
const fin = rows.find((r) => r.method === "finalize");
if (!fin) throw new Error("no finalize tx found for the bet");
const rpc: any = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "EXPERIMENTAL_tx_status", params: { tx_hash: fin.hash, sender_account_id: fin.signer, wait_until: "FINAL" } }) }).then((r) => r.json());
if (!rpc.result) throw new Error(`tx_status ${fin.hash}: ${JSON.stringify(rpc.error)}`);
const exp = bet.outcome === "VOID" ? expectedVoid(taken) : expectedDecisive(taken, bet.outcome);
const { credits, payoutBetIds } = creditsFromReceipts(rpc.result, { escrow: ESCROW, intents: INTENTS, betId: st.betId, token: STAKE_TOKEN });
const isFullyPaid = await view("is_fully_paid", { bet_id: st.betId });
const pending = (await view("pending_payouts", { bet_id: st.betId })).filter((l: any) => !l.done);
// shared accounts' deltas are confounded (maker/fee/escrow serve other bets); the fresh taker's delta is exact only if it never took part in another bet
const bad = checkPerBetMoney(exp, { accounts: { maker: st.maker, taker: bet.taker, fee: FEE }, credits, fresh: { maker: false, taker: false }, isFullyPaid });
const money = {
  status: bet.status, outcome: bet.outcome, truth: truth.outcome, finalize_tx: fin.hash, finalize_by: fin.by, payout_bet_ids: [...new Set(payoutBetIds)], is_fully_paid: isFullyPaid, pending_undone: pending,
  expected: Object.fromEntries(["maker", "taker", "fee"].map((r) => [r, paidTo(exp, r as any).toString()])),
  receipt_credits: Object.fromEntries(Object.entries(credits).map(([k, v]) => [k, v.toString()])),
  mismatches: bad,
};
writeFileSync(run("money_check.json"), JSON.stringify(money, null, 2));
console.log(JSON.stringify({ chain_outcome: bet.outcome, truth: gt.outcome, cmp, ground_truth_read_before_this: gt.outcome_read_before_this, txs: rows.map((r) => `${r.method} ${r.hash} by ${r.by} webDriven=${r.webDriven}`), runs, money }, null, 2));
if (cmp.wrongWinner) { console.error("WRONG-WINNER: chain outcome != ESPN truth"); process.exit(2); }
if (bad.length || pending.length || !isFullyPaid) process.exit(1);
