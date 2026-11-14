# Praetorial web v0.3 (apps/web)

## Deploy (Cloudflare Worker)

The app is a static Vite build served by a Cloudflare Worker (`worker/index.ts`, which also proxies the indexer, relayer,
registry and sports schedule). One config per network:

- testnet: `npm run deploy:testnet` (config-drift check, `build:testnet`, `wrangler deploy --config wrangler.testnet.toml`)
- mainnet: `npm run deploy:mainnet` (`build:mainnet`, the bundle guard `scripts/mainnetDeployGuard.ts`, `wrangler deploy --config wrangler.mainnet.toml`);
  afterwards `npm run check:live:mainnet` reads the live bundle and checks it carries every mainnet service URL.

Local: `npm run dev` (http://localhost:3000, testnet backend).

`wrangler.toml` and `functions/api/ticker.ts` are the earlier v0.3 Cloudflare Pages setup; the Worker deploy above does not use them.

v0 of the Jason-bet flow: login, create offer, review card, bet-by-id page.
Built standalone in this folder; does not touch `contracts/`, `services/`,
or any other agent's in-flight work.

## Screens
1. **Login** (`src/components/Login.tsx`) -- LOGIN1 (UX-29): logged out, every route is ONLY this full page (no nav,
   no overlay); two steps via Privy's headless email OTP (`useLoginWithEmail`): email + "Send code", then (after the code
   is sent) the code field, "Resend code", "Use a different email". Logic in `lib/loginFlow.ts`. The URL is kept, so deep
   links open after login. Signed in, `AccountStatus` shows the Tier-1 NEAR implicit account + balance.
2. **Create offer** (`src/components/CreateOffer.tsx`) -- claim text with
   the BTC-threshold preset, maker stake asset/amount, odds, settlement
   period, offer expiry; same-asset taker default (1:1 scaled by odds);
   a cross-asset checkbox that pulls an exact-amount quote from 1Click's
   public `GET /v0/tokens` (no auth) and shows "not offered" when 1Click
   can't price the asset. Enforces $5 min, per-asset max, 10:1 max odds
   client-side.
3. **Review card** (`src/components/ReviewCard.tsx`) -- renders ONLY from
   the structured offer object (plain sentence, both stakes, odds,
   sources, deadline, settlement period, 1%-of-pot-per-asset fee, the
   "money can only go to you or the other party" line). Never free prose.
4. **Bet page** (`src/components/BetPage.tsx`) -- status read live via
   `get_bet`/`open_offers` against the deployed testnet escrow.

## Contract adapter
`lib/escrowAdapter.ts` is shaped against the **current**
`contracts/escrow/src/lib.rs` interface (cross-asset `taker_options`,
`asset_limits` whitelist, intents-routed NEP-141 opens). The deployed
testnet contract (`escrow3.praetorial-dev-1101.testnet`, see
`lib/config.ts`) is the **old**, pre-cross-asset build -- a redeploy is
queued per the task brief. Read methods (`get_bet`, `open_offers`,
`is_paused`) work against it today, real RPC, confirmed live
(`open_offers(0,5)` currently returns `[]` on testnet). Writing an offer
(`Open`/`Take` via NEP-141 `ft_transfer_call` through `intents`) needs
the maker/taker to hold a whitelisted asset inside the intents contract
and a full envelope (`resolver_pubkey`, `resolver_wasm_hash`,
`models_snapshot_hash`, etc.) -- that chain-write path is coded in the
adapter (`buildOpenMsg`/`buildTakeMsg`). The BetPage Take screen is live: it sends `Take` through the relay
(`transfer_with_msg`), with the optional referee tip + `referee_ack`, a taker-options picker (the primary asset or any
`taker_options` entry; deposit = that stake + storage), and the maker's invite. A direct challenge (`taker_allow`
Account) only enables the named account; an invite-only bet (`InvitePubkey`) reads `?invite=<128-hex ed25519 signature
over praetorial:invite:v1:{bet_id}:{taker}>` from the challenge link and refuses without a valid one, building nothing.
`open-pending-note` in `App.tsx` still labels the Open path as pending redeploy wiring

