// F3 (FUND4 SPEC §1 B7-B10 / §3): "1 deposit in progress" at the top of Account, from lib/funding/store (this device + the funding
// Worker's list). One compact line per transfer, in token units. F4's Tracker opens from here once it lands (`onOpen`); until then
// the card only reports, so money that has left the balance never looks lost.
import React from "react";
import { Notice } from "../../kit";
import { inFlightLines, inFlightTitle } from "../../../lib/walletCards";
import type { SwapRecord } from "../../../lib/funding/types";

export function InFlightCard({ records, onOpen }: { records: SwapRecord[]; onOpen?: (id: string) => void }) {
  const title = inFlightTitle(records);
  if (!title) return null;
  const lines = inFlightLines(records);
  return (
    <Notice tone="info" variant="page" title={<><span aria-hidden="true">⟳ </span>{title}</>} data-testid="inflight-card"
      body={
        <ul className="acct-inflight">
          {lines.map((l) => (
            <li key={l.id} data-testid="inflight-line">
              {onOpen ? <button type="button" className="acct-link" onClick={() => onOpen(l.id)}>{l.text}</button> : <span>{l.text}</span>}
              <span className="k-small k-muted"> · {l.state}</span>
            </li>
          ))}
        </ul>
      } />
  );
}
