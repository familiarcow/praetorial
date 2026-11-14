import React, { useEffect, useRef, useState } from "react";
import { Button, TextField, TextAreaField, CheckField } from "../ui";
import { CLAUSE_OPTIONS, SOURCE_TIERS, type CustomForm, type CustomSource, type SourceTier } from "../../lib/customBuilder";
import { customFieldVisible, localTimeLabel } from "../../lib/betTypePicker";
import { CLAUSES } from "../../lib/judgePrompt";
import { AiBetBox } from "./AiBet";
import {
  MORE_OPTION_FIELDS, defaultEvidenceCutoff, defaultQuestion, detailFieldsFor, localInputToUtc, publisherFromUrl, utcToLocalInput, withDeadline,
  windowOrderProblems, withWindowStart, type DetailField,
} from "../../lib/betDetails";

// BET1a (UX-33 section 2): Details for an "any web page" bet. Shown: the claim, ONE deadline (typed in local time, stored UTC)
// and two source links. Everything else is under "More options" with defaults (lib/betDetails). The lint is unchanged: when it
// flags a field that lives under More options, More options opens and that field is highlighted (and focused on Next).
const FLAG: React.CSSProperties = { outline: "2px solid var(--color-error, #dc2626)", outlineOffset: 4, borderRadius: "var(--radius-element, 8px)" };
const PAST: React.CSSProperties = { outline: "2px solid #d97706", outlineOffset: 4, background: "#fffbeb", borderRadius: "var(--radius-element, 8px)" };
const GROUP: React.CSSProperties = { margin: "var(--spacing-4, 16px) 0" };
const HELP: React.CSSProperties = { display: "block", color: "var(--color-text-secondary)", marginTop: 2 };

/** Past-date keys (FE15 copy) -> the Details field that holds them. */
const PAST_FIELD: Record<string, DetailField> = { windowEnd: "deadline", windowStart: "windowStart", evidenceCutoff: "evidenceCutoff", windowClose: "windowClose" };

