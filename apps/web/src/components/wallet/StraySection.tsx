// F3 (FUND4 SPEC §1 B2 / §3): "Not usable for bets yet" -- tokens in the betting account that aren't one of the 6 (old bridged
// coins, wrong-network deposits, refunds, anything someone sent). Shown only when there is something; an id 1Click doesn't list is
// shown as "Unknown token (…). Contact support." (never hidden); dust is "Too small to convert". Convert lands only in the 6.
// Convert itself is F5's ConvertSheet (src/components/funding/ConvertSheet.tsx), opened by the Account page.
import React from "react";
import { Button } from "../../ui";
import { Notice } from "../../kit";
import { COPY } from "../../../lib/funding/copy";
import { MONEY_HIDDEN } from "../../../lib/globalStates";
import type { StrayRow } from "../../../lib/walletCards";

export function StraySection({ rows, failed, stale, convertAllowed, onConvert }: {
  rows: StrayRow[]; failed: boolean; stale: boolean; convertAllowed: boolean; onConvert: (r: StrayRow) => void;
}) {
  if (failed) return <Notice tone="warn" title={`${COPY.account.strayTitle}: we can't read these right now.`} data-testid="stray-error" />;
  if (!rows.length) return null;
  return (
    <section className="acct-section" data-testid="stray-section">
      <h2 className="acct-section__title">{COPY.account.strayTitle}</h2>
      <ul className="acct-list">
        {rows.map((r) => (
          <li key={r.assetId} className="acct-stray" data-testid="stray-row" data-asset={r.assetId} data-unknown={r.unknown ? "1" : "0"}>
            <span className="acct-stray__title">{r.title}</span>
            {r.amountText && <span className="acct-stray__amount" data-testid="stray-amount">{stale ? MONEY_HIDDEN : r.amountText}</span>}
            {r.note && <span className="k-small k-muted" data-testid="stray-note">{r.note}</span>}
            {r.convertTo && (
              <Button size="sm" disabled={!convertAllowed} data-testid="stray-convert" onClick={() => onConvert(r)}>{COPY.account.convertTo(r.convertTo)}</Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
