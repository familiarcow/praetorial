// F4 (FUND4 SPEC §4.6): the live tracker for one Add money deposit, in two sizes from ONE view model (lib/fundSheet.trackerView):
//   full    — inside the sheet: the 4-step stepper (Sent → Confirming → Converting → In your balance), the state's sentence, why
//             (refunds), and the state's buttons (Back to your bet / Place a bet / Get a new address / Get help);
//   compact — one line + a thin progress bar, for the header strip on every page (the toast is lib/fundSheet.toastFor).
import React, { useState } from "react";
import type { SwapRecord } from "../../../lib/funding/types";
import { COPY } from "../../../lib/funding/copy";
import { trackerView, compactLine, progressOf, helpText, type TrackerCta } from "../../../lib/fundSheet";
import { Notice } from "../../kit";
import { Button } from "../../ui";

const NOTICE_TONE = { info: "info", good: "good", warn: "warn", bad: "bad" } as const;

export function Tracker({ record, now, onCta }: { record: SwapRecord; now: number; onCta: (cta: Exclude<TrackerCta, "help">) => void }) {
  const v = trackerView(record, now);
  const [copied, setCopied] = useState(false);
  const help = async () => {
    try { await navigator.clipboard.writeText(helpText(record, now)); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
  };
  const label: Record<TrackerCta, string> = { back: COPY.track.backCta, bet: COPY.track.betCta, "new-address": COPY.add.newAddressCta, help: copied ? COPY.add.copied : COPY.track.helpCta };
  return (
    <section className="fund-track" data-testid="fund-tracker" data-state={record.state} aria-live="polite">
      {v.steps.length > 0 && (
        <ol className="fund-steps" data-testid="fund-steps">
          {v.steps.map((s) => (
            <li key={s.label} data-status={s.status} data-testid={`fund-step-${s.status}`} aria-current={s.status === "current" ? "step" : undefined}>
              <span className="fund-steps__dot" aria-hidden="true">{s.status === "done" ? "✓" : ""}</span>{s.label}
            </li>
          ))}
        </ol>
      )}
      <Notice tone={NOTICE_TONE[v.tone]} title={<span data-testid="fund-track-message">{v.message}</span>}
        body={v.reason ? <span data-testid="fund-track-reason">{v.reason}</span> : undefined} data-testid="fund-track-notice" />
      {v.ctas.length > 0 && (
        <div className="k-actions">
          {v.ctas.map((c) => (
            <Button key={c} variant={c === "help" ? "secondary" : "primary"} data-testid={`fund-cta-${c}`}
              onClick={() => (c === "help" ? void help() : onCta(c))}>{label[c]}</Button>
          ))}
        </div>
      )}
    </section>
  );
}

export function TrackerCompact({ record, onOpen }: { record: SwapRecord; onOpen?: () => void }) {
  const pct = Math.round((progressOf(record) / 4) * 100);
  const line = compactLine(record);
  const inner = (<>
    <span className="fund-compact__text" data-testid="fund-compact-text">{line}</span>
    <span className="fund-compact__bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
  </>);
  return onOpen
    ? <button type="button" className="fund-compact" data-testid="fund-compact" data-state={record.state} onClick={onOpen}>{inner}</button>
    : <span className="fund-compact" data-testid="fund-compact" data-state={record.state}>{inner}</span>;
}
