import React, { useEffect, useReducer, useRef, useState } from "react";
import { Modal } from "./Modal";
import { ConfirmDialog } from "./ConfirmDialog";
import { TxLink } from "../objects/TxLink";
import { Button } from "../ui";
import "../kit/kit.css";
import { setNavGuard, clearNavGuard } from "../../lib/navGuard";
import {
  initFlow, setValue, goTo, finishStay, goNext, goBack, startBusy, finishSuccess, finishPending, finishFailure, retryFlow,
  progressOf, closeDecision, saveDraft, loadDraft, clearDraft, type FlowStep, type FlowState, type FlowValues, type DraftStorage,
} from "../../lib/flowModal";

export type FlowResult =
  | { kind: "success"; txHash?: string | null; message?: string }
  | { kind: "pending"; txHash?: string | null; message?: string }
  | { kind: "failure"; reason: string }
  /** Back to editing on the same step with values kept (the step already told the user why, e.g. they declined in the wallet). */
  | { kind: "stay" };

export interface FlowApi {
  values: FlowValues; set: (k: string, v: string) => void; error: string | null;
  index: number;
  /** For steps that own their buttons (see `ownNav`). */
  goTo: (i: number) => void;
  /** MODAL1c5: validate the current step (its `validate` message shows under the step) and move to the next one. */
  next: () => void;
  /** Runs the flow's onSubmit with the busy / result handling. */
  submit: () => void;
  busy: boolean;
}

export interface FlowModalProps {
  isOpen: boolean;
  /** Called when the flow is really done with (closed, discarded, or finished). */
  onClose: () => void;
  title: string;
  steps: FlowStep[];
  /** sessionStorage key for the resumable draft. */
  draftKey: string;
  renderStep: (step: FlowStep, api: FlowApi) => React.ReactNode;
  /** Runs on the last step's button. Must resolve to a FlowResult (throw = failure with a generic reason). */
  onSubmit: (values: FlowValues) => Promise<FlowResult>;
  submitLabel: string;
  /** The steps render their own Back/Next/submit buttons (testids and copy stay as they were); the footer shows none while editing. */
  ownNav?: boolean;
  /** Extra content under the "Sending…" line (e.g. live progress). */
  busyNote?: React.ReactNode;
  /** Extra content inside the standard result wrapper: appended for success / pending, and it replaces the plain reason text for failure. */
  renderResult?: (r: { phase: "success" | "pending" | "failure"; txHash: string | null; reason: string | null }) => React.ReactNode;
}

function session(): DraftStorage | null { try { return typeof window !== "undefined" ? window.sessionStorage : null; } catch { return null; } }

export function FlowModal(props: FlowModalProps) {
  // Mount the body only while open so every open starts from the saved draft (or a clean start).
  return props.isOpen ? <FlowBody {...props} /> : null;
}

