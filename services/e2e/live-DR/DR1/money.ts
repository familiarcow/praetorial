// DR1 phase 3 (DR1b rewrite, D-PM3): money check for a bet from chain views + the escrow's own finalize receipts, never UI.
// Run: npx tsx money.ts [finalize_tx_hash signer_account_id]   (default: bet 18's keeper finalize tx; writes run/money_check.json)
// Method (harness/README.md "Money check"): credits come from THIS bet's finalize/payout receipts (creditsFromReceipts) and must equal
// expectedDecisive to the yocto; fee/escrow are shared by all bets so they are NOT balance-delta checked (receipts + is_fully_paid + residue 0).
// The per-account balance delta stays a hard assertion for maker/taker only when the run used FRESH per-run accounts (state.fresh);
// bet 18 ran on shared accounts, so its deltas are recorded but not asserted (legacy).
import { readFileSync, writeFileSync } from "node:fs";
import { view, bal, FEE, ESCROW, INTENTS, STAKE_TOKEN, RPC } from "./chain.js";
import { expectedDecisive, paidTo, type BetView } from "./expected.js";
import { creditsFromReceipts, checkPerBetMoney } from "../harness/money.js";

const run = (f: string) => new URL(`./run/${f}`, import.meta.url);
const st = JSON.parse(readFileSync(run("state.json"), "utf8"));
const taken: BetView = JSON.parse(readFileSync(run("bet_taken.json"), "utf8"));
const truth = JSON.parse(readFileSync(run("ground_truth.json"), "utf8"));
const [txHash = "EkMbnyrDyr6s6Nh3iz6JFYdZ7vyLTHeSCmPvx8Wn8Fxv", signer = "keeper.praetorial-dev-1101.testnet"] = process.argv.slice(2);

const rpc = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "EXPERIMENTAL_tx_status", params: { tx_hash: txHash, sender_account_id: signer, wait_until: "FINAL" } }) }).then((r) => r.json() as Promise<any>);
if (!rpc.result) throw new Error(`tx_status ${txHash}: ${JSON.stringify(rpc.error)}`);
const bet = await view("get_bet", { bet_id: st.betId });
const taker = bet.taker as string;
const exp = expectedDecisive(taken, bet.outcome);
const { credits, payoutBetIds } = creditsFromReceipts(rpc.result, { escrow: ESCROW, intents: INTENTS, betId: st.betId, token: STAKE_TOKEN });
const isFullyPaid = await view("is_fully_paid", { bet_id: st.betId });
const fresh = st.fresh === true; // set by a harness run that created per-run maker/taker accounts
const after = { maker: await bal(st.maker), taker: await bal(taker) };
const bettorDeltas = fresh ? { maker: after.maker - BigInt(st.before.maker), taker: after.taker - BigInt(st.before.taker) } : undefined;
const bad = checkPerBetMoney(exp, { accounts: { maker: st.maker, taker, fee: FEE }, credits, bettorDeltas, fresh: { maker: fresh, taker: fresh }, isFullyPaid });
const out = {
  status: bet.status, outcome: bet.outcome, truth: truth.outcome, finalize_tx: txHash, payout_bet_ids: [...new Set(payoutBetIds)],
  is_fully_paid: isFullyPaid,
  pending_undone: (await view("pending_payouts", { bet_id: st.betId })).filter((l: any) => !l.done),
  expected: Object.fromEntries(["maker", "taker", "fee"].map((r) => [r, paidTo(exp, r as any).toString()])),
  receipt_credits: Object.fromEntries(Object.entries(credits).map(([k, v]) => [k, v.toString()])),
  bettor_delta_asserted: fresh,
  mismatches: bad,
};
writeFileSync(run("money_check.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
