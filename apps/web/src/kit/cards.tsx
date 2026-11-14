// K0 (UIR1 §2.2): the cards. Every card takes a BetView (lib/betView.ts) or a part of one; none reads a raw Bet.
import React from "react";
import { reviewRows, type Action, type ActivityEntry, type BetView, type PayoutView, type RulingView, type Side } from "../../lib/betView";
import { relTime } from "../../lib/dates";
import { Amount, Amounts, DeciderChip, Disclosure, KeyValue, StatusPill, TimeLeft, UserChip, ActionBar } from "./blocks";
import { VerifyToggle } from "./verify";
import type { ActionReceiptData } from "../../lib/verify";

import "./kit.css";

type OnAction = (id: Action["id"]) => void;
type Data = { [k: `data-${string}`]: unknown };

/** "You (YES) 25 USDC vs @bob (NO) 25 USDC". */
export function Sides({ view }: { view: BetView }) {
  const side = (s: Side, fallback: string) => (
    <span className="k-vs__side">
      {s.who ? <UserChip person={s.who} size="sm" /> : <span className="k-muted">{fallback}</span>}
      <span className="k-side">{s.side}</span>
      <Amount money={s.stake} logo size="sm" />
    </span>
  );
  const [first, second] = view.role === "taker" ? [view.taker, view.maker] : [view.maker, view.taker];
  return <span className="k-vs" data-kit="Sides">{side(first, "Maker")}<span className="k-vs__sep">vs</span>{side(second, "Anyone")}</span>;
}

function Next({ view, now }: { view: BetView; now?: number }) {
  return view.next ? <TimeLeft at={view.next.at} label={view.next.label} past={view.next.past} now={now} /> : null;
}

// ---------------------------------------------------------------- BetCard
export type BetCardVariant = "mine" | "offer" | "public" | "decide" | "compact";
/** One bet in a list. The whole card opens the bet; at most one button (the view's primary action). */
export function BetCard({ view, variant, now, href, onOpen, onAction, ...rest }: {
  view: BetView; variant: BetCardVariant; now?: number; href?: string; onOpen?: (id: number) => void; onAction?: OnAction;
} & Data) {
  const link = href ?? `/bet/${view.id}`;
  const open = (e: React.MouseEvent) => { if (onOpen) { e.preventDefault(); onOpen(view.id); } };
  const title = <a className="k-card__link" href={link} onClick={open}>{view.question}</a>;
  const button = view.primary && (variant === "mine" || variant === "offer" || variant === "decide") ? (
    <ActionBar primary={variant === "decide" ? { ...view.primary, label: "Rule now" } : view.primary} onAction={onAction} />
  ) : null;
  const common = { ...(rest as object), "data-kit": "BetCard", "data-variant": variant, "data-bet": view.id, "data-pill": view.pill.id };
  if (variant === "compact") {
    return (
      <article {...common} className="k-card k-card--click k-card--compact">
        <StatusPill pill={view.pill} />
        <p className="k-card__q">{title}</p>
        {view.payout?.rows.some((r) => r.toMe) && <span className="k-small k-muted"><Amounts list={view.payout.rows.find((r) => r.toMe)!.value} size="sm" /></span>}
      </article>
    );
  }
  return (
    <article {...common} className="k-card k-card--click">
      {variant === "offer" ? (
        <>
          <p className="k-card__q">{title}</p>
          <span className="k-row k-small">
            <span>You put in <Amount money={view.taker.stake} logo /></span><span className="k-muted">·</span><span>win <Amount money={view.maker.stake} logo /></span>
          </span>
          <span className="k-row k-small">
            {view.maker.who && <><span className="k-muted">by</span><UserChip person={view.maker.who} size="sm" /></>}
            <span className="k-muted">·</span><DeciderChip decider={view.decider} />
            {view.next && <><span className="k-muted">·</span><Next view={view} now={now} /></>}
          </span>
        </>
      ) : (
        <>
          <span className="k-card__top"><StatusPill pill={view.pill} /><Next view={view} now={now} /></span>
          <p className="k-card__q">{title}</p>
          <Sides view={view} />
          {variant === "public" || variant === "decide" ? <span className="k-small k-muted">{view.sentence}</span>
            : <span className="k-small">{view.headline ?? view.sentence}</span>}
        </>
      )}
      {button}
    </article>
  );
}

// ---------------------------------------------------------------- BetHeader
/** Top of the bet page: question, pill + time, who vs who with stakes, who decides, one sentence. */
export function BetHeader({ view, now, ...rest }: { view: BetView; now?: number } & Data) {
  return (
    <header {...(rest as object)} className="k-header" data-kit="BetHeader">
      <h1 className="k-header__q">{view.question}</h1>
      <span className="k-row"><StatusPill pill={view.pill} /><Next view={view} now={now} /></span>
      <Sides view={view} />
      <DeciderChip decider={view.decider} />
      <p className="k-header__sentence">{view.headline ?? view.sentence}</p>
    </header>
  );
}

// ---------------------------------------------------------------- ActionCard
/** The one thing to do now. `info` = nothing to do, just what happens next. */
export function ActionCard({ view, now, onAction, ...rest }: { view: BetView; now?: number; onAction?: OnAction } & Data) {
  const a = view.primary;
  const kind = !a ? "info" : a.kind === "danger" ? "danger" : "primary";
  return (
    <section {...(rest as object)} className="k-card k-action" data-kit="ActionCard" data-kind={kind}>
      <p className="k-action__text">{view.sentence}</p>
      {(a?.hint || view.next) && <p className="k-action__hint">{a?.hint}{a?.hint && view.next ? " · " : ""}{view.next && <Next view={view} now={now} />}</p>}
      {a && <ActionBar primary={a} onAction={onAction} sticky stack />}
    </section>
  );
}

