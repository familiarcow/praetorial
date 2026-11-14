// RC1 sandbox test: init the escrow with GENERATED args for all six assets, open + take one minimum-stake bet per
// asset (must not be refunded), a wNEAR max_per_side bet opens, then guardian propose_params (USDC min_fee 2500000 +
// min_per_side 50000000) succeeds and applies after 24h; 2500001 is refused. Sandbox only (local nearcore); no
// testnet/mainnet, no keys beyond the sandbox's own disposable ones. Run: node --import tsx release_sandbox.mjs
import * as h from "../../../chaos/harness.mjs";
import { generate } from "../src/gen.ts";

const MIN = 60_000;
const IDS = {
  USDC: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  USDT: "nep141:usdt.tether-token.near", BTC: "nep141:btc.omft.near", WNEAR: "nep141:wrap.near",
  ETH: "nep141:eth.omft.near", ZEC: "nep141:zec.omft.near",
};
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) failures++; };
const logsOf = (outcome) => (outcome.receipts_outcome ?? []).flatMap((r) => r.outcome?.logs ?? []);

const now = Date.now();
const vol = (token_id, decimals, price) => ({ token_id, decimals, kind: "volatile", price_usd: price, price_ts_ms: now - 5 * MIN, second_price_usd: price, second_price_ts_ms: now - 5 * MIN });
const assets = [
  { token_id: IDS.USDC, decimals: 6, kind: "stable" }, { token_id: IDS.USDT, decimals: 6, kind: "stable" },
  vol(IDS.BTC, 8, "75823"), vol(IDS.WNEAR, 24, "3.68"), vol(IDS.ETH, 18, "2235.04"), vol(IDS.ZEC, 8, "1260.95"),
];
let generated;
const ctx = await h.setupSandbox({
  buildNewArgs: (_def, { accounts, resolver, rootAccountId }) => {
    const out = generate({
      intents: accounts.intents.accountId, usdc_token_id: IDS.USDC, outlayer: accounts.outlayer.accountId,
      operator: accounts.operator.accountId, guardian: accounts.guardian.accountId, registry: accounts.registry.accountId,
      fee_account: accounts.fee.accountId, keeper: accounts.keeper.accountId, max_offer_ttl_secs: 31_536_000,
      outcome_pubkey: resolver.publicKeyHex, attest_pubkey: resolver.publicKeyHex, resolver_wasm_hash: "b".repeat(64),
      outlayer_config: { wasm_base_url: "https://test.fastfs.io/praetorial-dev-1101.testnet/outlayer.testnet", secrets_profile: "praetorial-resolver", secrets_account_id: rootAccountId },
      near_price: { price_usd: "3.68", price_ts_ms: now - 5 * MIN, second_price_usd: "3.68", second_price_ts_ms: now - 5 * MIN }, // STG1b
      assets,
    }, { now_ms: now, network: "testnet" });
    generated = out.args;
    return out.args;
  },
});
try {
  check(true, "escrow new() accepted the generated args for all six assets");
  const lim = (id) => generated.asset_limits.find((p) => p[0] === id)[1];
  const nextId = async () => (await ctx.escrow.view(ctx.escrow.accountId, "open_offers", { from: 0, limit: 200 })).length;

  async function openRaw(asset, stake, extra = {}) {
    // STG1b: the deposit is stake + the contract-computed per-side charge in THIS asset's generated storage_per_kib.
    const overrides = { maker_asset: asset, taker_asset: asset, stake_maker: stake, stake_taker: stake, storage_per_kib: lim(asset).storage_per_kib, maker: ctx.maker.accountId, resolverSecretKey: ctx.resolver.secretKey, ...extra };
    const msg = h.buildOpenMsg(overrides);
    const amount = h.sideAmount(overrides, "maker");
    await h.mint(ctx.intents, ctx.maker, amount, asset);
    const before = await nextId();
    const out = await ctx.maker.call(ctx.intents.accountId, "transfer_with_msg", { receiver_id: ctx.escrow.accountId, token_id: asset, amount: String(amount), msg }, { gas: 250n * 1_000_000_000_000n });
    const after = await ctx.escrow.view(ctx.escrow.accountId, "open_offers", { from: 0, limit: 200 });
    const rejected = logsOf(out).filter((l) => l.startsWith("open_rejected"));
    return { opened: after.length === before + 1, bet: after[after.length - 1], rejected, overrides };
  }

  for (const [name, id] of Object.entries(IDS)) {
    const min = lim(id).min_per_side;
    const o = await openRaw(id, min);
    check(o.opened && o.rejected.length === 0, `${name}: minimum-stake bet (${min}) opens${o.rejected.length ? " REJECTED: " + o.rejected.join(" | ") : ""}`);
    if (!o.opened) continue;
    const want = h.sideStorage(o.overrides);
    check(BigInt(o.bet.storage_maker) === want && want > 0n, `${name}: stored storage_maker ${o.bet.storage_maker} == formula ${want} from generated storage_per_kib ${lim(id).storage_per_kib}`);
    const betId = o.bet.envelope.bet_id;
    const taken = await h.takeBet(ctx, betId, o.overrides, ctx.taker).catch((e) => ({ err: String(e?.message ?? e) }));
    check(taken.status === "Taken", `${name}: minimum-stake bet taken (status=${taken.status ?? taken.err})`);
  }
  {
    const max = lim(IDS.WNEAR).max_per_side;
    const o = await openRaw(IDS.WNEAR, max);
    check(o.opened && o.rejected.length === 0, `wNEAR: max_per_side bet (${max}) opens${o.rejected.length ? " REJECTED: " + o.rejected.join(" | ") : ""}`);
  }

  // RC1b: a USDC bet opened BEFORE the param change must keep its old terms (fee_min copied into the bet at open).
  // Harness fix: the 24h fast-forward moves CHAIN time, so this bet's funding window must outlive it (default is wall-clock +1h).
  const wallNs = Date.now() * 1_000_000;
  const oldUsdc = await openRaw(IDS.USDC, lim(IDS.USDC).min_per_side, { funding_deadline: wallNs + 3 * 86_400_000_000_000, resolve_deadline: wallNs + 10 * 86_400_000_000_000 });
  check(oldUsdc.opened && oldUsdc.rejected.length === 0, `USDC: pre-change bet opens (min fee copied into bet: fee_min_maker=${oldUsdc.bet?.fee_min_maker})`);
  const oldBetId = oldUsdc.bet.envelope.bet_id;
  const oldFeeMin = oldUsdc.bet.fee_min_maker;

  // D-PARAMS1 via guardian: raise USDC min fee to the cap with min_per_side 20x.
  const change = (fee) => ({ fee_bps: null, assets: [{ asset_id: IDS.USDC, min_fee_per_side: fee, min_per_side: "50000000", max_per_side: null }] });
  const g = (m, a, dep = 1n) => ctx.guardian.call(ctx.escrow.accountId, m, a, { gas: h.tgas(100), deposit: dep });
  let msg = "";
  try { await g("propose_params", { change: change("2500001") }); } catch (e) { msg = String(e?.message ?? e); }
  check(msg.includes("exceeds the per-asset cap"), `propose 2500001 refused (${msg.slice(0, 120)})`);
  await g("propose_params", { change: change("2500000") });
  check(true, "propose min_fee 2500000 + min_per_side 50000000 accepted");
  msg = "";
  try { await g("apply_params", {}, 0n); } catch (e) { msg = String(e?.message ?? e); }
  check(msg !== "", `apply_params before 24h refused (${msg.slice(0, 100)})`);
  if (process.env.RC1_SKIP_24H !== "1") {
    const DAY = 86_400_000_000_000;
    await h.fastForward(ctx, h.blocksForNs(DAY, 0.15));
    let applied = false;
    for (let i = 0; i < 3 && !applied; i++) {
      try { await g("apply_params", {}, 0n); applied = true; } catch (e) { await h.fastForward(ctx, 20000); }
    }
    const l = await ctx.escrow.view(ctx.escrow.accountId, "asset_limit", { asset_id: IDS.USDC });
    check(applied && l.min_fee_per_side === "2500000" && l.min_per_side === "50000000", `after 24h apply_params: USDC min_fee=${l.min_fee_per_side} min_per_side=${l.min_per_side}`);
    // The bet opened before the change keeps its old terms; a new USDC bet gets the new terms; old minimum is now refused.
    const offers = await ctx.escrow.view(ctx.escrow.accountId, "open_offers", { from: 0, limit: 200 });
    const oldNow = offers.find((b) => b.envelope.bet_id === oldBetId);
    check(oldNow && oldNow.fee_min_maker === oldFeeMin && oldFeeMin === "500000" && oldNow.fee_min_taker === "500000", `pre-change bet keeps old terms after apply (fee_min_maker=${oldNow?.fee_min_maker} fee_min_taker=${oldNow?.fee_min_taker}, was ${oldFeeMin})`);
    // Harness fix: attestation checked_at and deadlines must be relative to CHAIN time (sourcecheck freshness is 1h), not wall clock.
    const blk = await ctx.near.connection.provider.block({ finality: "final" });
    const chainNs = Math.floor((Number(blk.header.timestamp_nanosec) - 10_000_000_000) / 4096) * 4096;
    const chainOpen = { checked_at: chainNs, funding_deadline: chainNs + 3_600_000_000_000, resolve_deadline: chainNs + 7 * 86_400_000_000_000 };
    const nu = await openRaw(IDS.USDC, "50000000", chainOpen);
    check(nu.opened && nu.rejected.length === 0 && nu.bet.fee_min_maker === "2500000" && nu.bet.fee_min_taker === "2500000", `new USDC bet at 50000000 gets new terms (fee_min_maker=${nu.bet?.fee_min_maker} fee_min_taker=${nu.bet?.fee_min_taker}${nu.rejected.length ? " REJECTED: " + nu.rejected.join(" | ") : ""})`);
    const below = await openRaw(IDS.USDC, "10000000", chainOpen);
    check(!below.opened && below.rejected.some((r) => r.includes("stake_maker outside asset_limits")), `new USDC bet at the OLD minimum 10000000 is refused (${below.rejected[0] ?? "no open_rejected log"})`);
    const oldTaken = await h.takeBet(ctx, oldBetId, oldUsdc.overrides, ctx.taker).catch((e) => ({ err: String(e?.message ?? e) }));
    check(oldTaken.status === "Taken", `pre-change bet can still be taken (status=${oldTaken.status ?? oldTaken.err})`);
  } else console.log("SKIPPED(env RC1_SKIP_24H): 24h apply step");
} finally {
  await ctx.teardown();
}
console.log(failures ? `RESULT: ${failures} FAILED` : "RESULT: ALL PASS");
process.exit(failures ? 1 : 0);
