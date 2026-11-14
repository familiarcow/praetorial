// DRILL1 2b: the first run of 2_drill.mjs had two defects in THE SCRIPT (not the contract), both visible in results.json history:
//  (a) it attached 1 yocto to non-payable methods (emergency_refund-before-shutdown, void_after_deadline, concede), so those 3 "refusals" were NEAR's
//      "Method X doesn't accept deposit", not the contract's guard -> marked invalid here; void_after_deadline and concede are re-run with 0 deposit post-shutdown;
//  (b) two state checks (unpause, guardian==G2) read a lagging view right after the tx -> re-established from the txs' own logs (offers_unpaused / guardian_rotated).
// emergency_refund-before-shutdown can no longer be exercised on this escrow (shutdown is irreversible): recorded as NOT drilled live (covered by contract unit tests only).
import { account, viewer, load, save, recordTx, tryCall, DIR, DEV } from "./lib.mjs";
import { REFUSALS, matchesRefusal } from "./assertions.mjs";
const R = load(); const ESC = R.escrow; const v = await viewer();
const logsOf = async (hash, signer) => { const r = await v.connection.provider.txStatus(hash, signer, "FINAL"); return (r.receipts_outcome ?? []).flatMap((o) => o.outcome.logs); };
const ref = R.refusals; const find = (s) => ref.find((x) => x.step.startsWith(s));
const txOf = (step) => R.txs.find((t) => t.step === step)?.hash;
for (const s of ["emergency_refund before shutdown refused", "void_after_deadline refused after shutdown", "concede on C refused after shutdown"]) { const e = find(s); e.invalid = "script attached 1 yocto to a non-payable method; failure text is NEAR's deposit guard, not the contract guard"; e.observed = false; }
find("emergency_refund before shutdown refused").note = "NOT DRILLED LIVE (irreversible shutdown already happened); covered by contract unit tests only";
// (b) from tx logs
const un = (await logsOf(txOf("unpause_new_offers"), R.guardians.G1)).join("\n"); const rot = (await logsOf(txOf("accept_guardian"), R.guardians.G2)).join("\n");
const u = find("unpause: is_new_offers_paused false"); u.observed = un.includes("offers_unpaused"); u.note = "re-established from tx logs (view read raced finality): " + (un.match(/EVENT_JSON[^\n]*/)?.[0] ?? un.slice(0, 200)); u.kind = "state";
const g = find("after accept: guardian view == G2"); g.observed = rot.includes("guardian_rotated") && rot.includes(R.guardians.G2); g.note = "re-established from tx logs: " + (rot.match(/EVENT_JSON[^\n]*/)?.[0] ?? rot.slice(0, 200));
// redo valid post-shutdown refusals with 0 deposit
const keeper = await account("keeper.praetorial-dev-1101.testnet"), maker = await account("maker1.praetorial-dev-1101.testnet");
for (const [step, who, acc, method, bet] of [["void_after_deadline refused after shutdown (0 deposit)", "keeper", keeper, "void_after_deadline", R.bets.C.id], ["concede on C by maker refused after shutdown (0 deposit)", "maker", maker, "concede", R.bets.C.id]]) {
  const res = await tryCall(acc, ESC, method, { bet_id: bet }, { deposit: 0n, gas: 100_000_000_000_000n });
  if (res.hash) recordTx(step.replace(/[^a-z0-9_]+/gi, "_") + "_refused", res.hash);
  ref.push({ step, kind: "panic", caller: who, method, expected: REFUSALS.voidAfterShutdown, text: res.failure, observed: !res.ok && matchesRefusal(res.failure, REFUSALS.voidAfterShutdown) });
  console.log(step, res.ok, res.failure?.slice(0, 200));
}
R.refusals = ref; save(R);
const r2 = load(); r2.refusals = ref; save(r2);
