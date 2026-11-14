# MODAL1c5 screenshots (username, add money / move, withdraw modals)

Regenerate: `UPDATE_SCREENS=1 PW_CI=1 PLAYWRIGHT_BASE_URL=http://localhost:<port> npx playwright test tests/account-modals.spec.ts`.
Each shot is taken after an axe check (0 serious/critical). `-375` = bottom sheet, `-1280` = centred dialog.

- `username-1-first-login`, `username-2-error` (claim refused, form kept), `username-3-change` (Settings rename)
- `add-money-1-open` (Add money modal, `/add-money?asset=USDC&need=30`)
- `move-1-confirm` (amount, asset, destination, no fee), `move-2-failure` (Try again), `move-3-success`
- `withdraw-1-amount`, `withdraw-2-confirm`, `withdraw-3-failure`, `withdraw-4-success`
