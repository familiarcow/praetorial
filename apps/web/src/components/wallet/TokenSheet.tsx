// F3 (FUND4 SPEC §3 "Tapping a row opens a token sheet"): every place this token sits (betting balance, NEAR account, in bets,
// being paid out) and its actions: Add money, Move to betting (when the NEAR account holds it), Cash out to my NEAR account
// (USDC/USDT/NEAR only, MON-3). F5: Cash out (any network, user-signed) and Convert (into another of the 6) open F5's sheets.
import React from "react";
import { Modal } from "../../modal/Modal";
import { Button } from "../../ui";
import { KeyValue, type KVRow } from "../../kit";
import { COPY } from "../../../lib/funding/copy";
import { MONEY_HIDDEN } from "../../../lib/globalStates";
import { canCashOutToNear, type AccountRow } from "../../../lib/walletCards";
import type { Holding } from "../../../lib/moveToBetting";
import { moveLabel } from "./AssetRow";

export function TokenSheet({ row, stale, allowed, onAddMoney, onMove, onCashOutToNear, onCashOut, onConvert, onClose }: {
  row: AccountRow; stale: boolean;
  allowed: { addMoney: boolean; cashOut: boolean; move: boolean; convert?: boolean };
  onAddMoney: () => void; onMove: (h: Holding) => void; onCashOutToNear: () => void; onCashOut?: () => void; onConvert?: () => void; onClose: () => void;
}) {
  const s = row.symbol;
  const show = (t: string | null) => (t === null ? "…" : stale ? MONEY_HIDDEN : t);
  const strip = (t: string, prefix: string) => t.replace(prefix, "");
  const rows: KVRow[] = [
    { id: "betting", label: COPY.account.totalLabel, value: <span data-testid="token-sheet-betting">{show(row.bettingText)}</span>, emphasis: true },
    ...(row.nearText ? [{ id: "near", label: "In your NEAR account", value: show(strip(row.nearText, "In your NEAR account: ")) }] : []),
    ...(row.inBetsText ? [{ id: "bets", label: "In bets", value: row.inBetsText.startsWith("Can't") ? row.inBetsText : show(strip(row.inBetsText, "In bets: ")) }] : []),
    ...(row.payoutText ? [{ id: "paying", label: COPY.account.payoutsTitle, value: show(strip(row.payoutText, `${COPY.account.payoutsTitle}: `)) }] : []),
  ];
  const cashOutNear = canCashOutToNear(s) && (row.betting ?? 0n) > 0n;
  return (
    <Modal isOpen title={s} onRequestClose={onClose} data-testid={`token-sheet-${s}`}>
      <div className="acct-sheet">
        <KeyValue variant="total" rows={rows} />
        <div className="k-actions k-actions--stack">
          <Button variant="primary" disabled={!allowed.addMoney} data-testid={`token-add-money-${s}`} onClick={onAddMoney}>{COPY.account.addMoney}</Button>
          {row.moves.map((h) => (
            <Button key={h.source} disabled={!allowed.move} data-testid={`sheet-move-${h.symbol}-${h.source}`} onClick={() => onMove(h)}>{moveLabel(h)}</Button>
          ))}
          {onCashOut && (row.betting ?? 0n) > 0n && <Button disabled={!allowed.cashOut} data-testid={`token-cash-out-${s}`} onClick={onCashOut}>{COPY.account.cashOut}</Button>}
          {onConvert && (row.betting ?? 0n) > 0n && <Button disabled={allowed.convert === false} data-testid={`token-convert-${s}`} onClick={onConvert}>{COPY.account.convert}</Button>}
          {cashOutNear && (
            <Button disabled={!allowed.cashOut} data-testid={`withdraw-btn-${s}`} onClick={onCashOutToNear}>{COPY.cashOut.nearTitle}</Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