// ---------------------------------------------------------------- RulingCard
/** `onVerify` (V1): opens the judge's Verify sheet (what it was asked, which program, where it ran, what it said, accepted). */
export function RulingCard({ ruling, now, onVerify, ...rest }: { ruling: RulingView; now?: number; onVerify?: () => void } & Data) {
  const outcome = ruling.outcome === "VOID" ? "No result: both stakes go back" : `Ruled ${ruling.outcome}`;
  return (
    <section {...(rest as object)} className="k-card" data-kit="RulingCard" data-kind={ruling.kind} data-outcome={ruling.outcome}>
      <span className="k-row k-small k-muted">{ruling.kind === "ai" ? <DeciderChip decider={{ kind: "ai" }} /> : <><UserChip person={ruling.who} size="sm" /> ruled</>}</span>
      <p className="k-ruling__outcome">{outcome}</p>
      {ruling.kind === "ai" && ruling.evidence.map((e, i) => (
        <blockquote key={i} className="k-quote">“{e.quote}”<cite>{e.url ? <a href={e.url} target="_blank" rel="noopener noreferrer">{e.sourceName}</a> : e.sourceName}{e.reason ? ` · ${e.reason}` : ""}</cite></blockquote>
      ))}
      {ruling.kind === "ai" && ruling.finalAt != null && <span className="k-small k-muted">Final unless challenged · <TimeLeft at={ruling.finalAt} label="final" past="final" now={now} /></span>}
      {onVerify && <button type="button" className="k-copy k-verify-btn" data-testid="ruling-verify" onClick={onVerify}>{ruling.kind === "ai" ? "Verify this ruling" : "Verify who decided"}</button>}
    </section>
  );
}

// ---------------------------------------------------------------- PayoutCard
export function PayoutCard({ payout, onRetry, ...rest }: { payout: PayoutView; onRetry?: () => void } & Data) {
  return (
    <section {...(rest as object)} className="k-card" data-kit="PayoutCard" data-ending={payout.ending} data-state={payout.state}>
      <p className="k-payout__headline">{payout.headline}</p>
      <KeyValue variant="total" rows={payout.rows.map((r, i) => ({ id: `r${i}`, label: r.label, value: <Amounts list={r.value} minor={r.minor} />, emphasis: r.emphasis }))} />
      {payout.state !== "paid" && <span className="k-small k-muted" data-testid="payout-progress">{payout.message.replace(/ Retry\.$/, "")}</span>}
      {payout.canRetry && payout.state === "slow" && onRetry && <ActionBar primary={{ id: "retry-payout", label: "Retry payout", kind: "primary" }} onAction={onRetry} />}
    </section>
  );
}

// ---------------------------------------------------------------- ActivityList (familiarcow UX-37 #9: full history, collapsed)
/** V1: an entry with a `receipt` gets a "Verify" toggle showing its on-chain proof (lib/verify.ts withReceipts). */
export function ActivityList({ entries, now, defaultOpen = false, ...rest }: { entries: Array<ActivityEntry & { receipt?: ActionReceiptData }>; now?: number; defaultOpen?: boolean } & Data) {
  const clock = now ?? Date.now();
  const last = entries.at(-1);
  return (
    <Disclosure {...rest} title="Activity" summary={`${entries.length} ${entries.length === 1 ? "event" : "events"}${last ? ` · ${last.text}` : ""}`} defaultOpen={defaultOpen} data-kit-part="ActivityList">
      <ol className="k-activity" data-kit="ActivityList">
        {entries.map((e) => (
          <li key={e.id} data-entry={e.id}>
            <span>{e.text}</span>
            {e.at != null && <span className="k-small k-muted" title={new Date(e.at).toISOString()}>{relTime(e.at, clock)}</span>}
            {e.receipt && <VerifyToggle receipt={e.receipt} />}
          </li>
        ))}
      </ol>
    </Disclosure>
  );
}

// ---------------------------------------------------------------- Details
export function BetDetails({ view, defaultOpen = false, ...rest }: { view: BetView; defaultOpen?: boolean } & Data) {
  return (
    <Disclosure {...rest} title="Details" summary={`Bet #${view.id} · terms, deadlines, fees`} defaultOpen={defaultOpen}>
      <KeyValue variant="stacked" rows={view.details.map((d) => ({ id: d.id, label: d.label, value: d.value }))} />
    </Disclosure>
  );
}

// ---------------------------------------------------------------- More actions
export function MoreActions({ view, onAction, ...rest }: { view: BetView; onAction?: OnAction } & Data) {
  if (view.secondary.length === 0) return null;
  return (
    <Disclosure {...rest} title="More actions" summary={view.secondary.map((a) => a.label).join(" · ")}>
      <ActionBar primary={null} secondary={view.secondary} onAction={onAction} stack />
    </Disclosure>
  );
}

// ---------------------------------------------------------------- ReviewSummary (create / take: 5 lines + Full terms)
export function ReviewSummary({ view, variant, ...rest }: { view: BetView; variant: "create" | "take" } & Data) {
  const rows = reviewRows(variant === "take" ? { ...view, role: "taker" } : { ...view, role: "maker" });
  return (
    <section {...(rest as object)} className="k-card" data-kit="ReviewSummary" data-variant={variant}>
      <KeyValue rows={rows.map((r) => ({ id: r.id, label: r.label, value: r.value }))} />
      <Disclosure title="Full terms" summary="Sources, deadlines, what happens if no one decides">
        <KeyValue variant="stacked" rows={view.details.filter((d) => d.id !== "accounts").map((d) => ({ id: d.id, label: d.label, value: d.value }))} />
      </Disclosure>
    </section>
  );
}

