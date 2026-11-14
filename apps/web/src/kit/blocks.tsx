// K0 (UIR1 §2.1): the building blocks. Each one renders a precomputed value from lib/money.ts, lib/dates.ts or lib/betView.ts and
// never derives wording itself. Styles: src/kit/kit.css (theme tokens only).
import React, { useEffect, useId, useState } from "react";
import { formatMoney, type Money } from "../../lib/money";
import { exactTime, tickMs, timeLeft } from "../../lib/dates";
import { personLabel, type Decider, type Person, type Pill, type Action } from "../../lib/betView";
import { ASSET_LOGOS } from "../assets/logos";
import { assetIcon } from "../components/AssetLogo";
import { Button } from "../ui";
import "./kit.css";

type Data = { [k: `data-${string}`]: unknown };

// ---------------------------------------------------------------- AssetLogo
/** One logo set: the bundled token artwork (src/assets/logos), the glyph mark (components/AssetLogo) for anything else. */
export function AssetLogo({ symbol, size }: { symbol: string; size?: string }) {
  const src = ASSET_LOGOS[symbol];
  const style = size ? { width: size, height: size } : undefined;
  if (src) return <img className="k-logo" src={src} alt="" aria-hidden="true" style={style} data-kit="AssetLogo" data-asset={symbol} />;
  const Glyph = assetIcon(symbol);
  return <Glyph className="k-logo" style={style} data-kit="AssetLogo" data-asset={symbol} />;
}

// ---------------------------------------------------------------- Amount
/** THE way an amount is shown (lib/money.ts rule). The exact value is the tooltip. `minor` = fee/storage ("< 0.01 NEAR"). */
export function Amount({ money, size = "md", logo = false, minor = false, ...rest }: { money: Money; size?: "sm" | "md" | "lg"; logo?: boolean; minor?: boolean } & Data) {
  const f = formatMoney(money, { minor });
  return (
    <span {...(rest as object)} className={`k-amount k-amount--${size}`} title={f.exact} data-kit="Amount" data-asset={money.symbol} data-tiny={f.tiny ? "1" : "0"}>
      {logo && <AssetLogo symbol={money.symbol} />}{f.text}
    </span>
  );
}
/** Several amounts in one line ("3.50 USDC + 0.000396 BTC"). */
export function Amounts({ list, ...p }: { list: Money[]; size?: "sm" | "md" | "lg"; logo?: boolean; minor?: boolean }) {
  return <>{list.map((m, i) => <React.Fragment key={m.symbol}>{i > 0 && " + "}<Amount money={m} {...p} /></React.Fragment>)}</>;
}

