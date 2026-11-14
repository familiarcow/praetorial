// B1 (familiarcow 2026-11-11: "expand detail sections so we can see all the details of the bet? The sources, the prompts, etc." and "We do
// need to improve the UI for the details in the bet"): the bet page's Details card. One card, one collapsible row per section (icon +
// title + one-line grey summary), each closed by default. Sections render a BetDetail (lib/betDetail.ts) and nothing else:
//   BetTerms · BetSources · JudgeInfo · RulingHistory · ExhibitList · MoneyDeadlines · AccountDetails
// Long text wraps, URLs are tappable chips, hashes/ids are truncated with a copy button, monospace only for hashes and JSON.
// People are @usernames everywhere; raw account ids appear only in AccountDetails.
import React, { useState } from "react";
import { personName, type BetDetail, type DetailPerson, type Field, type JudgeDetail, type ModelRun, type RoundDetail, type When, modelName } from "../../lib/betDetail";
import "./kit.css";

type Data = { [k: `data-${string}`]: unknown };

// ---------------------------------------------------------------- small parts
/** Copies `value`; says "Copied" for 2 s. */
export function CopyButton({ value, label = "Copy", ...rest }: { value: string; label?: string } & Data) {
  const [done, setDone] = useState(false);
  return (
    <button {...(rest as object)} type="button" className="k-copy" data-kit="CopyButton" aria-label={done ? "Copied" : label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 2000); }).catch(() => undefined);
      }}>
      {done ? "Copied" : "Copy"}
    </button>
  );
}

/** A hash or raw id: monospace, middle-truncated, the full value in the tooltip and on the copy button. */
export function HashText({ value, label = "Copy", keep = 8, ...rest }: { value: string; label?: string; keep?: number } & Data) {
  const short = value.length > keep * 2 + 1 ? `${value.slice(0, keep)}…${value.slice(-keep)}` : value;
  return (
    <span {...(rest as object)} className="k-hashrow" data-kit="HashText">
      <code className="k-hash" title={value}>{short}</code>
      <CopyButton value={value} label={label} />
    </span>
  );
}

/** A link as a tappable chip: host + path, opens in a new tab. */
export function UrlChip({ url, ...rest }: { url: string } & Data) {
  let host = url, path = "";
  try { const u = new URL(url); host = u.host; path = `${u.pathname === "/" ? "" : u.pathname}${u.search}`; } catch { /* show as is */ }
  return (
    <a {...(rest as object)} className="k-urlchip" data-kit="UrlChip" href={url} target="_blank" rel="noopener noreferrer" title={url}>
      <span className="k-urlchip__host">{host}</span>{path && <span className="k-urlchip__path">{path}</span>}<span aria-hidden="true" className="k-urlchip__out">↗</span>
    </a>
  );
}

/** An exact time: local first, UTC under it. */
export function WhenText({ when, ...rest }: { when: When } & Data) {
  return (
    <span {...(rest as object)} className="k-when" data-kit="WhenText">
      <time dateTime={when.iso}>{when.local}</time><span className="k-muted k-small">{when.utc}</span>
    </span>
  );
}

/** A person by @username, or "Unnamed account" (SM2 identityOf). Never a raw id (raw ids live in AccountDetails only). */
export function PersonName({ who, ...rest }: { who: DetailPerson } & Data) {
  return <span {...(rest as object)} className="k-person" data-kit="PersonName" data-named={who.username ? "1" : "0"}>{personName(who.account, who.username)}</span>;
}

/** A closed sub-section holding monospace text (JSON / raw ruling) with a copy button. */
export function RawBlock({ title, text, mono = true, ...rest }: { title: string; text: string; mono?: boolean } & Data) {
  return (
    <details {...(rest as object)} className="k-raw" data-kit="RawBlock">
      <summary><span>{title}</span><span className="k-raw__chev" aria-hidden="true">›</span></summary>
      <div className="k-raw__bar"><CopyButton value={text} label={`Copy ${title}`} /></div>
      <pre className={mono ? "k-pre" : "k-pre k-pre--prose"}>{text}</pre>
    </details>
  );
}

