import React, { useEffect, useRef, useState } from "react";
import { Button, TextField, CheckField } from "../ui";
import { Modal } from "../modal/Modal";
import { Notice, Disclosure } from "../kit/blocks";
import { claimWithWallet } from "../../lib/refereeRegistry";
import { REGISTRY_ID } from "../../lib/config";
import { clearNavGuard, setNavGuard } from "../../lib/navGuard";
import { REGISTRY_DOWN_MESSAGE, USERNAME_RULES, checkAvailability, claimErrorMessage, normalizeUsername, usernameErrorMessage, validateUsername } from "../../lib/username";
import { usernameSheetView, type SheetStatus } from "../../lib/usernameSheet";

export interface UsernameForm { raw: string; discoverable: boolean }

// A1 (UIR1 §3.9): ONE sheet, "Pick a username" (or "Change username" from Account): an input with a live availability line, the rules
// collapsed under "Rules" (opened by themselves when the name breaks one), the referee-discoverable tick, one Save button. No progress
// bar or step label (it is one step). Words and enablement: lib/usernameSheet (unit-tested). The claim is the same NEP-413 signed
// claimWithWallet as before; while it runs every way to close is blocked (Modal busy + the Back nav guard). Success calls onDone;
// a refusal keeps what was typed, with the plain reason. Closing without a name (Esc, Close) calls onClose: the user keeps browsing
// and any bet action asks for the name again (SM2 G6).
export default function UsernameStep({ registryUrl, account, signRawHash, onDone, onClose, settings }: {
  registryUrl: string; account: string; signRawHash: (address: string, hashHex: string) => Promise<string>; onDone: (claimed: boolean, name?: string) => void;
  /** Closed without a name (Esc, overlay, Close). */
  onClose: () => void;
  /** The Account "Change username" variant. `current` is the name being replaced; no "Skip". */
  settings?: { current: string };
}) {
  const [form, setForm] = useState<UsernameForm>({ raw: "", discoverable: true });
  const [error, setError] = useState<{ text: string; down: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<SheetStatus>({ kind: "idle" });
  const seq = useRef(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // Focus starts in the name field (UIR1 §3.9: not a focus ring on Close).
  useEffect(() => {
    const t = setTimeout(() => {
      const el = document.querySelector('[data-testid="username-input"]');
      ((el?.matches("input") ? el : el?.querySelector("input")) as HTMLInputElement | null | undefined)?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, []);

  // Live availability (debounced). Local rule breaks answer at once, without a registry call.
  useEffect(() => {
    const n = normalizeUsername(form.raw);
    if (!n) { setStatus({ kind: "idle" }); return; }
    const err = validateUsername(n);
    if (err) { setStatus({ kind: "local", text: usernameErrorMessage(err) }); return; }
    const mine = ++seq.current;
    setStatus({ kind: "checking" });
    const t = setTimeout(async () => {
      const a = await checkAvailability(registryUrl, n, { myAccount: account });
      if (mine === seq.current && alive.current) setStatus({ kind: "avail", a, name: n });
    }, 250);
    return () => clearTimeout(t);
  }, [form.raw, registryUrl, account]);

  // While the signed claim is in flight, browser Back stays here (lib/navGuard, as every flow).
  useEffect(() => {
    if (!busy) return;
    const here = window.location.pathname + window.location.search;
    setNavGuard(here);
    return () => clearNavGuard(here);
  }, [busy]);

  const view = usernameSheetView({ raw: form.raw, status, busy, current: settings?.current ?? null });

  const save = async () => {
    if (!view.canSave) return;
    const name = normalizeUsername(form.raw);
    setError(null);
    setBusy(true);
    const r = await claimWithWallet({ registryUrl, registryId: REGISTRY_ID, username: name, account, signRawHash, discoverable: form.discoverable });
    if (!alive.current) return;
    setBusy(false);
    if (r.ok) { onDone(true, r.username ?? name); return; }
    const m = claimErrorMessage(r, name);
    setError({ text: m.message, down: m.kind === "down" });
  };

  const footer = (
    <div className="k-actions k-actions--stack" data-kit="UsernameSheet-actions">
      <Button data-testid="username-claim-btn" variant="primary" disabled={!view.canSave} onClick={() => void save()}>{view.saveLabel}</Button>
      {!settings && error?.down && <Button data-testid="username-skip" variant="secondary" disabled={busy} onClick={() => onDone(false)}>Skip for now</Button>}
    </div>
  );

  return (
    <Modal isOpen title={view.title} busy={busy} onRequestClose={() => onClose()} footer={footer}>
      <form data-testid={settings ? "username-settings" : "username-step"} className="username-sheet" noValidate
        onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <p className="username-sheet__lead">People find you and bet with you by your username. Your email is never shown.</p>
        <TextField data-testid="username-input" label="Username" hideLabel placeholder="username" autoCapitalize="none" autoCorrect="off" spellCheck={false}
          disabled={busy} value={form.raw}
          onChange={(e) => { const raw = e.currentTarget.value; if (raw !== form.raw) setError(null); setForm({ ...form, raw }); }} />
        <p data-testid="username-status" data-tone={view.tone} className="username-sheet__line" role="status">{view.line}</p>
        {/* key: re-mount so a rule break opens the list by itself, and a fixed name lets the user close it again */}
        <Disclosure key={view.rulesOpen ? "open" : "closed"} title="Rules" summary="3 to 20 letters, digits or _" defaultOpen={view.rulesOpen} data-testid="username-rules-row">
          <ul data-testid="username-rules" aria-label="Username rules" className="username-sheet__rules">
            {USERNAME_RULES.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </Disclosure>
        <CheckField data-testid="username-discoverable" label="Let people find me as a referee" checked={form.discoverable} disabled={busy}
          onChange={(e) => setForm({ ...form, discoverable: e.currentTarget.checked })} />
        {busy && <p data-testid="flow-busy" role="status" className="username-sheet__line">Saving your username… keep this window open.</p>}
        {error && <Notice tone="bad" title={error.text} data-testid="username-error" />}
      </form>
    </Modal>
  );
}

export { REGISTRY_DOWN_MESSAGE };
