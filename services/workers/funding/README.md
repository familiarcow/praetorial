# funding Worker (F1, FUND4 SPEC §7.1, D-FUND4 / D-FUND4a)

`praetorial-funding-{testnet,mainnet}`. Add money / Cash out / Convert through NEAR Intents 1Click. Holds **no NEAR keys** and
never moves money itself: Add money only ever *credits* the caller's intents account, and Cash out / Convert move money only with
the user's own NEP-413 signature.

## Policy (familiarcow, UX-37 / D-FUND4a)
- **Add money** (`POST /fund/quote`): origin = any token 1Click lists; destination **always one of the 6 bet tokens**
  (`BETTING_ASSET_IDS`, = `release/mainnet-night/args.mainnet.json` asset_limits, test-enforced); `recipient = refundTo = account`,
  `recipientType = refundType = INTENTS`; `FLEX_INPUT`; one-time deposit address (no permanent bridge addresses); 1 h address
  (3 h for BTC/ZEC/DOGE/LTC/BCH/DASH); Stellar origins use `depositMode: MEMO`. **No partner fee**: `appFees` is never sent.
- **Convert** (`POST /withdraw/quote` kind `convert`): intents -> intents, destination one of the 6, recipient forced to the account.
- **Cash out** (`POST /withdraw/quote` kind `withdraw`): intents -> any chain; recipient checked by
  `services/common/src/funding/chainAddress.ts` (shared with the web); refunds to the account (INTENTS).
- **Signing** (`POST /withdraw/intent` -> `POST /withdraw/submit`): 1Click `generate-intent` (swap_transfer, nep413, signerId =
  account) -> `intentCheck.ts` asserts exactly one `transfer` of `amountIn` of the origin token to the deposit address, deadline
  <= the quote's -> the browser signs the NEP-413 hash with the Privy key -> the Worker checks the payload is byte-equal, the key
  is the implicit account's own key and the signature verifies -> 1Click `submit-intent`. No relayer, no gas.
- Every value field (recipient, refundTo, types, destination, fees) is built here; any client-supplied one is a 400.
- Real quotes must carry a valid 1Click signature (`quoteSignature.ts`, port of the SDK's `verifyQuoteSignature`) **and** echo
  our request field by field, else 502 and nothing is stored. **Known gap: BTC origin-chain quotes fail 1Click's own
  signature check** (spikes/f1/NOTES.md). D-PM3 exception (F1B): a BTC origin-chain Add-money quote with a bad signature is
  accepted only if fetched straight from `https://1click.chaindefuser.com` and the echo matches exactly (assets, amount,
  swapType, recipient/refundTo + types, deadline, slippage, appFees = none); stored as `quoteSignature: "btc_unverified"`, logged
  `quote_sig_btc_unverified` (warn). Every other route stays strict. The pin in `quoteSignature.test.ts` shows a 1Click fix.

## Endpoints
`GET /health` · `GET /tokens` (1Click list, 5 min cache, + `bettingAssetIds`) · `POST /fund/quote` · `POST /fund/submit-tx` ·
`GET /fund/status?depositAddress=` (stored records only: no open proxy) · `GET /fund/list?account=` · `POST /withdraw/quote` ·
`POST /withdraw/intent` · `POST /withdraw/submit` (account optional: taken from the record). Response shapes follow F2's
`apps/web/lib/funding/types.ts` (list = bare array of web `SwapRecord`s, status = flat `StatusView` + `record`, health
`keyConfigured`), pinned by `test/webClientContract.test.ts`, which drives the web's real client against this handler.
Errors: `{ok:false, code, error (= code), message, minUnits?, retryAfterS?}`; 1Click 400s map to
`too_low` (with `minUnits`), `no_route`, `bad_recipient`, `bad_refund`, `deadline`, `upstream_rejected`; outages to `upstream_down` (503).

Rate limits (one SQLite DO, instance "global"): dry quotes 60/min/IP; real quotes 10/h/IP and 10/h/account, max 5 open per
account; status/list 120/min/IP; intent+submit 10/h/account; submit-tx 30/h/IP. 429 + `Retry-After`.

## 1Click calls
Always `User-Agent: praetorial-funding/<GIT_SHA>` and `Accept: application/json` (1Click's Cloudflare WAF answers 403 "error code:
1010" without a UA), plus `X-API-Key` when the secret is set.

## Config
Secret: `ONECLICK_API_KEY` (partner JWT). Mainnet: `scripts/set-mainnet-secrets.sh` pipes it from
`$PRAETORIAL_SECRETS_DIR/praetorial-oneclick.env` (line `ONECLICK_API_KEY=...`), never printed. Vars: see `wrangler.toml`. The
**testnet** Worker is dry-only (`FUNDING_DRY_ONLY = "1"`): 1Click only exists on mainnet, so it previews but never issues an address.

Deploy: `scripts/deploy-mainnet.sh` / `deploy-testnet.sh` include `funding` (familiarcow's go only). Check: `check-deployed-stack.mjs`
and `check-mainnet-ready.mjs` cover it. Live canary (dry quotes, no key, no money): `node services/workers/funding/scripts/canary.mjs`.

Not built (by decision): the SPEC §5.2 relayer fallback and its `/internal/deposit-owner` (familiarcow: relayer only after asking him).
