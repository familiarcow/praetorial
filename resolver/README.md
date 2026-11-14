# Praetorial resolver — Rust port (offline, wasm32-wasip2)

Rust port of the Praetorial judge prototype (`~/praetorial/judge-proto/{judge,evidence}.py`)
as a pure, no-I/O core crate plus a wasip2 binary suitable for an OutLayer resolver.
This is the Test-plan §8 step-1/3/4 work from
`Praetorial - OutLayer verified judge design v0.md`: offline port + parity proof + wasm build.
**No model API calls, no NEAR tx, no OutLayer execution were made anywhere in this work.**

## Layout

```
resolver/
  Cargo.toml              workspace
  core/                   praetorial-core: pure logic, no I/O, builds for any target
    src/lib.rs
    tests/parity.rs        loads fixtures/, replays them through the Rust port
    tests/fixtures/*.json  exported by judge-proto/export_fixtures.py (no model calls)
  wasm-bin/                praetorial-resolver: the OutLayer binary
    src/main.rs             stdin job JSON -> stdout receipt JSON
```

## Job modes (`resolver/wasm-bin`)

Besides the default judge/evidence dispatch, `main()` recognizes a few
standalone job modes dispatched by `job["mode"]`, none of which ever call
the model:

| `mode` | Input | Output | Notes |
|---|---|---|---|
| `"sourcecheck"` | `{"terms":"<raw term sheet>"}` | `{"ok","spec_hash","checked_at","unreachable":[{id,reason}],"signing"?}` | D-FETCH2 (queue item 7f2) + D-ATTEST1 (7g4): spec_hash = sha256(raw `terms`), the sources and the referee exemption come from the term sheet, `checked_at` from the wasm's own WASI wall clock (u64 ns, rounded to 2^12); job-supplied spec_hash/checked_at/sources are ignored (a mismatching spec_hash/terms_hash rejects the job). Fetches every source through `fetch_and_admit_source`; signs `sourcecheck_message` only if ALL non-exempt sources are reachable. D-SRCCHK2 (L1b4) + D-SRCCHK3: for a typed `btc_close_at_t` AND `btc_touch` sheet the open-time probe asks every venue for the last fully closed 1-minute candle only (`sourcecheck_probe_sources`), never the whole bet window (a long btc_touch window made Coinbase answer HTTP 400 for > 300 candles); resolution still reads the full window. |
| `"archive"` | `{"bet_id","terms":"<raw term sheet>"}` | `{"bet_id","terms_hash","snapshots":[{"source_type":"archive_snapshot","source_id","captured_at","terms_hash","body","resolver_sig","resolver_pubkey_hex"}],"failed":[{id,reason}]}` | D-FETCH1 part 3 (7f3) + D-ATTEST1 (7g4): archives ONLY the term sheet's `sources_allowed` urls under their ids, captured_at from the wasm clock, terms_hash = sha256(raw terms). Fetches every source through `fetch_and_admit_source` (same `classify_blocked_fetch` gate -- a blocked/challenge page lands in `failed`, never `snapshots`); signs each SUCCESSFULLY-fetched body independently with the resolver key over `archive_message(bet_id, source_id, captured_at, terms_hash, sha256(body))` (`praetorial:archive:v2:...`; admission requires terms_hash == the bet's and on-chain submitted_at in [captured_at, captured_at+15min]). Archive snapshots are resolver-signed, never keeper-signed (supersedes the old keeper-signed design); `resolver/core::is_resolver_archive` is the admission-side check. The keeper schedules this job periodically (6h) plus on every live-status trigger (D-RESOLVE1 point (c)) and stores only snapshots that verify against the bet's own `resolver_pubkey` (`services/keeper/src/archiveJob.ts`). |

## core (`praetorial-core`)

No dependency touches the network or filesystem. Ports, function-for-function:

