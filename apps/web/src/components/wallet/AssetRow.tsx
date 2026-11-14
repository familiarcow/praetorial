// F3 (FUND4 SPEC §3): one row per bet token. Logo + symbol + the betting balance (token units, lib/money.ts via the row model);
// under it, only when non-zero, "In your NEAR account: …" with its Move button and "In bets: …". Zero rows are one compact muted
// line. Tapping the row opens the token sheet (every other action lives there, not on the row).
import React from "react";
import { Button } from "../../ui";
import { AssetLogo } from "../../kit";
import { formatMoney } from "../../../lib/money";
import { MONEY_HIDDEN } from "../../../lib/globalStates";
import type { AccountRow } from "../../../lib/walletCards";
import type { Holding } from "../../../lib/moveToBetting";

export function moveLabel(h: Holding): string {
  return `Move ${formatMoney({ units: BigInt(h.amountUnits), symbol: h.symbol }).text}${h.source === "token" && h.symbol === "NEAR" ? " (wrapped)" : ""} to betting`;
}

export function AssetRow({ row, stale, failed, moveAllowed, onOpen, onMove }: {
  row: AccountRow; stale: boolean; failed: boolean; moveAllowed: boolean; onOpen: () => void; onMove: (h: Holding) => void;
}) {
  const s = row.symbol;
  const amount = failed ? "Can't read" : row.bettingText === null ? "…" : stale ? MONEY_HIDDEN : row.bettingText;
  return (
    <li className={`acct-row${row.compact ? " acct-row--compact" : ""}`} data-testid={`asset-card-${s}`} data-compact={row.compact ? "1" : "0"}>
      <button type="button" className="acct-row__main" data-testid={`asset-row-${s}`} onClick={onOpen}>
        <span className="acct-row__token"><AssetLogo symbol={s} size={row.compact ? "1.4em" : "1.9em"} /><span className="acct-row__sym">{s}</span></span>
        <span className="acct-row__amount" data-testid={`balance-row-${s}`}>{amount}</span>
        <span className="acct-row__chev" aria-hidden="true">›</span>
      </button>
      {row.nearUnreadable && <p className="acct-row__line k-muted" data-testid={`wallet-amount-${s}`}>In your NEAR account: can't read right now</p>}
      {row.nearText && (
        <div className="acct-row__line">
          <span data-testid={`wallet-amount-${s}`}>{stale ? MONEY_HIDDEN : row.nearText}</span>
          {row.moves.map((h) => (
            <Button key={`${h.symbol}-${h.source}`} size="sm" variant="primary" disabled={!moveAllowed} data-testid={`move-${h.symbol}-${h.source}`} onClick={() => onMove(h)}>
              {moveLabel(h)}
            </Button>
          ))}
        </div>
      )}
      {row.inBetsText && <p className="acct-row__line k-muted" data-testid={`in-bets-${s}`}>{stale && !row.inBetsText.startsWith("Can't") ? MONEY_HIDDEN : row.inBetsText}</p>}
      {row.payoutText && <p className="acct-row__line k-muted" data-testid={`paying-${s}`}>{stale ? MONEY_HIDDEN : row.payoutText}</p>}
    </li>
  );
}
