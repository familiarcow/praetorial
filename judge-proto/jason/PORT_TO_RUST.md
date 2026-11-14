# D-RESOLVE1 recovery ladder — what resolver/core must mirror

Python prototype: `judge-proto/evidence.py` (functions below) + `judge.py::lint` (fork/ticker gate).
Tests: `judge-proto/jason/test_recovery_ladder.py` (14/14 green, no regressions).

## 1. `fallback_any_n_of` structured field
Term sheet carries `fallback_any_n_of: {n: u8, sources: [String], q: Option<String>}` (curated,
per-asset approved list — e.g. BTC-USD: Coinbase, Bitstamp, Kraken, Gemini). `judge_element`
must route evidence through this list **in code**, asking **one singular question** per approved
venue ("high >= X on N approved venues within 5 min"), never hardcoding named-source text that
breaks when the named source is absent. Mirror `evidence.py::judge_element_fallback`: for each
admitted source in the approved list, ask it alone whether it individually satisfies the
per-source question (`fb.q` overrides the raw element text — critical, or a Kraken exhibit gets
asked "did Coinbase AND Bitstamp..." and returns garbage); count `met`/`not_met` per source; `n`
threshold enforced in code (`met_count >= n` → met), never left to the model to tally votes.

## 2. Resolver-only unavailability
Only resolver code (from the *actual admitted exhibit set*, i.e. `admit()`'s output) may declare
data unavailable. A party's brief claiming "source X is down" is **never** a trigger — it goes
through the ordinary `check_claims` path like any other claim and gets struck for lacking a
backing exhibit/quote, same as a false factual assertion. Rust must NOT add any code path that
reads a brief/claim field to decide unavailability; the only valid signal is `admit()` returning
zero admissible exhibits.

## 3. RETRY, not VOID, with a 24h×7d recovery ladder
Mirror `evidence.py::resolve_with_recovery`. When nothing is admissible: return `RETRY` with a
`next_check` timestamp (first unavailable-at + a 24h step, repeating), **not** `VOID`. Only once
`now - first_unavailable_at >= 7 * 24h` does the outcome become `VOID`. The contract/keeper must
persist `first_unavailable_at` (set once, on the first RETRY) and call the resolver again at
`next_check` — this is new state, not present in escrow today (see open design question below).

## 4. Keeper archive snapshots
`is_keeper_archive(exhibit)` = `source_type == "archive_snapshot" AND keeper_signed == true`.
Only snapshots meeting both conditions get archive-snapshot treatment; a party claiming the same
`source_type` without `keeper_signed` is just an ordinary ignorable exhibit. **Rust must verify
a real signature** here, not a boolean flag — `keeper_signed` in Python stands in for "the
keeper's ed25519 signature over the snapshot payload verifies against the keeper pubkey stored
on the escrow contract" (C2/C3). Archive snapshots are evidence like any other and can single-
handedly prove NO (e.g. two snapshots taken live during the bet, neither crossing the threshold)
even if the live sources are unreachable at judge time.

## 5. Amend-only substitution
`apply_source_substitution(term, amend)`: `amend.signed_by` must be exactly `{maker, taker}` —
zero signers (silence) or one signer (unilateral) is always refused. This should map directly to
the existing escrow `amend` two-call-commit pattern (BD2) once a source-substitution amend type
is added to the contract; resolver/core should refuse to apply any substitution that didn't come
through that amend path (no "N days of no objection = accepted" logic — ever).

## 6. Fork-ticker hard refusal
`lint()`/compiler time: a term sheet with any price/candle-referencing claim or element is
refused outright unless `ticker_pins: {publisher: ticker}` names **every** source in
`sources_allowed`. `admit()`/resolver time: any exhibit whose own text trips
`fork_ticker_flag()` (chain-split/renamed/redirected-ticker language) is **rejected**, not merely
flagged, unless its publisher has a `ticker_pins` entry. The canonical Jason sheet now pins
`Coinbase BTC-USD → BTC-USD`, `Bitstamp btcusd → btcusd`, `Kraken XBT/USD → XBT/USD`.

## Open design question for familiarcow
`first_unavailable_at` / recovery-ladder state has no home in the escrow contract today (it's
not a `PendingPayout`/`Bond` concept, and it needs to survive across multiple keeper-triggered
resolver calls before VOID fires). Needs either a new `Bet.recovery` field or a side-table keyed
by bet_id — flagging rather than guessing the storage design silently.

## Not yet ported / still red, honestly
- Round-2 relitigation freeze (`new_evidence_round2_relitigation_refused_intended`) — unrelated
  pre-existing design gap (evidence-freeze round-awareness), untouched by this work.
- `gap_a` Early YES/NO-at-deadline and the raw fork/ticker *lint-silently-accepts* finding note
  are both now narrowed by item 6 above (fork/ticker price sheets are refused without pins), but
  the fixture's own `WRITABLE_VS_RESOLVABLE` table entries weren't rewritten this session — a
  follow-up should update those two rows to reflect the new hard-refusal behaviour.