/** Label above value, wrapped. */
function F({ label, children, field }: { label: React.ReactNode; children: React.ReactNode; field?: string }) {
  return (
    <div className="k-field" data-field={field}>
      <p className="k-field__label">{label}</p>
      <div className="k-field__value">{children}</div>
    </div>
  );
}
function FieldValue({ f }: { f: Field }) {
  if (f.list) return f.list.length ? <ul className="k-list">{f.list.map((x, i) => <li key={i}>{x}</li>)}</ul> : <span className="k-muted">None</span>;
  return <>{f.text}</>;
}

// ---------------------------------------------------------------- icons (stroke = currentColor)
const ICONS: Record<string, React.ReactNode> = {
  terms: <path d="M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5" />,
  sources: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  judge: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />,
  ruling: <path d="M12 4v16M5 20h14M6 8l-3 6h6zM18 8l-3 6h6zM6 8h12" />,
  exhibits: <path d="M8 12l6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l7-7" />,
  money: <path d="M12 7v10M15 9.5c0-1.4-1.3-2.5-3-2.5s-3 1-3 2.3 1.2 2 3 2.4 3 1.1 3 2.4-1.3 2.4-3 2.4-3-1.1-3-2.5M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" />,
  accounts: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0" />,
};
function Icon({ name }: { name: string }) {
  return <svg className="k-drow__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>;
}

/** One collapsible row of the Details card. */
export function DetailRow({ id, title, summary, defaultOpen = false, children }: { id: string; title: string; summary: string; defaultOpen?: boolean; children: React.ReactNode }) {
  return (
    <details className="k-drow" data-kit="DetailRow" data-section={id} data-testid={`details-${id}`} open={defaultOpen || undefined}>
      <summary>
        <Icon name={id} />
        <span className="k-drow__head"><span className="k-drow__title">{title}</span><span className="k-drow__summary" data-testid={`details-${id}-summary`}>{summary}</span></span>
        <span className="k-drow__chev" aria-hidden="true">›</span>
      </summary>
      <div className="k-drow__body">{children}</div>
    </details>
  );
}

// ---------------------------------------------------------------- 1. Terms
export function BetTerms({ terms, ...rest }: { terms: BetDetail["terms"] } & Data) {
  if (!terms.kept) {
    return (
      <div {...(rest as object)} className="k-dsec" data-kit="BetTerms">
        <p>This bet's terms were not stored on chain, so they can't be shown here. Only their fingerprint is kept:</p>
        <F label="Terms hash" field="terms_hash"><HashText value={terms.termsHash} label="Copy terms hash" /></F>
      </div>
    );
  }
  return (
    <div {...(rest as object)} className="k-dsec" data-kit="BetTerms" data-kind={terms.kind}>
      {terms.question && terms.derived && <p className="k-dsec__lead" data-testid="terms-question">{terms.question}</p>}
      {terms.derived && (
        <section className="k-dsub">
          <p className="k-dsub__title">What the resolver checks</p>
          <p className="k-muted k-small">This is a {terms.kindLabel.toLowerCase()} bet. The resolver builds the question, sources and rules from the signed settings below, the same way every time.</p>
          {terms.questions.map((q) => <F key={q.id} label={`Question ${q.id}`} field={`derived-q-${q.id}`}>{q.q}</F>)}
          {terms.ruleText && <F label="How the questions combine">{terms.ruleText}</F>}
          <F label="Rules">
            <ul className="k-list">
              {terms.clauses.map((c) => <li key={c.id}>{c.text ?? c.id}</li>)}
              {terms.extraRules.map((r, i) => <li key={`x${i}`}>{r}</li>)}
            </ul>
          </F>
        </section>
      )}
      <section className="k-dsub">
        <p className="k-dsub__title">{terms.derived ? "Signed settings" : "As signed"}</p>
        {terms.fields.map((f) => <F key={f.key} label={f.label} field={f.key}><FieldValue f={f} /></F>)}
      </section>
      <F label="Terms hash" field="terms_hash"><HashText value={terms.termsHash} label="Copy terms hash" /></F>
      {terms.rawJson && <RawBlock title="Raw terms (JSON)" text={terms.rawJson} data-testid="terms-raw" />}
    </div>
  );
}