## What works end to end on testnet now
- Privy email-OTP login -> real Tier-1 NEAR wallet (implicit account)
  creation/load, confirmed by the Playwright test.
- Live NEAR balance read via RPC for that account.
- Live `get_bet`/`open_offers` reads against
  `escrow3.praetorial-dev-1101.testnet` (paced <=3 req/s).
- Create-offer form with the BTC-threshold preset, client-side validation
  ($5 min / per-asset max / 10:1 odds), and the structured review card.
- 1Click `/v0/tokens` public price lookup for the cross-asset prefill
  and "not offered" fallback.

## Pending the escrow redeploy
- Actually opening/taking a bet on-chain (needs the new asset_limits
  whitelist + intents-routed transfer; the OLD deployed contract's
  whitelist/`intents` config isn't something this app can safely probe
  or assume without risking a silently-refunded, confusing tx).
- Cancel/take buttons on the Bet page are wired to the adapter's call
  shapes but disabled in the UI until that's verified against the new
  deploy.
- No gas-sponsorship/relayer; a funded maker/taker NEAR account is
  assumed (fund from `praetorial-dev-1101.testnet`, <1 testnet NEAR
  total per the task brief).

## Built this pass (2026-11-04)
1. **Canonical Jason term sheet** (`lib/termSheet.ts`, `JASON_TERM_SHEET`)
   -- mirrors `judge-proto/jason/term_sheet.json` 1:1: structured
   `SourceSpec[]` (Coinbase BTC-USD, Bitstamp btcusd, both UTC),
   threshold $126,210.50, 1-minute candle / 5-minute confirm window,
   deadline `2028-10-28T19:00:00Z` displayed correctly as
   **"12:00 PM PDT (19:00 UTC)"** (fixes the old preset's wrong "PST"
   label -- Oct 28 2028 is in Daylight Time), early-YES allowed,
   Kraken fallback + "any 2 of the approved list" on by default, and
   VOID only after the recovery ladder (D-RESOLVE1) is exhausted. A
   structured object, never a free-text string -- `CreateOffer.tsx`'s
   "Use Jason preset" button loads it; "Write a custom claim" starts a
   blank structured term sheet instead.
2. **Review-card validation flags** (`lib/termSheet.ts:validateTermSheet`)
   -- flags undefined timezone, trading pair, source/venue (including
   vague venues under 3 chars), or deadline on **custom** (non-preset)
   claims; the preset is always well-formed by construction. "Review
   offer" is blocked with `form-error` while flags exist; the review
   card also renders the same flags (`review-flags`) and a
   `review-open-gate` ("ready"/"blocked") the real app would gate
   "Open offer" on.
4. **Cross-asset taker options** (`CreateOffer.tsx`'s `taker-options`
   block) -- same-asset is always offered 1:1 scaled by odds; USDC and
   wBTC are offered from a small whitelist, pre-filled from 1Click's
   public `/v0/tokens` with % from market and quote time, maker-editable
   per D-UI1/D-PRICE6; an asset 1Click can't price shows "not offered"
   (exercised for real via wBTC in the test, never faked).
