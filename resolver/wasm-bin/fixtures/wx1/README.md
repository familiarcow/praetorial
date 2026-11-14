# WX1 fixtures (nws-record-flag, D-WX1)

Real recorded responses, KIAH climate day 2026-11-03. NWS CLI appends `R` to a record value (`MAXIMUM         88R 12:39 PM  88    2016`).
Source copies live in ~/.hermes/profiles/praetorial-bot/fixtures/wx1/ (sha256 verified before use).

- nws_cli_KIAH_20261103_product.json — NWS product 61a52f4b-bee7-4ed2-8ebd-99b9ea19ca75, untrimmed. sha256 19b860f6a092f9ae6250880f0c2aa99c41587b420742c6420a00fe17d0dfcb0f
- nws_cli_IAH_list_20261108.json — CLI/IAH product list fetched 2026-11-08, untrimmed. sha256 4c19a8403b747c242ae21bb5591b15cb123a64693d6bf0669e720ae394ef1745
- iem_cli_KIAH_2026_trimmed.json — IEM cli.py KIAH year=2026, TRIMMED to results valid 2026-11-02, 2026-11-03, 2026-11-04 (all other rows dropped; generated_at kept). Original iem_cli_KIAH_2026.json sha256 e1e6b19184ae9bbb088fb7f190eafad925bfcbf906235e4dc148cc94a0a755ea. IEM high for 2026-11-03 = 88.
