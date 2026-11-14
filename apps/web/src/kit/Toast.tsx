// K0: the one Toast (moved from src/objects/Toast.tsx, which now re-exports it; same API and test ids, theme tokens instead of hex).
// Non-money confirmations only ("Link copied", "Username saved") and live bet changes (lib/betView.ts changeToast). Money results
// stay in their flow.
import React, { createContext, useCallback, useContext, useReducer } from "react";
import { toastReducer, type ToastItem } from "../../lib/uiObjects";
import "./kit.css";

const Ctx = createContext<{ toast: (t: Omit<ToastItem, "id"> & { id?: string }) => void } | null>(null);
let seq = 0;

/** One live region for short, non-blocking messages. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, dispatch] = useReducer(toastReducer, [] as ToastItem[]);
  const toast = useCallback((t: Omit<ToastItem, "id"> & { id?: string }) => dispatch({ type: "add", toast: { ...t, id: t.id ?? `t${++seq}` } }), []);
  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <div data-testid="toast-region" className="k-toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} data-testid="toast" data-kit="Toast" data-tone={t.tone} className="k-toast">
            <span>{t.text}</span>
            <button type="button" aria-label="Dismiss" onClick={() => dispatch({ type: "dismiss", id: t.id })}>×</button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
export function useToast() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useToast needs <ToastProvider>");
  return c.toast;
}
