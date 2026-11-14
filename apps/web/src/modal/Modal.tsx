import React, { useEffect, useId, useLayoutEffect, useRef } from "react";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Button } from "../ui";
import { dismissAction, returnFocus, type DismissReason } from "../../lib/modalLogic";
import { useIsSheet } from "./useSheet";

export interface ModalProps {
  isOpen: boolean;
  /** Called for Esc, overlay click and the X button (never while `busy`). The parent decides whether to actually close. */
  onRequestClose: (why: DismissReason) => void;
  title: string;
  children: React.ReactNode;
  /** Buttons row, pinned under the content. */
  footer?: React.ReactNode;
  /** A transaction is in flight: every way to close is blocked. */
  busy?: boolean;
  width?: number;
  "data-testid"?: string;
}

/**
 * The one centered container (bottom sheet at <=480px). Built on Astryx Dialog, which is a native <dialog>:
 * focus trap, Esc, overlay click, body scroll lock, aria-modal and focus return come from it; we add the busy
 * block, a visible title wired with aria-labelledby, and an explicit return of focus to the opener.
 */
export function Modal({ isOpen, onRequestClose, title, children, footer, busy = false, width = 440, ...rest }: ModalProps) {
  const titleId = useId();
  const sheet = useIsSheet();
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  useLayoutEffect(() => {
    if (isOpen && !wasOpen.current) opener.current = document.activeElement as HTMLElement | null;
    wasOpen.current = isOpen;
  }, [isOpen]);
  useEffect(() => {
    if (!isOpen) return;
    return () => { returnFocus(opener.current, document.body); };
  }, [isOpen]);

  const request = (why: DismissReason) => { if (dismissAction(why, { busy }) === "close") onRequestClose(why); };

  // Mounted only while open: no hidden duplicate dialogs in the DOM, and unmount is when focus goes back to the opener.
  if (!isOpen) return null;

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => { if (!open) request("esc"); }}
      aria-labelledby={titleId}
      width={sheet ? "100dvw" : width}
      maxHeight={sheet ? "92dvh" : "85dvh"}
      position={sheet ? { bottom: 0, start: 0, end: 0 } : undefined}
      padding={0}
      style={sheet ? ({ "--_dialog-radius": "16px 16px 0 0", width: "100dvw", maxWidth: "100dvw", margin: 0 } as React.CSSProperties) : undefined}
    >
      <div data-testid="modal-surface" data-presentation={sheet ? "sheet" : "dialog"} data-busy={busy ? "true" : undefined} {...(rest as object)}
        style={{ display: "flex", flexDirection: "column", minHeight: 0, maxHeight: "inherit", padding: 16, gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <h2 id={titleId} style={{ margin: 0, fontSize: 20, lineHeight: 1.3 }}>{title}</h2>
          <Button data-testid="modal-close" aria-label="Close" variant="ghost" size="sm" disabled={busy} onClick={() => request("button")}>Close</Button>
        </div>
        <div style={{ overflowY: "auto", minHeight: 0 }}>{children}</div>
        {footer ? <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>{footer}</div> : null}
      </div>
    </Dialog>
  );
}
