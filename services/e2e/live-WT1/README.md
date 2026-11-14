# WT1c: one testnet bet opened from the web build's envelope builder

Escrow: `praetorial-l1b20-11080132.praetorial-dev-1101.testnet` (L1b20, wasm `ba96b2ae…e148`, pins resolver `4b9d9372…` = record-0723fe2). Mock-intents `intents-mock.praetorial-dev-1101.testnet`, mock USDC (`nep141:usdc.testnet`), maker `maker1.praetorial-dev-1101.testnet`. Testnet only, no deploy.

## How the envelope was made (no hand-written envelope)
`open_from_web.mjs` (run from `apps/web`: `NEAR_RPC_URL=https://test.rpc.fastnear.com tsx ../../services/e2e/live-WT1/open_from_web.mjs`) imports the web modules:
`guidedFields.fieldsFromForm` -> `templates.lintAnySheet` -> `openPins.checkOpenPins` (real `resolver_keys()` of the escrow; passed, never bypassed) -> `openEnvelope.buildOpenEnvelope` -> `escrowAdapter.buildOpenMsg`, deposit = `openEnvelope.makerDeposit`.
Form: `btc_close_at_t`, close at T (~65 min out; resolver rejects <1h with `OPEN_T_TOO_SOON`) `>= 75900`. Evidence: `envelope_built.json`, `open_msg.json`, `sourcecheck.log`, `results.json`.

## Two real web bugs found by the live open (fixed test-first, RED then GREEN commits)
| # | Bug | Effect on the deployed escrow | Fix |
|---|---|---|---|
| 1 | `buildOpenEnvelope` emitted `storage_charge_per_side: "0"` and App deposited only `stake_maker` | contract `sanity_check` needs `2*storage >= terms+hashes+15*(128+64)+256` bytes, so every web Open would be refused | `storageChargePerSide()` mirrors the contract; `makerDeposit()` = stake + storage |
| 2 | `buildOpenMsg` sent `attestation.checked_at` as a JSON **string** | contract field is `u64`; serde parse fails and `mt_on_transfer` silently refunds the whole deposit (no log) | splice digits as a JSON number, full u64 precision; validates integer + 128-hex signature |

## Tx table
| step | tx |
|---|---|
| attempt 1 (bug 2): open refused, silent refund of 1001706 | `9H6eA3WuQfJx3Vspd833fg8sbbEvx9Wvr2tfm8G6Eoz9` (`results_attempt1_refused.json`) |
| diagnostic resends of the same msg (variants in `try_variant.mjs`; all silently refunded) | `9AsafD4ajepZ7Lk8fTWScXS2xWQBghQPyZ8Ma96tu4Hr`, `HuVdAdSDCRwLbk97dEycox7Sae3qhAKjC9sMv6JGWbPB`, `2JkdfP6YeUf6hHvpC1JdkYNoqSji1otvDiRVCfAg5xFu`, `5sypk6gTDetUQdqGBLjBgjXb2e6vbmcAGvrXBBXLWNS7`, `58avpMJ9GSyJ4EbU9FprXW59gdDB6y6uLLkr1aqDHs3`, `6cSe6rMna9Fhbx7Hbf3UKp88NbPySaraxfyGHTnd4VFr` |
| sourcecheck (attest1, outlayer, ~0.002 tNEAR; no NEAR AI) | `87p2qW8mjawBydqWRdLoAumnTNvnWCQJn59qi2HQngoy` |
| mint mock USDC to maker | `2wq3aHeYC7XWPgShx4weVQHKRDNBSHobKHD4Vye5kZK8` |
| **open (bet 2, Open)** | `HrNdCLAjkWDZPMrdgf3jorjoozqCjr77mrxz7nuzLr3j` |
| cancel (maker) -> Cancelled | `7H1NJPXqZ1PRVBSqzhGyi7Ym3JEXzaKPF8HP7tKBxDm7` |
| drain_payouts (refund 1001706 mock USDC to maker) | `4QGjwYoeayCQhKjWKH5EDdt8couvhNhqPLBWaFT5FYii` |

Bet 1 was L1b20's earlier bet; this bet is id 2. No taker, no funding of the other side, no resolution (not required).

## Verifier (`services/verifier/verify-bet --network testnet --escrow … --bet 2 --expect-escrow-hash ba96b2ae…`)
- While Open (`verify_bet2_open.txt`): 5 PASS, 0 FAIL, 5 SKIP. B1 `sha256(terms) == envelope.terms_hash` and B2 attestation valid under pinned attest_pubkey PASS; E1-E3 PASS. B3-B6 SKIP (no submitted results / judge record / finalize for an unsettled bet; E4 offline).
- After cancel (`verify_bet2_after_cancel.txt`): 5 PASS, 0 FAIL, 5 SKIP.

## Cost
Mock USDC only (minted, refunded). Real tNEAR = gas + one sourcecheck, about 0.015 tNEAR across keeper/attest1/maker (`bal_before.txt` / `bal_after.txt`), well under the 0.1 cap. NEAR AI calls: 0.

## Note
The deployed escrow predates G5F (`protocol_fee_bps()` view is null; it has no `min_fee_per_side`), but it accepts `fee_bps: 100`. A G5F-or-later contract would also need the web USDC min stake of the asset table (10 USDC, D-MINSTAKE1); this bet used 1 USDC mock because L1b20 has `min_per_side: 1`.
