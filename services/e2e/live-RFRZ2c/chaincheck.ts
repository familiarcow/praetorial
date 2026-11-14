// RFRZ2d: post-hoc chain assertion for bet 5 (balances vs offline expectation, escrow residue, tx table). Run: node --import tsx chaincheck.ts
import fs from "node:fs";
import { ESCROW, FEE, view, bal, escrowMethods } from "../live-DR/DR6/chain.js";
import { expectedMoney, moneyMismatches, findTxByMethod } from "./plan.js";
const R = JSON.parse(fs.readFileSync(new URL("./run/results.json", import.meta.url), "utf8"));
const big = (o: any) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, BigInt(v as string)])) as any;
const before = big(R.balances_before), mid = big(R.balances_after_take);
const bet = await view("get_bet", { bet_id: 5 });
const taken = { ...bet, status: "Taken" };
const exp = expectedMoney(taken);
const after = { maker: await bal(R.maker), taker: await bal(R.taker), fee: await bal(FEE), escrow: await bal(ESCROW) };
const bad = moneyMismatches(exp, mid, after, before);
const hist = await escrowMethods(0n);
const out = { bet, pending: await view("pending_payouts", { bet_id: 5 }), is_fully_paid: await view("is_fully_paid", { bet_id: 5 }), exp, after, deltas_from_mid: { maker: after.maker - mid.maker, taker: after.taker - mid.taker, fee: after.fee - mid.fee }, net_vs_before: { maker: after.maker - before.maker, taker: after.taker - before.taker, fee: after.fee - before.fee, escrow: after.escrow - before.escrow }, mismatches: bad, concede_tx: findTxByMethod(hist, "concede") };
console.log(JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1));
fs.writeFileSync(new URL("./run/chaincheck_bet5.json", import.meta.url), JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1));
if (bad.length) { console.error("FINDING", bad); process.exit(2); }
