// K0 (UIR1 §2): the UI kit. Screens import from here (wave 2 migrates them); src/objects/* re-exports what moved.
// Data: lib/betView.ts (betView, the one view model + wording), lib/money.ts (the one amount rule), lib/dates.ts (the one date
// formatter), lib/betLifecycle.ts phaseOf (the one bet phase). Playground: /kit (VITE_KIT=1 builds only; src/kit/Playground.tsx).
export { Amount, Amounts, AssetLogo, UserChip, DeciderChip, StatusPill, TimeLeft, Disclosure, KeyValue, ActionBar, Notice, EmptyState, type KVRow, type NoticeTone } from "./blocks";
export { BetCard, BetHeader, ActionCard, RulingCard, PayoutCard, ActivityList, BetDetails, MoreActions, ReviewSummary, Sides, type BetCardVariant } from "./cards";
export { DetailsCard, DetailRow, BetTerms, BetSources, JudgeInfo, RulingHistory, ExhibitList, MoneyDeadlines, AccountDetails, CopyButton, HashText, UrlChip, WhenText, PersonName, RawBlock, DETAIL_SECTIONS, type DetailSection } from "./details";
export { ConfirmSheet, type ConfirmSheetProps } from "./ConfirmSheet";
// V1: verify every action (lib/verify.ts builds the data).
export { VerifySheet, VerifyBody, VerifyRow, ActionReceipt, VerifyToggle, PersonId, type VerifySheetProps } from "./verify";
export { ToastProvider, useToast } from "./Toast";
// SM2: the cross-machine gate (lib/appState.ts). useGate(action) / <GateNotice action=.../> for every user action.
export { AppStateProvider, useAppState, useGate, GateNotice, type GateFixes } from "./Gate";
