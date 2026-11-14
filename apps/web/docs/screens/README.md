# Screenshots index

Per-item folders (each has its own README where the flows are listed). All taken at 375 px (bottom sheet) and 1280 px (centred dialog), light mode only (UX-24), after an axe check (0 serious/critical).

- `modal1a/`, `modal1b/`, `modal1c1/` (create bet), `modal1c2/` (take bet), `modal1c3/`, `modal1c4/`, `modal1c5/`: mocked-e2e shots, regenerate with `UPDATE_SCREENS=1 ... npx playwright test <spec>`.
- `modal1d/`: the same create and take flows driven LIVE on the deployed testnet site (real Privy test login, real relayer, real chain). Regenerate with
  `UPDATE_SCREENS=1 DEPLOYED_URL=https://praetorial-web-testnet.familiarcow.workers.dev npm run test:deployed` (set `LIVE_BET_ID=<id>` to run `@live 6` alone). A plain run writes nothing here (SHOTS1).
- `browse1/`: Browse open bets as readable cards (BROWSE1), mocked e2e: `browse-375.png`, `browse-1280.png`. Regenerate with `UPDATE_SCREENS=1 npx playwright test browse-cards -g screenshot`.

## modal1d (live, deployed testnet)

Create bet (maker, Privy test login), each as `-375.png` and `-1280.png`:
- `create-1-bet-type`, `create-2-fill`, `create-3-stake`, `create-4-review-sources`, `create-5-success`

Take bet (second account, fresh testnet implicit account signing through the app's e2e wallet seam; see `@live 6`):
- `take-1-terms`, `take-2-confirm`, `take-3-success`

Withdraw to wallet (`@live 4`, via the Withdraw modal):
- `withdraw-1-amount`, `withdraw-2-review`, `withdraw-3-done`

Tx hashes and bet ids from the runs are recorded in the MODAL1d build-log entry (vault) and the commit messages.

KEEPSUBMIT1W (`keepsubmit1w/`, from `tests/keepsubmit1w.spec.ts`): the "Apply the judge's ruling" fallback on a Resolving bet — `button-{375,1280}`, `refused-{375,1280}` (contract refusal message).
