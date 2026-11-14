# services/release (RC1)

`gen-new-args`: produce and check the escrow `new()` args (D-UPGRADE1: the escrow is not upgradeable).
Spec: vault "Mainnet release config draft" sections 1, 3.1, 3.2.

    node --import tsx release/src/cli.ts gen-new-args --input in.json --network mainnet|testnet \
      --out args.json [--table limits.md] [--now-ms N]

Input: see `example/input.indicative.json` (placeholders only; the asset list is an input, familiarcow decides ZEC/BTC variant).
Refuses: prices differing >2% or older than 30 min, missing/zero `min_fee_cap_per_side`, `intents != intents.near` on
mainnet, bad hex/URL, duplicate or non-distinct accounts. Output `example/*.indicative.*` is NOT for deploy.

Tests: `npm test` in services (unit + CLI). Sandbox: `node --import tsx release/sandbox/release_sandbox.mjs`
(~1 h because of the real 24 h `apply_params` delay; `RC1_SKIP_24H=1` stops before the 24 h step and says so).

## RCB1: storage-rate bounds (D-STORAGE1 part 4, D-MINSTAKE1)
`storage_per_kib` is pinned at `new()`. The generator (and `validateArgs`) read `MAX_TERMS_LEN`, the hash/account/exhibit limits and `STORAGE_EVENT_OVERHEAD_BYTES` from `contracts/escrow/src/lib.rs` (`src/contractConstants.ts`; it throws if they cannot be parsed) and refuse a config where, for any asset: the max-envelope charge `max(1, ceil(bytes*rate/2048))` is over 10% of `min_per_side`; `bytes*rate` would overflow u128; or wNEAR's rate is not exactly `10240000000000000000000`. The per-asset table (rate, ~4 KB charge, max charge, % of min_per_side) is in the table output and printed by the CLI.

## D-VA1 notes for the mainnet args
- `registry` is **inert**: `new()` stores it and nothing reads it (no contract path, no service). Proposed value `registry.praetorial.near`; it can be any valid account without behavioural effect (D-VA1 2).
- `outlayer` on mainnet is **`outlayer.near`** (D-VA1 3). The `PLACEHOLDER` value in the drafts/examples must be replaced with it.
- The web's per-asset limits (`apps/web/lib/assetLimits.generated.ts`) are generated from `release/draft-args.mainnet.json` by `npm run gen:limits` in `apps/web`; `apps/web/tests/assetsReleaseParity.unit.test.ts` fails if the table or generated file drifts from the args (D-VA1 1). Regenerate after re-running `gen-new-args` for the release.

## PXF1: Deploy-day pricing
`src/prices.ts` fetches USD spot prices for BTC, ETH, NEAR (wNEAR and `near_price`) and ZEC from **two different** public providers and merges them into a release input (`price_usd`/`second_price_usd` + timestamps + `*_source`; stables get no price fields). Default pair: **Coinbase** (`api.coinbase.com/v2/prices/<SYM>-USD/spot`: `BTC-USD`, `ETH-USD`, `NEAR-USD`, `ZEC-USD`) + **Kraken** (public `Ticker?pair=`: `XBTUSD`, `ETHUSD`, `NEARUSD`, `ZECUSD`, last-trade close). CoinGecko `simple/price` (`bitcoin`, `ethereum`, `near`, `zcash`) is also available via `--providers coinbase,coingecko`. All 12 symbols were verified to exist on the live endpoints. Timestamps: the HTTP `Date` header (Coinbase, Kraken) or `last_updated_at` (CoinGecko). Fail closed: same provider twice, >2% disagreement, HTTP error, non-USD, NaN/negative/zero, missing timestamp or missing asset refuse the whole run (no output file). `gen-new-args` still applies its own 30-min staleness and 2% checks.

Command order on deploy day (the prices are only valid for 30 min, so run all three within 30 min of signing, D-MINSTAKE1):

    cd services
    node --import tsx release/src/cli.ts prices --input release/<final-input>.json --out release/input.priced.json [--providers coinbase,kraken]
    node --import tsx release/src/cli.ts gen-new-args --input release/input.priced.json --network mainnet --final --out release/args.mainnet.json --table release/limits.md
    node --import tsx release/src/cli.ts freeze-record ...   # freeze record check, with the generated args (see freezeRecord.ts for flags)

Live dry run (evidence only, NOT the deploy-day values): `example/prices.live-2026-11-09.json`, fetched 2026-11-09T14:07:58Z; `gen-new-args` accepted it.

| Asset | Provider A | Price A (USD) | Provider B | Price B (USD) | Diff % | ts (UTC) |
|---|---|---|---|---|---|---|
| BTC | coinbase BTC-USD | 74446.965 | kraken XBTUSD | 74446.20000 | 0.001027 | 2026-11-09T14:07:58.000Z |
| ETH | coinbase ETH-USD | 2114.985 | kraken ETHUSD | 2115.45000 | 0.021985 | 2026-11-09T14:07:58.000Z |
| NEAR | coinbase NEAR-USD | 3.53765 | kraken NEARUSD | 3.54100 | 0.094695 | 2026-11-09T14:07:58.000Z |
| ZEC | coinbase ZEC-USD | 1212.515 | kraken ZECUSD | 1213.15000 | 0.05237 | 2026-11-09T14:07:58.000Z |
