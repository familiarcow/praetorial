// LIVE1 fullFlow: maker opens a NEAR (wNEAR) bet and a USDC bet with a named human referee; a fresh taker takes both;
// once funding_deadline passes the referee rules (NEAR bet: YES = maker wins; USDC bet: NO = taker wins); payouts are
// driven (referee_rule drains in the same call; drain_payouts retried if anything is left); each winner's intents balance
// must grow by EXACTLY the contract's payout; then a withdraw to the wallet is attempted.
//
// Payout formula (contracts/escrow/src/lib.rs referee_rule + side_fee, tip off):
//   fee_side   = min(stake, max(stake * fee_bps / 10_000, fee_min_side))   fee_bps = 100, fee_min_side = bet.fee_min_{maker,taker}
//   winner gets (stake_maker - fee_maker) + (stake_taker - fee_taker)      (same asset both sides)
//   fee_account gets fee_maker + storage_maker and fee_taker + storage_taker (storage is never refunded to a winner)
//
// Resumable: state (account ids, bet ids, tx hashes; no secrets) lives in ~/.near-credentials/testnet/live1/state-<ts>.json.
// Run: cd apps/web && npx tsx tests/live/fullFlow.ts              (new run)
//      cd apps/web && npx tsx tests/live/fullFlow.ts <state-file> (resume)
// Env: LIVE1_MAKER / LIVE1_TAKER / LIVE1_REFEREE reuse accounts from ~/.near-credentials/testnet/live1 instead of new ones.
import fs from "node:fs";
import path from "node:path";
import {
  newAccount, loadAccount, mintIntents, openBet, takeBet, refereeRule, balances, withdraw, intentsBalance, humanSheet, sourceCheck,
  pendingPayouts, getBet, USDC, WNEAR, ONE_USDC, ONE_NEAR, ESCROW, INTENTS, LIVE_DIR, log, type LiveAccount,
} from "./liveDriver";
import { viewFunction } from "../../lib/rpc";
import { canonicalTerms } from "../../lib/templates";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statePath = process.argv[2] ?? path.join(LIVE_DIR, `state-${Date.now()}.json`);
const st: any = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { escrow: ESCROW, startedAt: new Date().toISOString(), txs: {}, bets: {}, checks: {}, errors: [] };
const save = () => { fs.mkdirSync(path.dirname(statePath), { recursive: true }); fs.writeFileSync(statePath, JSON.stringify(st, null, 2)); };
const sideFee = (stake: bigint, bps: bigint, min: bigint) => { const f = stake * bps / 10_000n; const m = f > min ? f : min; return m < stake ? m : stake; };

async function acct(role: "maker" | "taker" | "referee", fund: number): Promise<LiveAccount> {
  if (st[role]) return loadAccount(st[role]);
  const envId = process.env[`LIVE1_${role.toUpperCase()}`];
  if (envId) { st[role] = envId; save(); return loadAccount(envId); }
  const a = await newAccount(role, fund);
  st[role] = a.id; st.txs[`fund_${role}`] = a.fundTx; save();
  return a;
}

async function minStake(asset: string, unit: bigint): Promise<bigint> {
  const l = await viewFunction<{ min_per_side: string }>(ESCROW, "asset_limit", { asset_id: asset });
  const v = BigInt(l.min_per_side);
  const floor = asset === WNEAR ? 3n * ONE_NEAR : 10n * ONE_USDC; // coordinator: >= 10 USDC and 3 NEAR per side
  const r = ((v + unit - 1n) / unit) * unit;
  return r > floor ? r : floor;
}