| Rust | Python | What it does |
|---|---|---|
| `CLAUSES`, `FIXED_SYSTEM` | `judge.CLAUSES`, `FIXED_SYSTEM` | byte-identical clause text and system prompt |
| `norm`, `escape`, `sha_hex` | `judge.norm/escape/sha` | NFKC + quote-fold + strip Cf (zero-width) + collapse ws + lower; html-escape `&<>` only; sha256 hex |
| `lint` | `judge.lint` | term-sheet compiler gate (imperative-language lint, clause/time/publisher checks) |
| `eligible_sources` | `judge.eligible_sources` | drops sources not on the allow-list, after cutoff, or party-controlled |
| `build_messages` | `judge.build_messages` | the fixed two-message prompt (system + user with `<rules>`/`<source>` blocks) |
| `verify` | `judge.verify` | schema check, verbatim-quote check (normalized), rules-vs-source disambiguation |
| `element_verdict` | `judge.element_verdict` | unanimity rule, drops empties, any-invalid -> unresolved, `met` must rest on a non-party source |
| `decide` | `judge.decide` | ALL/ANY short-circuit, conflict -> VOID, unresolved -> ESCALATE, burden-of-proof default |
| `admit` | `evidence.admit` | exhibit admission: cutoff, exhibit cap, class allow-list, party-controlled, backdating grace window |
| `check_claims`, `claims_block` | `evidence.check_claims/claims_block` | brief-claim striking (quote not verbatim / no admitted exhibit) |
| `judge_element_tiered` | `evidence.judge_element` | tier-fallback loop (highest source class that actually answers the question wins) |
| `Receipt`, `canonical_json`, `receipt_hash` | — (new) | §3.2 receipt schema; manual RFC 8785 JCS canonicalizer (sorted keys, no dependency needed) + sha256 hash |

Internals worth flagging:
- `parse_ts`/`days_from_civil` is a small UTC-only `"%Y-%m-%dT%H:%M:%SZ"` parser (Howard Hinnant's
  days-from-civil algorithm) — no chrono dependency, keeps the wasm binary small, and every
  timestamp in this system is already UTC ISO8601 by the `lint()` gate.
- All term-sheet/exhibit/source structures are passed as `serde_json::Value`, mirroring Python's
  dict-based duck typing, so the port stays structurally close to the original and doesn't invent
  stricter typing than the prototype has.

## Parity proof (`core/tests/parity.rs`)

`judge-proto/export_fixtures.py` makes **zero model calls**. It runs the *real* Python
`lint`/`eligible_sources`/`build_messages`/`admit`/`check_claims`/`verify`/`element_verdict`/`decide`
functions against:
- synthetic hand-written "raw model completion" JSON strings, chosen to be what a model that
  resists every attack and correctly applies the clauses would say (the oracle for "the
  deterministic code is right", not a claim that models always resist attacks — that's the
  model layer, explicitly out of scope offline), and
- for 2 of the 18 redteam cases, the real stored verdict labels recovered from
  `report.json`'s one completed run (`party_controlled_only`, `two_elements_one_missing`),
  re-synthesizing a verbatim quote from the real eligible source text so `verify()` itself is
  exercised, not just the label.

`export_fixtures.py` asserts every case's `decide()` outcome matches the case's documented
`expect` (0 mismatches found) before dumping `tests/fixtures/{lint,verifier,redteam,evidence}.json`.

`tests/parity.rs` then feeds the **exact same raw completion strings** through the Rust
functions and asserts:
- `build_messages` output is **byte-identical** to the fixture's prompt (full JSON `[{role,content}]` equality, not just a hash),
- `eligible_sources`/`admit`/`check_claims` produce the identical admitted/rejected/struck sets,
- `verify` produces the identical `(answer, extra)` for every raw string, including the exact
  Python error-message text (`"quote not found verbatim in source"`, `"cited unknown source 'S7'"`, etc.),
- `element_verdict`/`judge_element_tiered`/`decide` produce the identical verdict and `(outcome, why)`.

### `cargo test -p praetorial-core` result (2026-11-01, this machine)

```
running 3 tests   (unit tests: norm, escape, canonical_json)       ... 3 passed
running 11 tests  (tests/parity.rs)                                 ... 11 passed
```
The 11 parity tests cover: lint (6 cases), the 6 named verifier-attack unit tests
(fabricated quote, quote-from-rules, unknown source, bad schema, zero-width chars, tiny quote) +
a 10-case generic verifier table, all 18 redteam cases, all 13 evidence cases, and receipt-hash
determinism/key-order-independence. **0 failures, 0 discrepancies from the Python port.**