// ---------------------------------------------------------------- 2. Sources
export function BetSources({ sources, ...rest }: { sources: BetDetail["sources"] } & Data) {
  if (!sources.length) return <p {...(rest as object)} className="k-muted" data-kit="BetSources">This bet names no sources.</p>;
  return (
    <ol {...(rest as object)} className="k-sources" data-kit="BetSources">
      {sources.map((s) => (
        <li key={`${s.id}-${s.priority}`} className="k-source" data-source={s.id}>
          <span className="k-source__n" aria-hidden="true">{s.priority}</span>
          <div className="k-stack">
            <span className="k-row"><strong className="k-source__name">{s.publisher}</strong><span className="k-tag">{s.role}</span></span>
            {s.url ? <UrlChip url={s.url} /> : <span className="k-muted k-small">No link given</span>}
            <span className="k-small"><span className="k-muted">Used for: </span>{s.usedFor}</span>
            {s.extra.map((x) => <span key={x.key} className="k-small"><span className="k-muted">{x.label}: </span>{x.text}</span>)}
            <span className="k-small k-muted">Source id {s.id}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- 3. AI judge
/** `onVerify` (V1): opens the judge's Verify sheet. */
export function JudgeInfo({ judge, onVerify, ...rest }: { judge: JudgeDetail; onVerify?: () => void } & Data) {
  return (
    <div {...(rest as object)} className="k-dsec" data-kit="JudgeInfo" data-mode={judge.mode}>
      {onVerify && <button type="button" className="k-copy k-verify-btn" data-testid="judge-verify" onClick={onVerify}>{judge.mode === "referee" ? "Verify who decided" : "Verify the AI judge"}</button>}
      {judge.mode === "referee" && judge.referee && (
        <p>A referee decides this bet: <PersonName who={judge.referee} />. The AI judge is not used, so there is no prompt.</p>
      )}
      {judge.mode === "unknown" && <p>{judge.caveats[0]}</p>}
      {(judge.mode === "ai" || judge.mode === "code-audit") && (
        <>
          <p>{judge.mode === "ai" ? "Two AI models answer each question from the named sources only, and must quote them." : judge.caveats[0]}</p>
          <F label={judge.mode === "ai" ? "Models" : "Audit model"} field="models">
            {judge.models.length ? <span className="k-row">{judge.models.map((m) => <span key={m} className="k-tag" title={m}>{modelName(m)}</span>)}</span> : <span className="k-muted">Not known yet</span>}
            <span className="k-small k-muted">{judge.modelsSource === "ruling" ? "As used for this bet's ruling." : judge.modelsSource === "release" ? "The models this app's release is set up with (the bet hasn't been judged yet)." : ""}</span>
          </F>
          {judge.chain.length > 1 && (
            <F label="Backup models, in order" field="chain">
              <ol className="k-list">{judge.chain.map((p, i) => <li key={i} data-active={p.active ? "1" : "0"}>{modelName(p.a)} + {modelName(p.b)}{p.active ? " (used)" : ""}</li>)}</ol>
            </F>
          )}
        </>
      )}
      <F label="Models snapshot hash" field="models_snapshot_hash"><HashText value={judge.modelsSnapshotHash} label="Copy models snapshot hash" /></F>
      <F label="Resolver code (wasm) hash" field="resolver_wasm_hash">
        {judge.resolverWasmHash ? <><HashText value={judge.resolverWasmHash} label="Copy resolver wasm hash" /><span className="k-small k-muted">The resolver build this app is pinned to.</span></> : <span className="k-muted">Not known to this page</span>}
      </F>
      <div className="k-dgrid">
        {judge.tier != null && <F label="Tier" field="tier">{judge.tier}</F>}
        {judge.maxPaidRuns != null && <F label="Checks allowed" field="max_paid_runs">{judge.maxPaidRuns}</F>}
        {judge.runsUsed != null && <F label="Checks used" field="runs_used">{judge.runsUsed}</F>}
      </div>
      {(judge.prompts.length > 0 || judge.audit) && (
        <section className="k-dsub" data-testid="judge-prompt">
          <p className="k-dsub__title">{judge.mode === "ai" ? "The exact instructions the AI gets" : "The exact audit instructions"}</p>
          {judge.mode === "ai" && <p className="k-small k-muted">{judge.caveats[0]}</p>}
          {judge.mode === "code-audit" && <p className="k-small k-muted">{judge.caveats[1]}</p>}
          <RawBlock title="System instructions" mono={false} text={judge.prompts[0]?.system ?? judge.audit!.system} data-testid="judge-system" />
          {judge.prompts.map((p) => <RawBlock key={p.elementId} title={`Message for question ${p.elementId}`} mono={false} text={p.user} data-testid={`judge-user-${p.elementId}`} />)}
          {judge.audit && <RawBlock title="Audit message" mono={false} text={judge.audit.user} data-testid="judge-audit" />}
          {judge.mode === "ai" && <p className="k-small k-muted">{judge.caveats[1]}</p>}
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 4. Ruling & reasoning
const ANSWER_WORDS: Record<string, string> = { met: "Yes, met", not_met: "No, not met", insufficient: "Not enough evidence", conflict: "Sources conflict" };
function RunCard({ r }: { r: ModelRun }) {
  return (
    <li className="k-run" data-model={r.model}>
      <span className="k-row"><strong title={r.model}>{modelName(r.model)}</strong>
        {r.answer && <span className="k-tag" data-answer={r.answer}>{ANSWER_WORDS[r.answer] ?? r.answer}</span>}
        {r.audit && <span className="k-tag" data-answer={r.audit}>Audit: {r.audit}</span>}
      </span>
      {r.quote && (
        <blockquote className="k-quote">“{r.quote}”
          <cite>{r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer">{r.sourceName}</a> : r.sourceName}</cite>
        </blockquote>
      )}
      {r.also.map((a, i) => (
        <blockquote key={i} className="k-quote">“{a.quote}”<cite>Also: {a.url ? <a href={a.url} target="_blank" rel="noopener noreferrer">{a.sourceName}</a> : a.sourceName}</cite></blockquote>
      ))}
      {r.reason && <p className="k-run__reason"><span className="k-muted">Reasoning: </span>{r.reason}</p>}
      {r.text && <p className="k-run__reason"><span className="k-muted">Reply: </span>{r.text}</p>}
      <span className="k-small k-muted">
        {r.verify ? `Check of the reply: ${r.verify}${r.verifyReason ? ` (${r.verifyReason})` : ""}` : ""}
        {r.signatureVerified != null ? `${r.verify ? " · " : ""}model signature ${r.signatureVerified ? "verified" : "not verified"}` : ""}
        {r.ms != null ? ` · ${(r.ms / 1000).toFixed(1)} s` : ""}
      </span>
    </li>
  );
}
function Round({ r }: { r: RoundDetail }) {
  return (
    <section className="k-round" data-run={r.runNo} data-outcome={r.outcome}>
      <span className="k-row"><strong>Check {r.runNo}</strong><span className="k-tag" data-outcome={r.outcome}>{r.outcome}</span>{r.current && <span className="k-small k-muted">latest</span>}</span>
      {r.at && <WhenText when={r.at} />}
      {r.elements.length > 0 && (
        <ul className="k-list">{r.elements.map((e) => <li key={e.id}><strong>{ANSWER_WORDS[e.verdict] ?? e.verdict}</strong> · {e.q ?? `Question ${e.id}`}</li>)}</ul>
      )}
      {r.runs.length > 0 && <ol className="k-runs">{r.runs.map((x, i) => <RunCard key={i} r={x} />)}</ol>}
      {r.notes.length > 0 && <F label="Resolver notes"><ul className="k-list">{r.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></F>}
      {!r.current && <p className="k-small k-muted">Only the latest check's full reasoning is stored on chain; earlier checks keep their result and fingerprint.</p>}
      {r.elementResultsHash && <F label="Result fingerprint"><HashText value={r.elementResultsHash} label="Copy result fingerprint" /></F>}
      {r.signed != null && <span className="k-small k-muted">{r.signed ? "Signed by the resolver." : "Not signed."}</span>}
      {r.signingKey && <F label="Resolver signing key"><HashText value={r.signingKey} label="Copy resolver signing key" /></F>}
    </section>
  );
}
export function RulingHistory({ ruling, decidedBy, ...rest }: { ruling: BetDetail["ruling"]; decidedBy?: DetailPerson | null } & Data) {
  const empty = ruling.rounds.length === 0 && !ruling.error && !ruling.unreadable;
  return (
    <div {...(rest as object)} className="k-dsec" data-kit="RulingHistory">
      {ruling.error && <p data-testid="ruling-error">The resolver returned an error instead of a ruling: <code className="k-hash">{ruling.error}</code></p>}
      {ruling.unreadable && ruling.rounds.length === 0 && <p data-testid="ruling-unreadable" className="k-muted">The stored ruling isn't in a shape this page can read. Its raw text is below, exactly as stored.</p>}
      {empty && (decidedBy && ruling.finalOutcome
        ? <p><PersonName who={decidedBy} /> ruled <strong>{ruling.finalOutcome}</strong>. A referee's ruling has no AI reasoning.</p>
        : <p className="k-muted">No ruling yet.</p>)}
      {ruling.rounds.map((r) => <Round key={r.runNo} r={r} />)}
      {ruling.challenges.length > 0 && (
        <F label="Challenges" field="challenges">
          <ul className="k-list">
            {ruling.challenges.map((c) => (
              <li key={c.round} data-round={c.round}><PersonName who={c.who} /> challenged in round {c.round} with a {c.bondExact} bond{c.before ? `; the ruling was ${c.before}` : ""}.</li>
            ))}
          </ul>
        </F>
      )}
      {ruling.raw && <RawBlock title="Raw ruling" text={ruling.raw} data-testid="ruling-raw" />}
    </div>
  );
}

// ---------------------------------------------------------------- 5. Evidence filed
export function ExhibitList({ exhibits, rebuttals = [], ...rest }: { exhibits: BetDetail["exhibits"]; rebuttals?: string[] } & Data) {
  if (!exhibits.length && !rebuttals.length) return <p {...(rest as object)} className="k-muted" data-kit="ExhibitList">No evidence filed.</p>;
  return (
    <div {...(rest as object)} className="k-dsec" data-kit="ExhibitList">
      <ol className="k-sources">
        {exhibits.map((x) => (
          <li key={x.index} className="k-source" data-exhibit={x.index}>
            <span className="k-source__n" aria-hidden="true">{x.index}</span>
            <div className="k-stack">
              <span className="k-row"><PersonName who={x.who} /><span className="k-muted k-small">filed evidence</span></span>
              {x.at && <WhenText when={x.at} />}
              <F label="Fingerprint (sha256)"><HashText value={x.hash} label="Copy exhibit hash" /></F>
              <span className="k-small k-muted">The file itself isn't stored on chain, only this fingerprint. Whoever filed it can share the file; its sha256 must match.</span>
            </div>
          </li>
        ))}
      </ol>
      {rebuttals.length > 0 && <F label="Rebuttals"><ul className="k-list">{rebuttals.map((r, i) => <li key={i}><HashText value={r} /></li>)}</ul></F>}
    </div>
  );
}

// ---------------------------------------------------------------- 6. Money & deadlines
export function MoneyDeadlines({ money, deadlines, ...rest }: { money: BetDetail["money"]; deadlines: BetDetail["deadlines"] } & Data) {
  return (
    <div {...(rest as object)} className="k-dsec" data-kit="MoneyDeadlines">
      <section className="k-dsub">
        <p className="k-dsub__title">Money (exact)</p>
        {money.map((m) => <F key={m.key} label={m.label} field={m.key}><span className="k-num">{m.exact}</span>{m.note && <span className="k-small k-muted">{m.note}</span>}</F>)}
      </section>
      <section className="k-dsub">
        <p className="k-dsub__title">Deadlines</p>
        {deadlines.map((d) => <F key={d.key} label={d.label} field={d.key}>{d.when ? <WhenText when={d.when} /> : d.text}{d.note && <span className="k-small k-muted">{d.note}</span>}</F>)}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- 7. Account details (the only place raw ids appear)
export function AccountDetails({ accounts, contractId, ...rest }: { accounts: BetDetail["accounts"]; contractId?: string } & Data) {
  return (
    <div {...(rest as object)} className="k-dsec" data-kit="AccountDetails" data-raw-ids="allowed">
      {accounts.map((a) => (
        <F key={a.key} label={a.role} field={a.key}>
          <PersonName who={a.person} />
          <HashText value={a.person.account} keep={10} label={`Copy ${a.role.toLowerCase()} account id`} />
        </F>
      ))}
      {contractId && <F label="Escrow contract" field="contract"><HashText value={contractId} keep={12} label="Copy contract id" /></F>}
    </div>
  );
}

// ---------------------------------------------------------------- the card
export type DetailSection = "terms" | "sources" | "judge" | "ruling" | "exhibits" | "money" | "accounts";
export const DETAIL_SECTIONS: { id: DetailSection; title: string }[] = [
  { id: "terms", title: "Terms" }, { id: "sources", title: "Sources" }, { id: "judge", title: "AI judge" }, { id: "ruling", title: "Ruling & reasoning" },
  { id: "exhibits", title: "Evidence filed" }, { id: "money", title: "Money & deadlines" }, { id: "accounts", title: "Account details" },
];
/** Everything that decides the bet, one collapsed row per section. `open` opens sections (kit shots / tests). */
export function DetailsCard({ detail, contractId, open = [], onVerifyJudge, ...rest }: { detail: BetDetail; contractId?: string; open?: DetailSection[] | "all"; onVerifyJudge?: () => void } & Data) {
  const isOpen = (id: DetailSection) => open === "all" || open.includes(id);
  const referee = detail.accounts.find((a) => a.key === "referee")?.person ?? null;
  const title = (id: DetailSection) => (id === "judge" && detail.judge.mode === "referee" ? "Who decides" : DETAIL_SECTIONS.find((s) => s.id === id)!.title);
  const body: Record<DetailSection, React.ReactNode> = {
    terms: <BetTerms terms={detail.terms} />,
    sources: <BetSources sources={detail.sources} />,
    judge: <JudgeInfo judge={detail.judge} onVerify={onVerifyJudge} />,
    ruling: <RulingHistory ruling={detail.ruling} decidedBy={referee} />,
    exhibits: <ExhibitList exhibits={detail.exhibits} rebuttals={detail.rebuttals} />,
    money: <MoneyDeadlines money={detail.money} deadlines={detail.deadlines} />,
    accounts: <AccountDetails accounts={detail.accounts} contractId={contractId} />,
  };
  return (
    <section {...(rest as object)} className="k-card k-details" data-kit="DetailsCard" data-testid="bet-details">
      <header className="k-details__head"><h2 className="k-details__title">Details</h2><span className="k-muted k-small">Bet #{detail.id} · everything that decides it</span></header>
      {DETAIL_SECTIONS.map((s) => (
        <DetailRow key={s.id} id={s.id} title={title(s.id)} summary={detail.summary[s.id]} defaultOpen={isOpen(s.id)}>{body[s.id]}</DetailRow>
      ))}
    </section>
  );
}