function FlowBody({ onClose, title, steps, draftKey, renderStep, onSubmit, submitLabel, ownNav, busyNote, renderResult }: FlowModalProps) {
  const [s, setS] = useState<FlowState>(() => initFlow(steps, loadDraft(session(), draftKey)));
  const [asking, setAsking] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { saveDraft(session(), draftKey, s); }, [s, draftKey]);

  const sending = s.phase === "busy";
  useEffect(() => {
    if (!sending) return;
    const here = window.location.pathname + window.location.search;
    setNavGuard(here);
    return () => clearNavGuard(here);
  }, [sending]);

  const last = s.index === steps.length - 1;
  const step = steps[s.index];
  const prog = progressOf(steps, s);

  const requestClose = () => {
    const d = closeDecision(s);
    if (d === "close") onClose();
    else if (d === "confirm-discard") setAsking(true);
  };
  const discard = () => { clearDraft(session(), draftKey); setAsking(false); onClose(); };

  const sRef = useRef(s); sRef.current = s;
  const submit = async () => {
    const s = sRef.current;
    if (s.phase !== "editing") return;
    const checked = goNext(steps, s);
    if (checked.error) { setS(checked); return; }
    const busy = startBusy(s);
    setS(busy);
    let r: FlowResult;
    try { r = await onSubmit(s.values); } catch { r = { kind: "failure", reason: "Something went wrong on our side. Nothing was spent. Try again." }; }
    if (!alive.current) return;
    if (r.kind === "stay") { setS(finishStay(busy)); return; }
    if (r.kind === "failure") { setS(finishFailure(busy, r.reason)); return; }
    clearDraft(session(), draftKey);
    setS(r.kind === "success" ? finishSuccess(busy, r.txHash ?? null) : finishPending(busy, r.txHash ?? null));
  };

  const api: FlowApi = { values: s.values, set: (k, v) => setS((p) => setValue(p, k, v)), error: s.error, index: s.index, goTo: (i) => setS((p) => goTo(steps, p, i)), next: () => setS((p) => goNext(steps, p)), submit: () => { void submit(); }, busy: s.phase === "busy" };
  const busy = s.phase === "busy";

  let body: React.ReactNode;
  let footer: React.ReactNode;
  if (s.phase === "success") {
    body = <div data-testid="flow-success" role="status"><strong>Done.</strong> Your transaction went through.<div><TxLink hash={s.txHash} /></div>{renderResult?.({ phase: "success", txHash: s.txHash, reason: null })}</div>;
    footer = <Button data-testid="flow-done" variant="primary" onClick={onClose}>Close</Button>;
  } else if (s.phase === "pending") {
    body = <div data-testid="flow-pending" role="status"><strong>Sent, still confirming.</strong> The network has your transaction but has not finished it yet. You can close this window; check the link for the result.<div><TxLink hash={s.txHash} /></div>{renderResult?.({ phase: "pending", txHash: s.txHash, reason: null })}</div>;
    footer = <Button data-testid="flow-done" variant="primary" onClick={onClose}>Close</Button>;
  } else if (s.phase === "failure") {
    body = <div data-testid="flow-failure" role="alert"><strong>That did not go through.</strong> {renderResult?.({ phase: "failure", txHash: null, reason: s.reason }) ?? s.reason}</div>;
    // M1: same footer as ConfirmSheet: primary first, stacked full width on phones.
    footer = <div className="k-actions k-actions--stack k-sheet__footer">
      <Button data-testid="flow-retry" variant="primary" onClick={() => setS((p) => retryFlow(steps, p))}>Try again</Button>
      <Button data-testid="flow-done" variant="secondary" onClick={onClose}>Close</Button>
    </div>;
  } else {
    // M1 (UIR1 §3.6): a one-step flow is a confirm sheet: no progress bar and no "1. Confirm" step list.
    const multi = steps.length > 1;
    body = <>
      {multi && <><div data-testid="flow-progress" role="progressbar" aria-label={`Step ${prog.current} of ${prog.total}: ${step.title}`} aria-valuemin={1} aria-valuemax={prog.total} aria-valuenow={prog.current}
        style={{ height: 6, borderRadius: 3, background: "#e5e7eb", marginBottom: 6 }}>
        <div style={{ width: `${prog.percent}%`, height: "100%", borderRadius: 3, background: "#1d4ed8" }} />
      </div>
      <ol aria-label="Steps" style={{ display: "flex", gap: 8, listStyle: "none", padding: 0, margin: "0 0 12px", fontSize: 13 }}>
        {steps.map((st, i) => <li key={st.id} aria-current={i === s.index ? "step" : undefined} style={{ fontWeight: i === s.index ? 700 : 400, color: i === s.index ? "#111827" : "#4b5563" }}>{i + 1}. {st.title}</li>)}
      </ol></>}
      {busy
        ? <div data-testid="flow-busy" role="status">Sending… keep this window open. It can't be closed until the network answers.{busyNote}</div>
        : <>
            {renderStep(step, api)}
            {s.error ? <div data-testid="flow-error" role="alert" style={{ color: "#b91c1c", marginTop: 8 }}>{s.error}</div> : null}
          </>}
    </>;
    footer = ownNav ? null : <>
      <Button data-testid="flow-back" variant="secondary" disabled={busy || s.index === 0} onClick={() => setS(goBack)}>Back</Button>
      {last
        ? <Button data-testid="flow-submit" variant="primary" disabled={busy} onClick={submit}>{submitLabel}</Button>
        : <Button data-testid="flow-next" variant="primary" disabled={busy} onClick={() => setS((p) => goNext(steps, p))}>Next</Button>}
    </>;
  }

  return (
    <>
      <Modal isOpen title={title} busy={busy} onRequestClose={requestClose} footer={footer}>{body}</Modal>
      <ConfirmDialog isOpen={asking} title="Discard this?" confirmLabel="Discard" cancelLabel="Keep editing" destructive testIds={{ ok: "discard-confirm", cancel: "discard-keep" }}
        onConfirm={discard} onCancel={() => setAsking(false)}>
        You haven't finished. If you close now, what you entered is thrown away.
      </ConfirmDialog>
    </>
  );
}