`cargo test -p praetorial-resolver`: 2/2 (offline mock never returns YES; an empty/invalid
term sheet VOIDs via the lint gate) — both exercised through the actual job-resolution path the
wasm binary runs.

## wasm-bin (`praetorial-resolver`)

Reads one job JSON object from stdin, resolves it with `praetorial-core` plus a pluggable
`ModelCaller`, writes a receipt JSON object to stdout.

- **Default build**: `OfflineMock` — makes no network call, ever; always answers `insufficient`
  for every element, which is the conservative default (an all-insufficient run never fabricates
  a YES; it loses on burden of proof or escalates). This is deliberate: the task is to port and
  prove the deterministic code, not to call a model.
- **`--features real-http`**: adds `real_http::NearAiClient`, a real OpenAI-compatible
  `chat/completions` client over `wasi-http-client` (the crate OutLayer's own tutorial and
  connectors use for wasip2 egress — plain `reqwest` does not compile for `wasm32-wasip2`, per
  `WASI_TUTORIAL.md`). **It compiles but is never instantiated or called by `main()`** in either
  build; it exists only to prove the real HTTP path builds for this target, per the design
  doc's §1.1 constraint.

Job shape: `{"bet_id", "term": {...term sheet...}, "sources": [...]}` for the direct judge.py
path, or `{"bet_id", "term, "exhibits": [...], "briefs": [...]}` for the tiered evidence.py path
(presence of `exhibits` selects it).

#### `first_unavailable_ns` / `retry_count` (item 7d4, D-RESOLVE1 live wiring)

Two optional job-level fields carrying the D-RESOLVE1 recovery-ladder state from the chain
(`get_bet`'s `first_unavailable_ns`/`retry_count`, `services/common/src/types.ts`) into the live
`resolve_direct`/`resolve_evidence` dispatch:

- **`first_unavailable_ns`** (`u64`, nanoseconds since epoch, same wire units as the contract's
  `next_check_ns`): when the recovery ladder first triggered for this bet. Absent (or omitted
  entirely) means no retry history yet -- the ladder's anchor becomes "now" (`job["checked_until"]`)
  on this check, matching `praetorial_core::resolve_with_recovery`'s `first_unavailable_at: None`
  semantics.
- **`retry_count`** (`u64`, default `0` when absent): how many RETRY cycles have already elapsed
  for this bet. Mirrors `contracts/escrow/src/lib.rs::submit_outcome`'s own dual VOID:unavailable
  gate exactly (7 days elapsed from `first_unavailable_ns` OR `retry_count >= max_retries` 7) --
  the resolver never signs a RETRY the contract would already treat as exhausted.

**Both are chain state, never resolver memory**: whoever builds the job JSON from the on-chain
envelope/bet (same trust boundary as `maker_side`/`ambiguity_votes` above) must copy these two
fields from `get_bet` verbatim. `services/keeper` does **not** build this job JSON today -- its
`request_resolution`/re-request calls only send `{bet_id}` to the contract (see
`services/keeper/src/runner.ts`), so whichever OutLayer-side job builder eventually assembles the
full job object is where these two fields must be wired through from `get_bet`, not the keeper.

#### Blocked/broken-fetch detector (item 7f part 1, D-FETCH1/D-FETCH2)

`fetch_and_admit_source`/`fetch_json` run every fetched response through
`praetorial_core::classify_blocked_fetch(status, content_type, body, expect_json)`
**before** the body is ever turned into `source["text"]`/exhibit
`archived_text`/parsed JSON. It returns `Some(reason)` -- and the fetch is
`Err("COULDNT_CHECK (spec §11 FETCH_FAIL, queue item 7f): {reason}")`, never
`Ok(blocked_body)` -- for:

- HTTP 403, 429, or any other non-2xx status,
- a Cloudflare/captcha/bot-challenge page (`"Just a moment..."`, `cf-chl`,
  `"Attention Required! | Cloudflare"`, captcha/hCaptcha markers, ...), even
  one served with a 200,
- a login wall (200 HTML with a password-input form plus sign-in/log-in
  copy where data was expected),
- an empty or whitespace-only body,
- invalid/truncated JSON, or the wrong content-type (HTML where JSON was
  expected, for the price-check/`fetch_json` path only).

A dropped source feeds the existing D-RESOLVE1 recovery ladder exactly like
any other FETCH_FAIL: `resolve_direct`/`resolve_evidence` already route
"nothing admissible" through `live_recovery_outcome` -> RETRY (ladder
unexhausted) or `VOID:unavailable` (exhausted) -- never a fabricated YES/NO.
`RawFetchResponse` carries the final hop's `status_code: u16` (test
fetchers that pre-date this field default to 200). Python parity:
`judge-proto/evidence.py::classify_blocked_fetch` +
`judge-proto/test_blocked_sources_v1.py` (byte-for-byte mirror, no network).

