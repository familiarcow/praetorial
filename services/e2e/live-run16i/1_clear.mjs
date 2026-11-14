// 16c step 1: clear stuck bet 1 via mutual_settle (maker then taker, 50/50) + drain_payouts. Results -> ./results.json (appended under step16c).
import { account, mk } from "./lib.mjs";
import * as C from "./config.mjs";
const { load, save, recordTx } = mk("./results.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maker = await account(C.MAKER), taker = await account(C.TAKER), anyone = await account(C.OPERATOR);
const view = (m, a) => anyone.viewFunction({ contractId: C.ESCROW, methodName: m, args: a });
const st = (x) => (JSON.stringify(x.status).includes("Failure") ? "Failure" : "Success");
const stop = (step, e) => { const r = load(); r.step16c_clear_failure = { step, error: String(e?.message ?? e).slice(0, 800), tx: e?.context?.transactionHash }; save(r); console.log("FAILED", step, r.step16c_clear_failure); process.exit(2); };
const betId = 1;
console.log("bet1 before:", (await view("get_bet", { bet_id: betId })).status);
try { const a = await maker.functionCall({ contractId: C.ESCROW, methodName: "mutual_settle", args: { bet_id: betId, split_maker_bps: 5000 }, gas: 100_000_000_000_000n }); recordTx("16c_mutual_settle_maker", a.transaction.hash, { status: st(a) }); } catch (e) { stop("mutual_settle_maker", e); }
try { const b = await taker.functionCall({ contractId: C.ESCROW, methodName: "mutual_settle", args: { bet_id: betId, split_maker_bps: 5000 }, gas: 200_000_000_000_000n }); recordTx("16c_mutual_settle_taker", b.transaction.hash, { status: st(b) }); } catch (e) { stop("mutual_settle_taker", e); }
await sleep(3000);
for (let i = 0; i < 6; i++) {
  const b = await view("get_bet", { bet_id: betId });
  const pend = (await view("pending_payouts_view", { from: 0, limit: 200 })).filter((p) => !p.done);
  console.log("status", b.status, "pending", pend.length);
  if (b.status === "Settled" && pend.length === 0) break;
  try { const d = await anyone.functionCall({ contractId: C.ESCROW, methodName: "drain_payouts", args: { bet_id: betId, limit: 20 }, gas: 300_000_000_000_000n }); recordTx(`16c_drain_payouts_${i}`, d.transaction.hash, { status: st(d) }); } catch (e) { stop("drain", e); }
  await sleep(5000);
}
const r = load(); r.step16c_bet1_final = await view("get_bet", { bet_id: betId }); save(r);
console.log("final", r.step16c_bet1_final.status, JSON.stringify(r.step16c_bet1_final.outcome));