// ---------------------------------------------------------------- UserChip
/** A person: "You", "@alice", or "Unnamed account" (lib/appState identityOf). Never a raw id, not even in the tooltip. */
export function UserChip({ person, size = "md", ...rest }: { person: Person; size?: "sm" | "md" } & Data) {
  const label = personLabel(person);
  const variant = person.isMe ? "you" : person.username ? "named" : "anon";
  // SM2 PEOPLE RULE: no raw id anywhere in the chip, not even the tooltip (ids live in Account details / Verify only).
  const initial = person.isMe ? "Y" : person.username ? person.username.replace(/^@/, "").slice(0, 1) : "?";
  return (
    <span {...(rest as object)} className={`k-user${size === "sm" ? " k-small" : ""}`} data-kit="UserChip" data-variant={variant} title={label}>
      <span className="k-user__dot" aria-hidden="true">{initial}</span>
      <span className="k-user__name">{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------- DeciderChip
export function DeciderChip({ decider, ...rest }: { decider: Decider } & Data) {
  if (decider.kind === "ai") {
    return <span {...(rest as object)} className="k-decider" data-kit="DeciderChip" data-decider="ai"><span className="k-decider__spark" aria-hidden="true">✦</span>AI judge</span>;
  }
  return (
    <span {...(rest as object)} className="k-decider" data-kit="DeciderChip" data-decider="person">
      {decider.who.isMe ? "You decide" : <><UserChip person={decider.who} size="sm" /> decides</>}
    </span>
  );
}

// ---------------------------------------------------------------- StatusPill
export function StatusPill({ pill, ...rest }: { pill: Pill } & Data) {
  return <span {...(rest as object)} className="k-pill" data-kit="StatusPill" data-pill={pill.id} data-tone={pill.tone}>{pill.label}</span>;
}

// ---------------------------------------------------------------- TimeLeft
/** "Closes in 2 days"; tap (or focus + Enter) shows the exact local time and UTC. Re-renders on its own unless `now` is fixed. */
export function TimeLeft({ at, label, past, now, ...rest }: { at: number; label: string; past?: string; now?: number } & Data) {
  const [clock, setClock] = useState(() => now ?? Date.now());
  const [open, setOpen] = useState(false);
  const id = useId();
  useEffect(() => {
    if (now !== undefined) { setClock(now); return; }
    const t = setTimeout(() => setClock(Date.now()), tickMs(at, clock));
    return () => clearTimeout(t);
  }, [at, clock, now]);
  const t = timeLeft({ at, now: clock, future: label, past });
  const ex = exactTime(at);
  return (
    <span {...(rest as object)} className="k-time" data-kit="TimeLeft" data-urgent={t.urgent ? "1" : "0"} data-past={t.past ? "1" : "0"}>
      <button type="button" className="k-time__btn" aria-expanded={open} aria-controls={id} title={`${ex.local} · ${ex.utc}`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }} onBlur={() => setOpen(false)}>
        <time dateTime={ex.iso}>{t.text}</time>
      </button>
      {open && <span id={id} role="tooltip" className="k-time__exact" data-testid="time-exact"><span>{ex.local} (your time)</span><span>{ex.utc}</span></span>}
    </span>
  );
}

// ---------------------------------------------------------------- Disclosure
/** A collapsed row: title + grey one-line summary + chevron (the "More options" style). Native <details>, so it works without JS. */
export function Disclosure({ title, summary, defaultOpen = false, children, ...rest }: { title: string; summary?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode } & Data) {
  return (
    <details {...(rest as object)} className="k-disc" data-kit="Disclosure" open={defaultOpen || undefined}>
      <summary><span className="k-disc__title">{title}</span>{summary != null && <span className="k-disc__summary">{summary}</span>}<span className="k-disc__chev" aria-hidden="true">›</span></summary>
      <div className="k-disc__body">{children}</div>
    </details>
  );
}

// ---------------------------------------------------------------- KeyValue
export interface KVRow { id?: string; label: React.ReactNode; value: React.ReactNode; emphasis?: boolean }
export function KeyValue({ rows, variant = "compact", ...rest }: { rows: KVRow[]; variant?: "compact" | "total" | "stacked" } & Data) {
  return (
    <dl {...(rest as object)} className={`k-kv k-kv--${variant}`} data-kit="KeyValue">
      {rows.map((r, i) => (
        <React.Fragment key={r.id ?? i}>
          <dt data-row={r.id} data-emphasis={r.emphasis ? "1" : "0"}>{r.label}</dt>
          <dd data-row={r.id} data-emphasis={r.emphasis ? "1" : "0"}>{r.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------- ActionBar
/** The one primary action (filled) and the rest. `sticky` pins it to the bottom on phones; `stack` gives full-width buttons there. */
export function ActionBar({ primary, secondary = [], onAction, sticky = false, stack = false, ...rest }: {
  primary: Action | null; secondary?: Action[]; onAction?: (id: Action["id"]) => void; sticky?: boolean; stack?: boolean;
} & Data) {
  if (!primary && secondary.length === 0) return null;
  const btn = (a: Action, main: boolean) => (
    <Button key={a.id} data-testid={`action-${a.id}`} variant={main ? (a.kind === "danger" ? "destructive" : "primary") : a.kind === "danger" ? "ghost" : "secondary"}
      onClick={() => onAction?.(a.id)}>{a.label}</Button>
  );
  return (
    <div {...(rest as object)} className={`k-actions${sticky ? " k-actions--sticky" : ""}${stack ? " k-actions--stack" : ""}${primary?.kind === "danger" ? " k-danger-fill" : ""}`} data-kit="ActionBar">
      {primary && btn(primary, true)}
      {secondary.map((a) => btn(a, false))}
    </div>
  );
}

// ---------------------------------------------------------------- Notice
export type NoticeTone = "info" | "warn" | "bad" | "good";
/** One message: inline (in a card) or page (top of the page, one at a time by priority). */
export function Notice({ tone = "info", title, body, action, variant = "inline", ...rest }: { tone?: NoticeTone; title: React.ReactNode; body?: React.ReactNode; action?: React.ReactNode; variant?: "inline" | "page" } & Data) {
  return (
    <section {...(rest as object)} className={`k-notice${variant === "page" ? " k-notice--page" : ""}`} data-kit="Notice" data-tone={tone} role={tone === "bad" || tone === "warn" ? "alert" : "status"}>
      <div><p className="k-notice__title">{title}</p>{body != null && <p className="k-notice__body">{body}</p>}</div>
      {action != null && <div className="k-notice__action">{action}</div>}
    </section>
  );
}

// ---------------------------------------------------------------- EmptyState
/** "Nothing here yet" with an optional next step. The legacy `children` form (objects/EmptyState) renders the same single line. */
export function EmptyState({ title, body, action, children, ...rest }: { title?: React.ReactNode; body?: React.ReactNode; action?: React.ReactNode; children?: React.ReactNode } & Data) {
  if (title == null) return <p {...(rest as object)} data-kit="EmptyState">{children}{action ? <> {action}</> : null}</p>;
  return (
    <section {...(rest as object)} className="k-empty" data-kit="EmptyState">
      <p className="k-empty__title">{title}</p>
      {body != null && <p>{body}</p>}
      {action}
    </section>
  );
}
