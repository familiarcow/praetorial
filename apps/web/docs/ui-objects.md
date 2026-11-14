# UI objects and containers (MODAL1a, MODAL1b)

Plain-words design for the "modal-ize the frontend" work. MODAL1a shipped the **containers**, MODAL1b the **objects** below; flows (MODAL1c) build on both.

## Rule of thumb
- **Money-moving and multi-step flows are modals** (create a bet, take a bet, fund escrow, cancel, concede, change referee). The user stays on their page, sees one task, and gets a clear end state.
- **Browsing and reading stay full-page** (landing, browse, my bets, a bet's page, judges, settings).
- Light mode only (UX-24). Astryx is the look. Copy is plain words.

## Where the code lives
- `apps/web/src/modal/` holds the React containers. `apps/web/lib/flowModal.ts` and `lib/modalLogic.ts` hold the logic with no React, so `tsx --test` can test it (same split as the rest of `lib/`).
- It sits beside `src/ui.tsx`, not inside it. `ui.tsx` is thin adapters for single widgets (Button, Card, fields); containers are bigger, stateful and will keep growing. They import `Button` from `ui.tsx` and wrap Astryx `Dialog` / `Drawer` instead of re-implementing focus handling.

## Containers
| Container | Use it for | Behaviour |
|---|---|---|
| **Modal** | One focused task or message | Centered on desktop; **bottom sheet at 480px and below**. Focus trap, Esc and overlay click close, page scroll locked, `role=dialog aria-modal=true`, `aria-labelledby` the title, focus returns to the opener. `busy` blocks every way of closing. |
| **Drawer** | Side panel for secondary stuff (filters, details) | Same close rules. Never money-moving. |
| **ConfirmDialog** | One question, two buttons ("Cancel this offer?") | Says exactly what will happen. `destructive` makes the confirm button red. Use FlowModal for more than one step. |
| **FlowModal** | Multi-step and money-moving flows | Stepper with progress bar, Back / Next, per-step validation gate, saved draft, "Discard this?" guard, busy state, final step. |

## Flow states (FlowModal)
`editing -> busy -> success | pending | failure`
- **editing**: the user fills steps. Next is blocked with a plain-words message when the step's `validate` returns one.
- **busy**: the tx is in flight. Close, Back, Next and edits are all blocked, so a half-sent action can't be abandoned.
- **success**: "Done" plus TxLink. Draft deleted.
- **pending**: sent but not confirmed yet ("still confirming") plus TxLink. Safe to close.
- **failure**: a plain-words reason (say whether money moved) and **Try again**, which returns to the last step with values kept.

**Draft**: while editing, the step and values are saved in `sessionStorage` under `flowdraft:<key>` and restored the next time the flow opens in that tab. Busy and finished states are never saved. Missing or corrupt storage is ignored.
**Discard guard**: closing a flow that is past step 1 or has typed values asks "Discard this?" (Keep editing / Discard). Discard deletes the draft.

## Dev harness
`/__harness/modals` mounts every container for tests. It loads through a dynamic import behind `import.meta.env.DEV` in `main.tsx`, so `vite build` drops it. A unit test asserts the guard and that nothing imports it statically.

## Objects (MODAL1b)
React in `apps/web/src/objects/` (import from `../objects`); logic with no React in `lib/amount.ts` and `lib/uiObjects.ts`, covered by `tests/uiObjects.unit.test.ts`. Every object passes `data-*` props through, so existing test ids stay. Numbers come from contract views / `lib/release.json` via `lib/assets.ts` and `lib/stakeDeadlines.ts`; nothing is typed in.

| Object | Use it for | Notes |
|---|---|---|
| **Amount** | Any money value | Base units (bigint or string) at the asset's own decimals. BigInt only, never a float. `$` for USDC/USDT, `<n> SYMBOL` otherwise; `cents` pads dollars to 2 places; `plain` drops the symbol. All six assets (USDC, USDT, BTC, ZEC, ETH, NEAR), no stake caps. |
| **AssetBadge** | Naming an asset | Shows "mainnet only" for an asset not live on this network. |
| **AccountChip** | A NEAR account | Shortens 64-hex implicit ids (first 6 + last 4), full id in the tooltip; optional `@username`. |
| **StatusPill** | A bet's state | A plain label and tone for every contract BetStatus (Open, Taken, Resolving, Proposed, Challenged, Evidence, Rejudge, Finalized, Settled, Voided, Cancelled, Expired); unknown states say "Unknown". Labels come from `lib/liveBet.statusChip`. |
| **BetSummary** | One bet as a row | Claim, other side, my side, stake, status pill, next date, result, actions (the `mybet-*` ids). |
| **TermSheetView** | A structured term sheet, read only | Claim, sources, deadline, void policy. |
| **SourceList** | The sources a bet is judged from | |
| **SourceCheckResult** | Outcome of the AI source check | ok (with time left), idle note, expired, failed (plain reason + per-source lines). |
| **TxLink** | A finished or pending transaction | Link to the NEAR explorer for the build's network (moved here from `modal/`). |
| **Countdown** | Time left | `3h 5m`, `2d 5h`, `M:SS`; `0:00` and `data-expired=1` at zero or for a bad target. `msLeft` for a caller's own clock, `targetMs` to self-tick. |
| **FeeBreakdown** | What goes in | Stake, the contract's per-side fee (`sideFee`, minimum floor, capped at the stake), optional referee tip, exact total. Parts sum exactly. |
| **RefereeChip** | Who decides | "AI referee" or the named account. |
| **EmptyState** | Nothing here yet | Sentence plus an optional next step. |
| **ErrorNotice** | A plain-words error | `role=alert`, optional Retry. |
| **Toast** (`ToastProvider`, `useToast`) | A short, non-blocking message | One polite live region, max 3, deduped by id, dismissable. Never for money results: those stay in the flow. |

Migrated to the objects in MODAL1b: My bets rows (BetSummary, StatusPill, EmptyState, ErrorNotice), the bet page status chip (StatusPill), the source-preflight result (SourceCheckResult, Countdown), the modal success/pending line (TxLink), and My bets money text (`formatAmount`). Not migrated yet (MODAL1c, with their flows): create/take/cancel/referee-change money text and fee lines in `stakeDeadlines.ts`.

The harness at `/__harness/modals` shows every object (`tests/ui-objects.spec.ts`: values, all 12 status pills, axe 0 serious/critical at 1280 and 375, screenshots in `docs/screens/modal1b/`). Links inside a sentence are underlined (axe `link-in-text-block`).

## Next
MODAL1c1-c5: move each flow into FlowModal using these objects.

## K0: the UI kit (`src/kit/`, UIR1 §2)
New screens use the kit; wave 2 (H1/C1/M1/A1/B1) migrates the old screens onto it. Every kit component takes precomputed data:
- **`lib/betView.ts` `betView(bet, me, nowMs, ctx)`**: the one bet view model. State comes only from **`lib/betLifecycle.ts` `phaseOf(bet, chainNowNs, contractId)`**. `PILL_WORDS` is the only status-wording table. People are `Person` (username first, "You", short id `a1b2…f9e0`); raw account ids appear only in Details' "Account details" row.
- **`lib/money.ts`**: the one amount rule (stables 2 dp; others ≤ 6 significant digits; "< 0.01 X" for tiny stables and fees/storage; exact value kept). Rendered only by `<Amount>`.
- **`lib/dates.ts`**: the one date formatter (relative; exact local + UTC on tap via `<TimeLeft>`).
- Components: `Amount`, `AssetLogo`, `UserChip`, `DeciderChip`, `StatusPill`, `TimeLeft`, `Disclosure`, `KeyValue`, `ActionBar`, `Notice`, `EmptyState`, `Toast`, `BetCard` (mine / offer / public / decide / compact), `BetHeader`, `ActionCard`, `RulingCard`, `PayoutCard`, `ActivityList`, `BetDetails`, `MoreActions`, `ReviewSummary`, `ConfirmSheet`. Styles: `src/kit/kit.css` (theme tokens only).
- `src/objects/Toast` and `src/objects/EmptyState` now re-export the kit; the other objects stay until their screens migrate.

### /kit playground
Every component and every bet state from `tests/fixtures/bets.ts`. Compiled in only with `VITE_KIT=1` (`lib/kitBuild.ts`); a mainnet build with `VITE_KIT=1` fails, and the deploy guard refuses a bundle containing it (`tests/kitBundle.unit.test.ts` builds a real mainnet bundle and checks).
- Local: `VITE_KIT=1 npm run dev`, open `/kit` (`/kit?state=<key>` shows one state).
- Preview: `npm run build:kit` writes `dist-kit/` (testnet network, playground on every path, every network request refused). Host it on a separate non-mainnet URL; never on the mainnet Worker.
- Screenshots: `node ../../spikes/k0/shots.mjs` after `build:kit` (writes `spikes/k0/shots/`).
