// DRILL1 step 7: residue. Records balances after, every payout line per bet, residue = expected net delta - observed delta (must be 0).
import { viewer, load, save, bal, MAKER, TAKER, FEE, DIR } from "./lib.mjs";
const R = load(); const ESC = R.escrow; const v = await viewer();
const view = (m, a = {}) => v.viewFunction({ contractId: ESC, methodName: m, args: a });
R.balances.after = {}; R.residue = {}; R.payout_lines = {};
for (const a of Object.keys(R.balances.before)) { R.balances.after[a] = (await bal(v, a)).toString(); R.residue[a] = (BigInt(R.expected_credits[a] ?? "0") - (BigInt(R.balances.after[a]) - BigInt(R.balances.before[a]))).toString(); }
R.escrow_balance.after = (await bal(v, ESC)).toString(); R.residue[ESC] = (BigInt(R.escrow_balance.after) - BigInt(R.escrow_balance.before)).toString();
for (const [n, b] of Object.entries(R.bets)) { const p = await view("pending_payouts", { bet_id: b.id }); const bet = await view("get_bet", { bet_id: b.id }); R.payout_lines[n] = { bet_id: b.id, status: bet.status, fully_paid: await view("is_fully_paid", { bet_id: b.id }), lines: p.map((x) => ({ receiver: x.receiver, asset: x.asset, amount: x.amount, reason: x.reason, done: x.done })) }; }
save(R);
console.log(JSON.stringify({ before: R.balances.before, after: R.balances.after, expected_net: R.expected_credits, residue: R.residue, escrow: R.escrow_balance }, null, 1));
for (const [n, p] of Object.entries(R.payout_lines)) console.log(n, p.status, p.fully_paid, JSON.stringify(p.lines));
