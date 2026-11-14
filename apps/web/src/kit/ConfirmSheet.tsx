// K0 (UIR1 §2.2 / §3.6): every one-step money confirm. No progress bar for one step; what you pay in the body (KeyValue), short
// labels on the buttons, stacked full width (primary on top) on phones; `danger` uses the destructive button. Built on the one
// modal shell (src/modal/Modal.tsx: bottom sheet at <= 480 px). `inline` draws the same content as a card (the /kit preview).
import React from "react";
import { Modal } from "../modal/Modal";
import { Button } from "../ui";
import { KeyValue, type KVRow } from "./blocks";
import "./kit.css";

export interface ConfirmSheetProps {
  open?: boolean;
  title: string;
  rows: KVRow[];
  /** One plain sentence on what can't be undone / what it costs. */
  risk?: React.ReactNode;
  children?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  inline?: boolean;
}

export function ConfirmSheet({ open = true, title, rows, risk, children, confirmLabel, cancelLabel = "Cancel", danger = false, busy = false, onConfirm, onCancel, inline = false }: ConfirmSheetProps) {
  const footer = (
    <div className={`k-actions k-actions--stack k-sheet__footer${danger ? " k-danger-fill" : ""}`} data-kit="ConfirmSheet-actions">
      <Button data-testid="confirm-sheet-confirm" variant={danger ? "destructive" : "primary"} disabled={busy} onClick={onConfirm}>{confirmLabel}</Button>
      <Button data-testid="confirm-sheet-cancel" variant="secondary" disabled={busy} onClick={onCancel}>{cancelLabel}</Button>
    </div>
  );
  const body = (
    <>
      <KeyValue variant="total" rows={rows} />
      {children}
      {risk != null && <p className="k-sheet__risk">{risk}</p>}
    </>
  );
  if (inline) {
    return (
      <section className="k-card k-sheet-preview" data-kit="ConfirmSheet" data-danger={danger ? "1" : "0"} aria-label={title}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        {body}
        {footer}
      </section>
    );
  }
  return (
    <Modal isOpen={open} title={title} busy={busy} onRequestClose={onCancel} footer={footer} data-testid="confirm-sheet">
      <div data-kit="ConfirmSheet" data-danger={danger ? "1" : "0"}>{body}</div>
    </Modal>
  );
}
