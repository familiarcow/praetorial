// FE6 (S6) + C1 (UIR1 §3.4, familiarcow UX-37 #5): the source check on the review. It runs by itself when Review opens (App, lib/createFlow
// autoCheckOnEnter: at most one automatic paid check per reviewed offer), so this is a status line -- "Checking sources…", then
// "Checking sources… ✓" -- with at most ONE button (Retry / Check again; lib/createFlow preflightView). Presentational: App owns the
// check and the attestation. AI mode only (human mode renders <HumanNoPreflight/>, which makes no model call).
import { useEffect, useMemo, useState } from "react";
import { Button } from "../ui";
import { Notice } from "../kit";
import { PREFLIGHT_STEPS, type PlainFailure } from "../../lib/sourcePreflight";
import { checkedLine, preflightView, type CheckState } from "../../lib/createFlow";

export type PreflightState = CheckState;

export function HumanNoPreflight({ failed = false, failure = null, onRetry, recheck = false, message = null }: { failed?: boolean; failure?: PlainFailure | null; onRetry?: () => void; recheck?: boolean; message?: string | null }) {
  // D-FE6B1: the contract still needs a resolver-signed attestation to Open; App gets it silently. No AI is involved, so no preflight UI.
  return (
    <div data-testid="human-no-preflight">
      <p>No AI is used, so there is nothing to check.</p>
      {failed && (
        <div data-testid="human-attest-error">
          <p>{failure?.state === "rate-limited" ? failure.headline : failure?.detail ? "We couldn't get this bet ready to open. The source check said:" : "We couldn't get this bet ready to open. Try again in a moment."}</p>
          {failure?.detail && <p data-testid="human-attest-reason">{failure.detail}</p>}
          <Button data-testid="human-attest-retry" onClick={onRetry}>Try again</Button>
        </div>
      )}
      {/* REVIEW1 (#10, CRT-6): the check ran out (or had to be redone) and the one automatic re-check is used up: say why, offer a button. */}
      {!failed && message && !recheck && <p data-testid="human-attest-notice">{message}</p>}
      {!failed && recheck && (
        <div data-testid="human-attest-recheck">
          <p>{message ?? "The check that lets this bet open has run out. Check it again to open the bet."}</p>
          <Button data-testid="human-attest-recheck-btn" onClick={onRetry}>Check again</Button>
        </div>
      )}
    </div>
  );
}

export default function SourcePreflight(props: {
  state: PreflightState;
  /** Accepted for RefereeChange (B1); the line no longer prints the UTC check time (dates are relative, UX-37 #6). */
  checkedAtNs?: string | null;
  failure: PlainFailure | null;
  plainMessage: string | null; // any other failure text (already plain English)
  /** The one button: run the check again (Retry / Check again / Check the sources). */
  onCheck: () => void;
  onFix: () => void;
  onUsePerson: () => void;
  /** REVIEW1 (#10): ms left on the approval, computed by App from chain + monotonic time (never the device clock). App handles expiry. */
  leftMs: number | null;
}) {
  const { state, failure, plainMessage, onCheck, onFix, onUsePerson, leftMs } = props;
  const [, setTick] = useState(0);
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!(state === "failed" && failure?.waitMs)) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [state, failure]);
  useEffect(() => {
    if (state !== "checking") { setStep(0); return; }
    const t = setInterval(() => setStep((s) => Math.min(s + 1, PREFLIGHT_STEPS.length - 1)), 1500);
    return () => clearInterval(t);
  }, [state]);
  // WEBRL1: a 429 with a known wait keeps the button off until that wait is over.
  const failedAt = useMemo(() => Date.now(), [failure]);
  const waiting = state === "failed" && !!failure?.waitMs && Date.now() < failedAt + failure.waitMs;
  const v = preflightView({ state, failure, waiting });
  const left = state === "ok" ? checkedLine(leftMs) : null;
  return (
    <section data-testid="preflight-step" data-state={state} className="k-stack">
      {v.line && (
        <p data-testid="source-check-status" data-state={state} data-tone={v.tone} role="status">
          {v.line}{left && <span data-testid="preflight-time-left" className="k-muted"> {left}</span>}
        </p>
      )}
      {state === "checking" && (
        <ol data-testid="preflight-progress" className="k-small k-muted">
          {PREFLIGHT_STEPS.map((s, i) => <li key={s} data-done={i < step ? "1" : "0"} data-active={i === step ? "1" : "0"}>{s}{i === step ? "…" : i < step ? " ✓" : ""}</li>)}
        </ol>
      )}
      {state === "expired" && <Notice tone="warn" data-testid="preflight-expired" title="This check has run out. Check the sources again to open the bet." />}
      {state === "idle" && plainMessage && <Notice tone="info" data-testid="preflight-note" title={plainMessage} />}
      {state === "failed" && (
        <Notice tone="bad" data-testid="source-check-error" title={failure ? failure.headline : plainMessage ?? "The check didn't work. Try again."}
          body={(failure?.lines.length || failure?.detail) ? (<>
            {failure.lines.length > 0 && <span className="k-stack">{failure.lines.map((l, i) => <span key={i} data-testid={`preflight-failure-line-${i}`}>{l.source}: {l.reason}</span>)}</span>}
            {failure.detail && <span data-testid="preflight-failure-detail">{failure.detail}</span>}
          </>) : undefined} />
      )}
      {(v.button || v.offerFix) && (
        <div className="k-actions">
          {v.button && <Button data-testid="check-sources-btn" disabled={v.button.disabled} onClick={onCheck}>{v.button.label}</Button>}
          {v.offerFix && <Button variant="ghost" data-testid="preflight-fix" onClick={onFix}>Fix the bet</Button>}
          {v.offerFix && <Button variant="ghost" data-testid="preflight-use-person" onClick={onUsePerson}>Let a person decide instead</Button>}
        </div>
      )}
    </section>
  );
}
