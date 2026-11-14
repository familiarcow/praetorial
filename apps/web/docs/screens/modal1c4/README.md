# MODAL1c4 screenshots (cancel offer, change referee)

Regenerate with `UPDATE_SCREENS=1 PW_CI=1 npx playwright test tests/offer-admin-modals.spec.ts -g px`. Each file exists at `-375.png` (bottom sheet) and `-1280.png` (dialog).

| Flow | Step | Files |
|---|---|---|
| Cancel offer | 1 confirm: what is refunded, to where, no fee | `cancel-offer-1-confirm-{375,1280}.png` |
| Cancel offer | 2 failure with Try again | `cancel-offer-2-failure-{375,1280}.png` |
| Cancel offer | 3 success after get_bet shows Cancelled | `cancel-offer-3-success-{375,1280}.png` |
| Change referee | 1 confirm: who decides, right away, no money moves | `change-referee-1-confirm-{375,1280}.png` |
| Change referee | 2 failure with Try again | `change-referee-2-failure-{375,1280}.png` |
| Change referee | 3 success after get_bet shows the new referee | `change-referee-3-success-{375,1280}.png` |
