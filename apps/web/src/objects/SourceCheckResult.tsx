import React from "react";
import { checkedAtLabel, type PlainFailure } from "../../lib/sourcePreflight";
import { Countdown } from "./Countdown";

export type SourceCheckState = "idle" | "checking" | "ok" | "failed" | "expired";

/** Outcome of the AI source check: ok (with time left), expired, failed (plain reason + per-source lines), or an idle note. */
export function SourceCheckResult({ state, checkedAtNs, leftMs, failure, plainMessage }: { state: SourceCheckState; checkedAtNs: string | null; leftMs: number | null; failure: PlainFailure | null; plainMessage: string | null }) {
  return (
    <>
      {state === "ok" && checkedAtNs && (
        <div>
          <div data-testid="source-check-status">The AI can read these sources. Checked at {checkedAtLabel(checkedAtNs)}.</div>
          <div data-testid="preflight-time-left"><Countdown clock msLeft={leftMs ?? 0} suffix=" left" /></div>
        </div>
      )}
      {state === "idle" && plainMessage && <div data-testid="preflight-note">{plainMessage}</div>}
      {state === "expired" && <div data-testid="preflight-expired">This check has expired. Check the sources again before opening.</div>}
      {state === "failed" && (
        <div data-testid="source-check-error">
          <p>{failure ? failure.headline : plainMessage}</p>
          {failure && failure.lines.length > 0 && (
            <ul>{failure.lines.map((l, i) => <li key={i} data-testid={`preflight-failure-line-${i}`}>{l.source}: {l.reason}</li>)}</ul>
          )}
          {failure?.detail && <p data-testid="preflight-failure-detail">{failure.detail}</p>}
        </div>
      )}
    </>
  );
}