**Status (2026-11-05): part (2) resolver/TS side implemented in merge
commit `a0be210`** (branch `feat/source-check-attestation`, queue item
7f2). New `run_sourcecheck`/`sourcecheck_sign` (`resolver/wasm-bin/src/main.rs`),
dispatched via job shape `{"mode":"sourcecheck","spec_hash","checked_at","sources":[{"id","url","referee_source_mode"}]}`:
every non-exempt source is fetched through the same `classify_blocked_fetch`-gated
`fetch_and_admit_source` path above; the resolver signs
`praetorial:sourcecheck:v1:{spec_hash}:{checked_at}` (`praetorial_core::sourcecheck_message`)
ONLY if every source was reachable, otherwise it returns `{"ok":false,"unreachable":[...]}`
and signs nothing. Source-mode referee reports are exempt via
`referee_source_mode:true` (never fetched at all). A custom venue
without a fetchable `https://` URL fails the same as an unreachable
fetch. Python parity: `judge-proto/evidence.py::sourcecheck_message` +
`judge-proto/test_blocked_sources_v1.py`. TS builder/verifier + keeper
policy: `services/common/src/sourceCheck.ts`
(`buildSourceCheckMessage`/`verifySourceCheckAttestation`/`requestSourceCheckBeforeOpen`).
Shared byte cross-check fixture:
`contracts/escrow/tests/fixtures/sourcecheck_crosscheck.json` (used by
`resolver/core`'s `sourcecheck_message_matches_crosscheck_fixture_bytes`,
`services/common`'s `sourceCheck.test.ts`, and
`judge-proto/test_blocked_sources_v1.py`).
**NOT done in this pass: the on-chain enforcement half** --
`contracts/escrow`'s `open`/`handle_open` does not yet require this
attestation (D-FETCH2's "enforced on-chain" requirement). See the
Decision register D-FETCH2 entry and the build log for why (every
`TransferMsg::Open` call site across `tests.rs`/`seams.rs`/
`chaos_findings.rs`'s own duplicate shim/`tests/conformance/escrow_conformance`'s
own duplicate helpers/`chaos/harness.mjs` needs updating through exactly
one helper, and `chaos_findings.rs`'s fixed non-derivable test pubkey
needs a real seed-derived key first) -- open queue item for a follow-up
pass. (3) enclave-signed archive snapshots remains untouched, separate
queue item.

#### `maker_side` / `ambiguity_votes` (item 7r3, D-DISPUTE1 S3.4 "Ambiguity")

Two optional fields the tiered evidence-round job may carry, consumed only by
`ambiguity_override` (`wasm-bin/src/main.rs`) to decide whether a given element's
unanimous-ambiguous finding VOIDs the bet (library clause) or reads against the maker
(contra proferentem, custom wording):

- **`maker_side`** (job-level string, `"YES"` or `"NO"`): which side of the bet the maker
  took. No TS job builder exists yet (`services/keeper/src/resolverSim.ts` is a
  testnet-only simulator that fabricates a forced outcome directly and never builds or
  submits a real resolver job — see its own doc comment); whoever eventually builds a
  real job from the on-chain envelope must set this field there. The resolver only
  *requires* it when a custom-wording element is found unanimously ambiguous; if it's
  absent at that point the element falls back to ordinary burden of proof and the
  receipt's `fetch_notes` records `"element <id>: maker_side missing..."` — the resolver
  never crashes and never emits a non-escrow-legal outcome for a missing field.
- **`ambiguity_votes`** (per-element array of bool, one per panel seat, `true` = that seat
  found the element's wording genuinely ambiguous): stands in for a live multi-model
  panel round, which this binary does not call yet (item 7r2 wired `admit_round`/
  `check_claims` only). The vote count must match `panel_for_round(round_no)`'s family
  count (3 for round 1, 5 for round 2) or the rule does not fire. Only unanimous `true`
  votes (every seat) trigger the rule, and only for `round_no` 1 or 2 — round 0 (the
  initial single pass, no panel) and any other round never apply contra proferentem or
  the library-clause VOID, regardless of `ambiguity_votes`.
- **`is_library_clause`** (per-element bool, default `false`): marks a LIBRARY clause
  (neither party drafted it) vs. maker-authored custom wording, per the dispute design
  doc's distinction.

### Build result (`cargo build --release --target wasm32-wasip2`)

```
target/wasm32-wasip2/release/praetorial-resolver.wasm
size:   2,015,853 bytes (~1.92 MiB)
sha256: 61d4d881682ef103ef490f7323fcc142921e99e81fd2d66671b54b88be53ff34
```
`--features real-http` also builds clean for the same target (confirms `wasi-http-client`
compiles for wasip2, resolving the open risk flagged in the design doc §1.1/§8 step 3) — not
included in the default/pinned artifact above.

### `wasmtime run`, offline, no network, no secrets

```
$ echo '{"bet_id":"b1","term":{...},"sources":[{"id":"S1","published":"2027-06-01T00:00:00Z","text":"it happened"}]}' \
  | wasmtime run target/wasm32-wasip2/release/praetorial-resolver.wasm
-> outcome "NO", why "an element is not proven (burden on YES); other elements irrelevant"
```
`wasmtime 50.0.1` run locally (via `brew install wasmtime`), confirming the Test-plan §8 step-3
pass criterion: compiles for wasip2, runs under wasmtime, same deterministic outcome as the
native binary for the same input (offline mock everywhere — no model, no HTTP egress occurred
in this run).

## Explicit non-goals of this work (per task scope)

- No model API was called (not NEAR AI, not any other provider).
- No NEAR transaction, no OutLayer `request_execution`, no OutLayer login/deploy.
- No file under `~/.hermes/secrets` was read.
- `decide`/`verify`/`element_verdict`/etc. logic was **not modified** from the Python prototype;
  any difference found during the port is called out below.

## Discrepancies found while porting (none logic-breaking)

- None found in the core aggregation/decision/verification logic — all 18 redteam + 13 evidence
  oracle cases (computed in `export_fixtures.py` straight from `judge.py`/`evidence.py`, no model
  calls) matched their documented `expect` on the first correct assignment of synthetic answer
  vectors (one off-by-tier bug in the *fixture authoring*, not the Python/Rust logic, was caught
  and fixed before any Rust code ran: `honest_wire_evidence_wins` needs Reuters' "wire" class,
  `source_classes` tier 3, not tier 1 — a fixture-authoring mistake on my part, not a judge.py bug).
- `evidence.judge_element`'s tier loop short-circuits to "insufficient" with **zero model calls**
  whenever `admit()` leaves no admitted sources at all (`tiers = sorted(set())` is empty) — 4 of
  the 13 evidence cases (`after_cutoff_exhibit_rejected`, `party_controlled_rejected`,
  `unlisted_publisher_rejected`, `late_submission_rejected`) hit this path; both the Python and
  Rust ports take it identically, and it needed no synthetic raw-completion data at all.

## Remaining work (not done here, per task scope / explicit stop points)

1. NEAR AI attestation-binding step (design doc §1 step 6-7, Test-plan step 2) — not ported;
   needs live, budgeted NEAR AI calls, explicitly out of scope for this task.
2. OutLayer project creation/upload/deploy, `outlayer secrets`, signing-key tests (Test-plan
   steps 5-9) — need OutLayer credentials and, from step 9, familiarcow's explicit testnet sign-off.
3. `real_http::NearAiClient` is untested against a live endpoint (by design — no model calls here).
4. Arweave/FastFS storage of the full receipt, and anything past Test-plan step 4, is unbuilt.