export default function BetDetails({ form, human, problems, showProblems, past, focusTick, onChange, onAiFill }: {
  form: CustomForm;
  /** Set on the Who-decides step; a person deciding hides the evidence cutoff/close (nobody collects evidence). */
  human: boolean;
  /** The existing lint's problems for this bet (fillProblems). */
  problems: string[];
  /** FE3b Q2: problems show only after a field is left or Next is tried. */
  showProblems: boolean;
  /** FE15: keys whose copied date is now in the past. */
  past: string[];
  /** Bumped when Next is tried while the lint reports something: focus the first flagged field. */
  focusTick: number;
  onChange: (f: CustomForm) => void;
  /** TPL3: a paste from the user's AI replaced the whole form (the host then shows the normal checks at once). */
  onAiFill?: (f: CustomForm) => void;
}) {
  const cf = form;
  const set = (patch: (f: CustomForm) => CustomForm) => onChange(patch(cf));
  const setSource = (i: number, p: Partial<CustomSource>) => set((f) => ({ ...f, sources: f.sources.map((x, j) => (j === i ? { ...x, ...p } : x)) }));
  const vis = (f: Parameters<typeof customFieldVisible>[0]) => customFieldVisible(f, human);

  const flagged = showProblems ? detailFieldsFor(problems, cf) : [];
  const pastFields = past.map((k) => PAST_FIELD[k]).filter(Boolean);
  // CFIX1: "Counts from" at/after the deadline is shown at once (its inline error must be visible), not only after a blur.
  const orderBad = windowOrderProblems(cf).length > 0;
  const needsMore = orderBad || [...flagged, ...pastFields].some((f) => MORE_OPTION_FIELDS.includes(f));
  const [open, setOpen] = useState(needsMore);
  // MAINFIX2: the auto-open is applied DURING the render that flags the field (React's "adjust state on prop change"), not in a
  // useEffect. The effect landed one commit later (tens of ms under load), so the button still read "More options" while an open
  // was pending, and a press in that window closed it. Same triggers as before: needsMore turning on, or a failed Next (focusTick)
  // while needsMore, which also re-opens it after it was collapsed.
  const [seen, setSeen] = useState({ needsMore, focusTick });
  if (seen.needsMore !== needsMore || seen.focusTick !== focusTick) {
    setSeen({ needsMore, focusTick });
    if (needsMore && !open) setOpen(true);
  }

  // MAINFIX: the press that opens More options also blurs a flagged claim, and that blur auto-opens it first; the click then
  // toggled it shut. The click does what the button said at pointer-down (keyboard presses have no pointer-down: plain toggle).
  const wantOpen = useRef<boolean | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusTick) return;
    const el = box.current?.querySelector<HTMLElement>('[data-flagged="true"] input, [data-flagged="true"] textarea, [data-flagged="true"] select');
    el?.focus();
    el?.scrollIntoView?.({ block: "center" });
  }, [focusTick, open]);

  const mark = (f: DetailField): { "data-field": DetailField; "data-flagged"?: "true"; "data-past"?: "true"; style?: React.CSSProperties } => ({
    "data-field": f,
    ...(flagged.includes(f) ? { "data-flagged": "true" as const } : {}),
    ...(pastFields.includes(f) ? { "data-past": "true" as const } : {}),
    style: { ...GROUP, ...(pastFields.includes(f) ? PAST : {}), ...(flagged.includes(f) ? FLAG : {}) },
  });
  const local = (v: string) => localTimeLabel(v ?? "");

  const deadlineUtc = cf.windowEnd ?? "";
  const cutoffDefault = defaultEvidenceCutoff(deadlineUtc);
  const qDefault = defaultQuestion(cf.claim);
  const typedQuestions = cf.elements.filter((q) => q.trim() !== "").length;
  const sourceCount = cf.sources.filter((s) => s.url.trim() || s.publisher.trim()).length;
  const summary = [
    typedQuestions ? `${typedQuestions} question${typedQuestions > 1 ? "s" : ""} for the judge` : "The judge checks your claim",
    human ? null : cf.evidenceCutoff ? "custom evidence deadline" : "evidence accepted for 7 days after the deadline",
    sourceCount > 2 ? `${sourceCount} sources` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div data-testid="custom-builder" ref={box}>
      <AiBetBox onFill={(f) => (onAiFill ?? onChange)(f)} />

      <div {...mark("claim")}>
        <TextAreaField label="What are you betting on?" data-testid="cb-claim" placeholder="Apple sells a foldable iPhone in the US by Dec 31, 2027." value={cf.claim} onChange={(e) => { const v = e.target.value; set((f) => ({ ...f, claim: v })); }} />
        <small style={HELP}>One sentence that will be clearly true or false: who or what, what happens, and by when.</small>
      </div>

      <div {...mark("deadline")}>
        <TextField label="Deadline (your time)" data-testid="cb-deadline" type="datetime-local" value={utcToLocalInput(deadlineUtc)} onChange={(e) => { const v = localInputToUtc(e.target.value); set((f) => withDeadline(f, v, Date.now())); }} />
        <small style={HELP} data-testid="cb-deadline-utc">{deadlineUtc ? `It must happen by then. Saved as ${deadlineUtc.replace("T", " ")} UTC.` : "It must happen by then."}</small>
      </div>

      <div {...mark("links")} data-testid="cb-links">
        <strong style={{ display: "block" }}>Sources: where the judge checks it</strong>
        <small style={HELP}>Two pages from different websites that will report the result.</small>
        <small style={HELP} data-testid="cb-sources-public">Use public sources neither of you can edit.</small>
        {[0, 1].map((i) => (
          <div key={i} style={{ marginTop: "var(--spacing-2, 8px)" }}>
            <TextField label={`Link ${i + 1}`} hideLabel data-testid={`cb-source-url-${i}`} type="url" placeholder={i === 0 ? "e.g. https://www.apple.com/newsroom/" : "e.g. https://www.reuters.com/technology/"} value={cf.sources[i]?.url ?? ""}
              onChange={(e) => { const v = e.target.value; set((f) => { const s = [...f.sources]; while (s.length <= i) s.push({ publisher: "", url: "", partyControlled: false }); s[i] = { ...s[i], url: v }; return { ...f, sources: s }; }); }} />
          </div>
        ))}
        {human && <small style={HELP} data-testid="human-sources-why">A person decides, but the contract still needs sources it can check.</small>}
      </div>

      <Button type="button" variant="ghost" data-testid="details-more-toggle" aria-expanded={open}
        onPointerDown={() => { wantOpen.current = !open; }}
        onClick={() => { const want = wantOpen.current; wantOpen.current = null; setOpen((o) => want ?? !o); }}>
        {open ? "Hide more options" : "More options"}
      </Button>
      {!open && <small style={HELP} data-testid="details-more-summary">{summary}</small>}

      {open && (
        <div data-testid="details-more">
          <div {...mark("elements")} data-testid="cb-elements">
            <strong style={{ display: "block" }}>The judge's question (YES or NO)</strong>
            <small style={HELP}>Leave blank and the judge checks your claim as written.</small>
            {cf.elements.map((q, i) => (
              <div key={i}>
                <TextField label={`Question ${i + 1}`} hideLabel data-testid={`cb-element-${i}`} placeholder={i === 0 ? qDefault : ""} value={q} onChange={(e) => { const v = e.target.value; set((f) => ({ ...f, elements: f.elements.map((x, j) => (j === i ? v : x)) })); }} />
                {cf.elements.length > 1 && <Button type="button" variant="ghost" size="sm" onClick={() => set((f) => ({ ...f, elements: f.elements.filter((_, j) => j !== i) }))}>remove</Button>}
              </div>
            ))}
            <Button type="button" size="sm" data-testid="cb-add-element" onClick={() => set((f) => ({ ...f, elements: [...f.elements, ""] }))}>Add question</Button>
            {cf.elements.length > 1 && <label style={{ display: "block", marginTop: 8 }}>All questions must be YES, or any one?
              <select data-testid="cb-rule" value={cf.rule} onChange={(e) => { const v = e.target.value as "ALL" | "ANY"; set((f) => ({ ...f, rule: v })); }}>
                <option value="ALL">All must be YES</option><option value="ANY">Any one is enough</option>
              </select>
            </label>}
          </div>

          {vis("sources") && (
            <div {...mark("sourceDetails")} data-testid="cb-sources">
              <strong style={{ display: "block" }}>Sources</strong>
              <small style={HELP}>The name defaults to the link's website. Use public sources neither of you can edit.</small>
              {cf.sources.map((src, i) => (
                <div key={i} style={{ margin: "8px 0" }}>
                  <TextField label={`Source ${i + 1} name`} data-testid={`cb-source-publisher-${i}`} placeholder={publisherFromUrl(src.url) || "e.g. Reuters"} value={src.publisher} onChange={(e) => setSource(i, { publisher: e.target.value })} />
                  {i >= 2 && <TextField label={`Source ${i + 1} link`} data-testid={`cb-source-url-${i}`} type="url" placeholder="https:// (optional)" value={src.url} onChange={(e) => setSource(i, { url: e.target.value })} />}
                  {i >= 2 && <Button type="button" variant="ghost" size="sm" onClick={() => set((f) => ({ ...f, sources: f.sources.filter((_, j) => j !== i) }))}>remove</Button>}
                  <details>
                    <summary>Advanced (price bets)</summary>
                    <TextField label="Short id (optional)" data-testid={`cb-source-id-${i}`} value={src.id ?? ""} onChange={(e) => setSource(i, { id: e.target.value })} />
                    <label>How much the judge trusts it <select data-testid={`cb-source-tier-${i}`} value={src.tier ?? ""} onChange={(e) => setSource(i, { tier: e.target.value as SourceTier })}>
                      <option value="">default</option>{SOURCE_TIERS.map((t) => (<option key={t} value={t}>{t}</option>))}
                    </select></label>
                    <TextField label="Exact name of the market or pair on this source" data-testid={`cb-source-ticker-${i}`} value={src.ticker ?? ""} onChange={(e) => setSource(i, { ticker: e.target.value })} />
                  </details>
                </div>
              ))}
              <Button type="button" size="sm" data-testid="cb-add-source" onClick={() => set((f) => ({ ...f, sources: [...f.sources, { publisher: "", url: "", partyControlled: false }] }))}>Add source</Button>
            </div>
          )}

          {([["windowStart", "Counts from (UTC)", "Things that happen before this don't count. Set to now when you pick the deadline."], ["evidenceCutoff", "Reports accepted until (UTC)", cutoffDefault ? `Default: ${cutoffDefault.replace("T", " ")} UTC (7 days after the deadline).` : "Default: 7 days after the deadline."], ["windowClose", "Last time evidence can be submitted (UTC, optional)", "Leave blank unless you need a hard stop."]] as const).filter(([k]) => vis(k)).map(([k, label, help]) => (
            <div key={k} {...mark(k)}>
              <TextField label={label} data-testid={`cb-${k}`} type="datetime-local" value={cf[k] ?? ""}
                onChange={(e) => { const v = e.target.value; set((f) => (k === "windowStart" ? withWindowStart(f, v, Date.now()) : { ...f, [k]: v })); }} />
              {local(cf[k] ?? "") && <small data-testid={`cb-${k}-local`} style={HELP}>{local(cf[k] ?? "")}</small>}
              {k === "windowStart" && windowOrderProblems(cf).length > 0 && (
                <small role="alert" className="co-error" data-testid="cb-windowStart-error" style={{ display: "block", marginTop: 2 }}>Counts from must be before the deadline ({deadlineUtc.replace("T", " ")} UTC).</small>
              )}
              {help && <small style={HELP}>{help}</small>}
            </div>
          ))}

          {vis("fallbackRule") && (
            <div {...mark("fallbackRule")}>
              <TextAreaField label="If a source is down" data-testid="cb-fallback" placeholder="Any other listed source may confirm." value={cf.fallbackRule} onChange={(e) => { const v = e.target.value; set((f) => ({ ...f, fallbackRule: v })); }} />
              <small style={HELP}>Default: any other listed source can confirm.</small>
            </div>
          )}
          <div {...mark("earlyRule")}>
            <TextAreaField label="Can it settle before the deadline?" data-testid="cb-early" placeholder="Early YES resolution is allowed once the event has happened." value={cf.earlyRule} onChange={(e) => { const v = e.target.value; set((f) => ({ ...f, earlyRule: v })); }} />
            <small style={HELP}>Default: yes, as soon as it happens. If not, write "No early resolution: it settles only at the deadline."</small>
          </div>
          <div {...mark("rules")}>
            <TextAreaField label="What counts and what doesn't (one per line, optional)" data-testid="cb-leading" placeholder="A preorder does not count; it must be on sale." value={(cf.leadingDefinitions ?? []).join("\n")} onChange={(e) => { const v = e.target.value.split("\n"); set((f) => ({ ...f, leadingDefinitions: v })); }} />
            <TextAreaField label="Anything else the judge should know (one per line, optional)" data-testid="cb-other" value={cf.otherDefinitions.join("\n")} onChange={(e) => { const v = e.target.value.split("\n"); set((f) => ({ ...f, otherDefinitions: v })); }} />
          </div>
          <div {...mark("clauses")}>
            <details>
              <summary>Standard rules ({cf.clauses.length} on, the defaults suit most bets)</summary>
              {CLAUSE_OPTIONS.map((c) => (
                <CheckField key={c} label={CLAUSES[c] ? `${CLAUSES[c]} (${c})` : c} data-testid={`cb-clause-${c}`} checked={cf.clauses.includes(c)} onChange={(e) => { const on = e.target.checked; set((f) => ({ ...f, clauses: on ? [...f.clauses, c] : f.clauses.filter((x) => x !== c) })); }} />
              ))}
            </details>
          </div>
          <div style={GROUP}>
            <strong style={{ display: "block" }}>Notes for readers (optional)</strong>
            <small style={HELP}>The judge does not read these.</small>
            {(cf.notes ?? []).map((n, i) => (
              <div key={i}>
                <TextField label="Note label" hideLabel data-testid={`cb-note-name-${i}`} placeholder="label" value={n.name} onChange={(e) => { const v = e.target.value; set((f) => ({ ...f, notes: (f.notes ?? []).map((x, j) => (j === i ? { ...x, name: v } : x)) })); }} />
                <TextField label="Note" hideLabel data-testid={`cb-note-text-${i}`} placeholder="note" value={n.text} onChange={(e) => { const v = e.target.value; set((f) => ({ ...f, notes: (f.notes ?? []).map((x, j) => (j === i ? { ...x, text: v } : x)) })); }} />
                <Button type="button" variant="ghost" size="sm" onClick={() => set((f) => ({ ...f, notes: (f.notes ?? []).filter((_, j) => j !== i) }))}>remove</Button>
              </div>
            ))}
            <Button type="button" size="sm" data-testid="cb-add-note" onClick={() => set((f) => ({ ...f, notes: [...(f.notes ?? []), { name: "", text: "" }] }))}>Add note</Button>
          </div>
        </div>
      )}
    </div>
  );
}