async function main() {
  log(`state file: ${statePath}`);
  const maker = await acct("maker", 2);
  const taker = await acct("taker", 2);
  const referee = await acct("referee", 0.2);

  const plan = [
    { key: "near", asset: "NEAR" as const, id: WNEAR, unit: ONE_NEAR / 100n, ruling: "YES" as const, winner: "maker" },
    { key: "usdc", asset: "USDC" as const, id: USDC, unit: ONE_USDC, ruling: "NO" as const, winner: "taker" },
  ];

  // 1) fund intents balances (stake + storage margin) for both bettors
  if (!st.minted) {
    for (const p of plan) {
      const stake = await minStake(p.id, p.unit);
      st.bets[p.key] = { ...(st.bets[p.key] ?? {}), stake: stake.toString(), asset: p.id };
      for (const [role, a] of [["maker", maker], ["taker", taker]] as const) {
        const need = stake + (p.asset === "USDC" ? ONE_USDC : ONE_NEAR / 10n);
        const have = await intentsBalance(a.id, p.id);
        if (have < need) st.txs[`mint_${p.key}_${role}`] = await mintIntents(a, p.id, need - have);
      }
    }
    st.minted = true; save();
  }

  // 2) open both bets (one sheet, one sourcecheck); window ends ~6 min after the attestation is in hand
  if (!st.opened) {
    let sheet = humanSheet(`full-${Date.now()}`, 6 * 60);
    await sourceCheck(canonicalTerms(sheet)); // may wait on the sourcecheck rate limit
    const endSecs = Date.parse((sheet as any).time.window_end) / 1000;
    if (endSecs - Date.now() / 1000 < 4 * 60) { sheet = humanSheet(`full-${Date.now()}`, 6 * 60); await sourceCheck(canonicalTerms(sheet)); }
    st.sheetWindowEnd = (sheet as any).time.window_end;
    for (const p of plan) {
      if (st.bets[p.key].betId) continue;
      const stake = BigInt(st.bets[p.key].stake);
      const r = await openBet({ maker, asset: p.asset, stakeMaker: stake, stakeTaker: stake, referee: referee.id, takerAccount: null, sheet });
      st.txs[`open_${p.key}`] = r.txHash;
      Object.assign(st.bets[p.key], { betId: r.betId, openHttp: r.httpStatus, openRejected: r.openRejected, openFailure: r.receiptFailure, fundingDeadlineNs: r.fundingDeadlineNs, makerDeposit: r.deposit, sourcecheckMs: r.sourcecheckMs });
      save();
      if (r.betId === null) throw new Error(`open ${p.key} failed: http ${r.httpStatus} ${JSON.stringify(r.relayBody)} ${r.openRejected ?? ""} ${r.receiptFailure ?? ""}`);
    }
    st.opened = true; save();
  }

  // 3) taker takes both
  if (!st.taken) {
    for (const p of plan) {
      const b = st.bets[p.key];
      if (b.taken) continue;
      const r = await takeBet(taker, b.betId);
      st.txs[`take_${p.key}`] = r.txHash;
      Object.assign(b, { taken: r.taken, takeHttp: r.httpStatus, takeFailure: r.receiptFailure, takerDeposit: r.deposit, refereeAck: r.refereeAck, takeLogs: r.logs });
      save();
      if (!r.taken) throw new Error(`take ${p.key} (bet ${b.betId}) failed: http ${r.httpStatus} ${JSON.stringify(r.relayBody)} ${r.receiptFailure ?? ""} logs=${JSON.stringify(r.logs)}`);
    }
    st.taken = true; save();
  }

  // 4) wait until the referee may rule (now >= funding_deadline for both bets)
  const fd = Math.max(...plan.map((p) => Number(BigInt(st.bets[p.key].fundingDeadlineNs) / 1_000_000n)));
  st.refereeMayRuleAt = new Date(fd).toISOString(); save();
  if (!st.ruled) {
    const waitMs = fd + 5_000 - Date.now();
    if (waitMs > 0) {
      const maxWait = Number(process.env.LIVE1_MAX_WAIT_MIN ?? 20) * 60_000;
      if (waitMs > maxWait) { log(`referee may rule at ${st.refereeMayRuleAt}; re-run: npx tsx tests/live/fullFlow.ts ${statePath}`); console.log(JSON.stringify(st, null, 2)); return; }
      log(`waiting ${Math.round(waitMs / 1000)} s for funding_deadline (${st.refereeMayRuleAt})`);
      await sleep(waitMs);
    }
  }

  // 5) referee rules + payout; check exact winner deltas
  for (const p of plan) {
    const b = st.bets[p.key];
    if (b.ruled) continue;
    const winner = p.winner === "maker" ? maker : taker;
    const bet: any = await getBet(b.betId);
    const bps = BigInt(bet.envelope.fee_bps);
    const sm = BigInt(bet.envelope.stake_maker), stk = BigInt(bet.envelope.stake_taker);
    const fm = sideFee(sm, bps, BigInt(bet.fee_min_maker)), ft = sideFee(stk, bps, BigInt(bet.fee_min_taker));
    const expected = (sm - fm) + (stk - ft);
    const before = await intentsBalance(winner.id, p.id);
    const r = await refereeRule(referee, b.betId, p.ruling);
    st.txs[`rule_${p.key}`] = r.ruleTx;
    r.drains.forEach((d, i) => { st.txs[`drain_${p.key}_${i}`] = d.txHash; });
    let after = await intentsBalance(winner.id, p.id);
    for (let i = 0; i < 6 && after - before < expected; i++) { await sleep(3000); after = await intentsBalance(winner.id, p.id); }
    Object.assign(b, {
      ruled: r.ruleOk, ruling: p.ruling, winner: p.winner, ruleHttp: r.ruleHttp, ruleBody: r.ruleBody, ruleFailure: r.ruleFailure,
      statusAfter: r.bet?.status, outcomeAfter: (r.bet as any)?.outcome, pendingAfter: (await pendingPayouts(b.betId)).length,
      formula: { stake_maker: sm.toString(), stake_taker: stk.toString(), fee_bps: bps.toString(), fee_min_maker: bet.fee_min_maker, fee_min_taker: bet.fee_min_taker, fee_maker: fm.toString(), fee_taker: ft.toString(), storage_maker: bet.storage_maker, storage_taker: bet.storage_taker },
      winnerBefore: before.toString(), winnerAfter: after.toString(), expectedDelta: expected.toString(), actualDelta: (after - before).toString(),
      payoutExact: after - before === expected,
    });
    save();
    if (!r.ruleOk) st.errors.push(`referee_rule ${p.key} bet ${b.betId}: http ${r.ruleHttp} ${JSON.stringify(r.ruleBody)} ${r.ruleFailure ?? ""}`);
  }

  // 6) LIVE2: withdraw the winnings to the wallet through the web's own path (lib/withdraw.ts, relayed). The wallet must rise by
  // EXACTLY the amount. Precondition for a real payout on testnet: the intents MOCK must hold that much of the REAL token
  // (it pays out real wrap.testnet / usdc.testnet). If it doesn't (usdc.testnet has no faucet), the withdraw is expected to be
  // refunded by the mock: then the check is that NO money was lost (intents balance unchanged) and the step is BLOCKED, never PASS.
  if (!st.withdrawn) {
    for (const p of plan) {
      const b = st.bets[p.key];
      const winner = p.winner === "maker" ? maker : taker;
      const ft = p.id.replace(/^nep141:/, "");
      const amount = BigInt(b.expectedDelta ?? "1");
      const backing = BigInt(String(await viewFunction<string>(ft, "ft_balance_of", { account_id: INTENTS })));
      const intentsBefore = await intentsBalance(winner.id, p.id);
      const walletBefore = (await balances(winner)).wallet[ft as "wrap.testnet" | "usdc.testnet"];
      const w = await withdraw(winner, p.id, amount);
      const walletAfter = (await balances(winner)).wallet[ft as "wrap.testnet" | "usdc.testnet"];
      const intentsAfter = await intentsBalance(winner.id, p.id);
      const delta = BigInt(walletAfter ?? "0") - BigInt(walletBefore ?? "0");
      b.withdraw = { ok: w.ok, txHashes: w.txHashes, detail: "detail" in w ? w.detail : undefined, amount: amount.toString(), mockRealBacking: backing.toString(), walletBefore, walletAfter, walletDelta: delta.toString(), intentsBefore: intentsBefore.toString(), intentsAfter: intentsAfter.toString() };
      if (backing >= amount) b.withdraw.result = w.ok && delta === amount && intentsBefore - intentsAfter === amount ? "PASS" : "FAIL";
      else b.withdraw.result = !w.ok && delta === 0n && intentsAfter === intentsBefore ? "BLOCKED" : "FAIL";
      w.txHashes.forEach((h, i) => { st.txs[`withdraw_${p.key}_${i}`] = h; });
      save();
    }
    st.withdrawn = true; save();
  }

  st.final = { maker: await balances(maker), taker: await balances(taker) };
  st.pass = {
    payoutsExact: plan.every((p) => st.bets[p.key].payoutExact),
    withdrawToWallet: plan.every((p) => st.bets[p.key].withdraw?.result !== "FAIL") && plan.some((p) => st.bets[p.key].withdraw?.result === "PASS"),
    withdrawBlocked: plan.filter((p) => st.bets[p.key].withdraw?.result === "BLOCKED").map((p) => `${p.key}: intents mock holds ${st.bets[p.key].withdraw.mockRealBacking} real ${p.id} < ${st.bets[p.key].withdraw.amount} (no testnet faucet); refund verified, nothing lost`),
  };
  save();
  console.log(JSON.stringify(st, null, 2));
  // LIVE2: a withdraw FAIL fails the run; a BLOCKED one (mock not backed by the real token) is printed loudly and never called a pass.
  if (st.pass.withdrawBlocked.length) console.error(`fullFlow WITHDRAW BLOCKED: ${st.pass.withdrawBlocked.join("; ")}`);
  if (!st.pass.payoutsExact || !st.pass.withdrawToWallet) { console.error(`fullFlow FAILED: payoutsExact=${st.pass.payoutsExact} withdrawToWallet=${st.pass.withdrawToWallet}`); process.exitCode = 1; }
}
main().catch((e) => { st.errors.push(String(e?.message ?? e)); save(); console.error("fullFlow FAILED:", e?.message ?? e, `\nstate: ${statePath}`); process.exitCode = 1; });