5. **Referee picker** (`lib/referee.ts`, `CreateOffer.tsx`'s
   `referee-picker` block) -- AI (default) or Person (D-REFUI4 Human
   mode, the contract's only referee mode): the maker names a person
   and may tip them from their own stake; the review card renders
   "A person decides this bet. If they don't rule by [deadline],
   you're both refunded."; no sources are needed in Person mode;
   referee != maker and != taker is validated client-side and blocks
   opening with a clear error.
6. **Mutual settle explainer** (`BetPage.tsx`'s
   `mutual-settle-explainer`) -- always shown on the bet page (D-REF2):
   either side can propose a split any time pre-payout, both must sign,
   works alongside any referee mode, and the normal 1% fee still
   applies (not fee-exempt).

### Contract interface note
`contracts/escrow/src/lib.rs` (current, read-only) already has
`Referee`/`RefereeMode` and `Envelope.taker_options: Vec<TakerOption>`
matching this UI's shape -- so referee and cross-asset-option fields
here are **not** "pending contract", they match what's merged. What
*is* still pending the redeploy (per the existing section below):
actually opening/taking on NEP-141/intents rails, and the
`taker_account`-as-`TakerAllow::Account` direct-challenge wiring (the
UI collects it and validates against it, but `buildOpenMsg` doesn't
yet set `taker_allow` from it -- flagged, not faked).

## Invite by link (IN1)

- Create offer -> "Invite by link" opens the offer with `taker_allow = {"InvitePubkey": "<64 hex>"}` (raw 32-byte ed25519 pubkey, hex; parsed by `verify_sig`/`hex_decode` in `contracts/escrow/src/lib.rs`). Not combinable with a named direct challenge.
- The ephemeral secret key is stored only in this browser's `localStorage` (`praetorial:invite-key:v1:<pubkey>`); it is never sent anywhere, logged, or put in the envelope or a URL. Clearing browser data or switching browsers loses the ability to make new links (cancel and re-open instead).
- After open, the maker opens the bet page, enters the invitee's account and copies the link `?bet=<id>&invite=<128-hex sig>`; the signature is over `praetorial:invite:v1:{bet_id}:{invitee}`, so each link works only for that account. The Take screen (TK1) reads it.

## Run it
```
cd apps/web
npm install
npm run dev              # http://localhost:3000
```
Playwright (needs `PRIVY_TEST_EMAIL`/`PRIVY_TEST_OTP` in env, never
printed/committed):
```
set -a; source $PRAETORIAL_SECRETS_DIR/praetorial-privy.env; set +a
npx playwright test
```
Last run (2026-11-04, v0.2): **14/14 passed** -- `tests/jason-bet.spec.ts`
(6: login+wallet, create Jason-preset offer, structured review card,
pending-redeploy note shown honestly, live bet-page RPC read, mutual
settle explainer) + `tests/term-sheet-and-referee.spec.ts` (8: Jason
preset structure, custom-claim flags block opening, fixing flags
unblocks it, cross-asset taker options off the single asset table
(BTC correctly disabled on testnet, no placeholder id), direct-challenge
`buildOpenMsg`/`taker_allow` wiring, Person-mode picker, referee-can't-be-taker
validation, Person review-card line). `npx tsc -p tsconfig.json --noEmit` is clean; `npm run build`
(tsc + `vite build`) produces a deployable `dist/`.

## v0.2 changes (this pass)
1. **Direct challenges**: `lib/escrowAdapter.ts`'s `buildOpenMsg` now
   takes an optional `takerAccount` and sets
   `taker_allow = TakerAllow::Account(taker)` when one is named;
   offers with no named taker stay `TakerAllow::Any` (public),
   unchanged. Covered by a new Playwright test.
2. **Single asset table** (`lib/assets.ts`): USDC (testnet
   `nep141:usdc.testnet` / mainnet's real bridged-USDC nep141 id),
   omni BTC (mainnet `nep141:btc.omft.near`; no testnet id is published
   yet, so BTC is explicitly disabled on testnet rather than guessed --
   the old placeholder `nep141:btc.testnet` "wBTC" id is gone), and
   wNEAR (`wrap.near`/`wrap.testnet`). `lib/config.ts` and
   `CreateOffer.tsx`'s cross-asset whitelist both read from this one
   table now.
3. **Curated venue lists per asset** (`lib/venues.ts`): BTC-USD ->
   Coinbase/Bitstamp/Kraken/Gemini, extendable per asset pair. The
   term-sheet validator (`lib/termSheet.ts`) refuses any venue outside the
   curated list for its asset, with a clear message, instead of
   silently skipping it.
## Network table (WEBNET1, D-WEBNET1)

All chain/service addresses live in `lib/network.ts` (`NETWORKS.testnet` / `NETWORKS.mainnet`), selected by
`NETWORK_ID` / `VITE_NETWORK_ID` (default `testnet`, via `lib/networkSelect.ts`); per-field env overrides win.
`lib/config.ts` re-exports. Mainnet has no Worker URLs: callers fail closed with "service not configured".

Read-only RPC view against the testnet escrow from the table (2026-11-09, `test.rpc.fastnear.com`):
`is_paused` on `praetorial-frz2-2611091914.praetorial-dev-1101.testnet` -> `false` (block 276967987).

## Testnet preview (WEBDEP1, D-WEBDEP1)

Live testnet-only preview: **https://praetorial-web-testnet.familiarcow.workers.dev** (Cloudflare Workers Free, static assets +
a tiny proxy Worker, workers.dev only, no routes, no mainnet).

- Deploy: `cd apps/web && set -a; source $PRAETORIAL_SECRETS_DIR/praetorial-cloudflare.env; set +a; npm run deploy:testnet`
  (`build:testnet` forces `NETWORK_ID=testnet`; config is `wrangler.testnet.toml`).
- The indexer/relayer/registry Workers send no CORS headers for this origin, so the Worker (`worker/index.ts`) proxies
  `/_proxy/{indexer,relayer,registry}/*` to them via service bindings; the build points those URLs at the proxy paths.
- **Source-check URL (WEBSRC1, D-SRCW1)**: `lib/networkSelect.ts` selects it like the registry: `TESTNET_SOURCECHECK_URL` (deployed
  `praetorial-sourcecheck-testnet` Worker), `MAINNET_SOURCECHECK_URL` (placeholder on the same workers.dev subdomain; `vite build`
  refuses a mainnet build while it is unchanged, `assertSourcecheckDeployReady`), `VITE_SOURCECHECK_URL` overrides. It is called
  directly (no `/_proxy`): the sourcecheck Worker sends CORS for the preview origin and `localhost:3000/5173`
  (`SOURCECHECK_ALLOWED_ORIGINS`). Mocked e2e pins `localhost:8790` via `playwright.config.ts`. `@live` check:
  `PW_LIVE=1 npx playwright test tests/sourcecheck-live.spec.ts` (must run on port 3000; real Worker, signature verified under the
  escrow's `resolver_keys()[1]`).
- Smoke: `DEPLOYED_URL=<url> npm run test:deployed` (`@deployed`, separate config; never part of the mocked run or `./test.sh fast`).
- **Privy login does not work on this origin yet**: Privy's `frame-ancestors` allow-list rejects it. familiarcow must add
  `https://praetorial-web-testnet.familiarcow.workers.dev` to the Privy app's allowed origins (app `cmw1b5stc01q60glap4q18que`).
  Nothing renders without login there: since LOGIN1 (UX-29) every logged-out route shows only the login page.

## Astryx design system (ASTRYX1)

- Stack: React 19, `@astryxdesign/core` 0.7.11 + `@astryxdesign/theme-neutral` + `@stylexjs/stylex`, pre-compiled CSS path (no StyleX build plugin). CSS is imported once in `src/styles.css`; agent docs are in `AGENTS.md` (`npx @astryxdesign/cli component <Name>` to look up a component).
- **Light mode only.** `src/main.tsx` wraps the app in `<Theme theme={praetorialTheme} mode="light">`, `:root { color-scheme: light }`, no dark theme, no toggle, nothing follows `prefers-color-scheme`. The brand accent and typography live in `src/theme/praetorialTheme.ts` (`defineTheme({ extends: neutralTheme, tokens })`; accent is a single value, never a `[light, dark]` tuple).
- `src/ui.tsx` holds thin adapters (`Button`, `Banner`, `Card`) that keep native-shaped props (`disabled`, `data-testid`, `onClick`, `children`) so screens and tests keep their selectors. To restyle a new screen: import from `../ui` instead of writing `<button>`/bordered divs; native `<input>/<select>/<label>/<table>` are styled from the theme tokens in `src/styles.css`. ASTRYX1b (done): `ui.tsx` also has `TextField`, `TextAreaField`, `CheckField` (Astryx TextInput/TextArea/CheckboxInput with native-shaped `onChange(e)`), `Alert`, `ClickCard`; inline error divs are Astryx `Banner`s (role/testids kept); BetType cards are `ClickableCard`, list rows are `Card`, the nav is `TopNav`. Gaps: native `<select>` (maker-asset, settlement-period, offer-expiry, guided/cb selects, take-asset, browse filters) and the `decider` radios stay native (token-styled) because tests rely on `selectOption`/native radio semantics; the always-present empty `term-sheet-flags`/`review-flags` containers stay plain divs.
