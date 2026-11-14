import React from "react";
import { Modal } from "./Modal";
import { Button } from "../ui";

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  /** Plain words: exactly what will happen (amount, fee, asset) before the button. */
  children: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** testid prefix for the two buttons: `${prefix}-ok` / `${prefix}-cancel`. */
  testIdPrefix?: string;
  /** Override the button testids when ok/cancel are not the right words (e.g. discard-keep / discard-confirm). */
  testIds?: { ok: string; cancel: string };
}

/** One question, two buttons. For single-step irreversible actions; multi-step flows use FlowModal. */
export function ConfirmDialog({ isOpen, title, children, confirmLabel, cancelLabel = "Cancel", destructive, busy, onConfirm, onCancel, testIdPrefix = "confirm", testIds }: ConfirmDialogProps) {
  return (
    <Modal isOpen={isOpen} title={title} busy={busy} width={400} onRequestClose={onCancel}
      footer={<>
        <Button data-testid={testIds?.cancel ?? `${testIdPrefix}-cancel`} variant="secondary" disabled={busy} onClick={onCancel}>{cancelLabel}</Button>
        <Button data-testid={testIds?.ok ?? `${testIdPrefix}-ok`} variant={destructive ? "destructive" : "primary"} disabled={busy} onClick={onConfirm}>{confirmLabel}</Button>
      </>}>
      <div style={{ lineHeight: 1.5 }}>{children}</div>
    </Modal>
  );
}
