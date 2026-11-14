// LIVE1 openProof: fresh maker + referee on testnet; open ONE USDC and ONE NEAR (wNEAR) human-referee bet through the
// deployed relayer exactly like the web's Open button; print a JSON summary (tx hashes, bet ids, on-chain bet state).
// The brief asked for 1 USDC / 1 NEAR stakes. The frozen escrow's asset_limit min_per_side is 10 USDC and ~2.7174 wNEAR,
// so the 1-unit opens are attempted first (to record the contract's exact refusal) and then repeated at the asset minimum.
// Run: cd apps/web && npx tsx tests/live/openProof.ts
import { newAccount, loadAccount, mintIntents, openBet, balances, humanSheet, USDC, WNEAR, ONE_USDC, ONE_NEAR, ESCROW, log } from "./liveDriver";
import { viewFunction } from "../../lib/rpc";

async function minStake(asset: string): Promise<bigint> {
  const l = await viewFunction<{ min_per_side: string }>(ESCROW, "asset_limit", { asset_id: asset });
  return BigInt(l.min_per_side);
}
const roundUp = (v: bigint, unit: bigint) => ((v + unit - 1n) / unit) * unit;

async function main() {
  const out: any = { escrow: ESCROW, startedAt: new Date().toISOString(), txs: {}, bets: {} };
  // LIVE1_MAKER / LIVE1_REFEREE = reuse accounts from ~/.near-credentials/testnet/live1 (the funder is nearly empty).
  const reuse = (id: string | undefined) => (id ? { ...loadAccount(id), fundTx: "(reused)", fundedYocto: "0" } : null);
  const maker = reuse(process.env.LIVE1_MAKER) ?? await newAccount("maker", 2);
  const referee = reuse(process.env.LIVE1_REFEREE) ?? await newAccount("referee", 0.2);
  out.maker = maker.id; out.referee = referee.id;
  out.txs.fundMaker = maker.fundTx; out.txs.fundReferee = referee.fundTx;
  out.fundedYocto = { maker: maker.fundedYocto, referee: referee.fundedYocto };
  // Brief: 10 USDC + 3 wNEAR. Topped up to cover the contract minimum stakes + storage after the 1-unit attempts.
  if (!process.env.LIVE1_MAKER) {
    out.txs.mintUsdc = await mintIntents(maker, USDC, 10n * ONE_USDC);
    out.txs.mintWnear = await mintIntents(maker, WNEAR, 3n * ONE_NEAR);
  }
  out.balancesAfterMint = await balances(maker);

  const summarize = (r: any) => ({
    betId: r.betId, txHash: r.txHash, httpStatus: r.httpStatus, relayBody: r.relayBody, receiptFailure: r.receiptFailure,
    openRejected: r.openRejected, deposit: r.deposit, sourcecheckMs: r.sourcecheckMs, makerBalanceDelta: r.makerBalanceDelta,
    bet: r.bet ? { status: r.bet.status, maker: r.bet.envelope.maker, referee: r.bet.envelope.referee, maker_asset: r.bet.envelope.maker_asset,
      stake_maker: r.bet.envelope.stake_maker, stake_taker: r.bet.envelope.stake_taker, funding_deadline: r.bet.envelope.funding_deadline,
      resolve_deadline: r.bet.envelope.resolve_deadline, storage_maker: r.bet.storage_maker, terms_hash: r.bet.envelope.terms_hash } : null,
  });

  // One sheet for every open in this run (one sourcecheck attestation, reused while fresh).
  const sheet = humanSheet(`proof-${Date.now()}`, 3600);
  for (const [asset, id, one] of [["USDC", USDC, ONE_USDC], ["NEAR", WNEAR, ONE_NEAR]] as const) {
    log(`open ${asset} bet at 1 unit/side (brief)`);
    const r1 = await openBet({ maker, asset, stakeMaker: one, stakeTaker: one, referee: referee.id, takerAccount: null, sheet });
    out.bets[`${asset}_1unit`] = summarize(r1);
    if (r1.betId === null) {
      const min = await minStake(id);
      const r = roundUp(min, asset === "USDC" ? ONE_USDC : ONE_NEAR / 100n);
      const floor = asset === "USDC" ? 10n * ONE_USDC : 3n * ONE_NEAR; // >= 10 USDC and 3 NEAR per side
      const stake = r > floor ? r : floor;
      const need = stake + 10n ** (asset === "USDC" ? 6n : 23n); // stake + a storage margin
      const bal = BigInt((await balances(maker)).intents[id]);
      if (bal < need) out.txs[`topup_${asset}`] = await mintIntents(maker, id, need - bal);
      log(`open ${asset} bet at contract minimum ${stake}`);
      const r2 = await openBet({ maker, asset, stakeMaker: stake, stakeTaker: stake, referee: referee.id, takerAccount: null, sheet });
      out.bets[`${asset}_min`] = summarize(r2);
    }
  }
  out.balancesEnd = await balances(maker);
  out.pass = Object.entries(out.bets).some(([k, b]: any) => k.startsWith("USDC") && b.betId !== null && b.bet?.status === "Open")
    && Object.entries(out.bets).some(([k, b]: any) => k.startsWith("NEAR") && b.betId !== null && b.bet?.status === "Open");
  console.log(JSON.stringify(out, null, 2));
  if (!out.pass) process.exitCode = 1;
}
main().catch((e) => { console.error("openProof FAILED:", e?.message ?? e); process.exitCode = 1; });
