# live-L1 (PART A, offline): crypto-price examples on recorded candles

Fixtures (fixtures/, manifest.json has url + fetch time + sha256): public REST candles fetched ONCE at 2026-11-07T14:57Z by `fetch_fixtures.py`
(Coinbase Exchange `/products/{BTC,ETH,SOL}-USD/candles`, Bitstamp `/api/v2/ohlc/{btc,eth,sol}usd/`, Kraken `/0/public/OHLC`): 1m candles for the previous ~12h
(BTC window 2026-11-07T02:57Z..13:56Z); 1h BTC files and ETH/SOL files are recorded too but only the BTC 1m files are replayed (no typed template for ETH/SOL; those phrasings are builder-rejects).
Tests never touch the network. Nothing here is a synthetic price except the two files named `SYNTHETIC_*` (Coinbase minus deleted minutes; no natural Coinbase gap exists in these windows).

Truth derivation (all in `gen_examples.py`, from raw candles; no judge involved):
- Jason window = 2026-11-07T04:00Z..06:00Z (2h, 1m granularity, no coarse-evidence gate). "Same 5-min bucket" = floor(ts/300). YES level = floor(max over buckets of min(CB bucket max high, BS bucket max high)). One-venue NO level = floor(other venue's max)+1 (reached on exactly one venue). Different-bucket level = a level whose Coinbase buckets and Bitstamp buckets are disjoint.
- Gap fixtures: 12 mid-window Coinbase minutes deleted (10% > D-RESOLVE8's 2%) -> Coinbase INCOMPLETE -> Bitstamp+Kraken fallback pair; 2 minutes deleted -> tolerated.
- close-at-T: T=14:00Z, median of the three venues' CLOSE of the minute ending T; X = floor(median)+/-10. Settle clock T+10min.
- touch: 10h window 05:00Z..15:00Z (deadline), levels from per-venue window max/min: second-highest max (YES), above all (NO), between second and highest (exactly one venue => VOID by D-TPL1b), mirrored for at_or_below.
- AI-path rows use a RECORDED judge reply (hand-written JSON in examples.json, quote copied verbatim from the exhibit rows); they test the resolver's gates (verbatim-quote check, coverage/gap rules, decide), not a model.
- Windows are 2-10h, not a full UTC day: "all day" range and "% on a day" phrasings are replayed on the 10h session, with the claim saying so.

Run: `cd resolver/wasm-bin && cargo test l1a` (`L1_WRITE=1` rewrites actual.json; `python3 -I make_report.py` rewrites REPORT.md).
