// TPL3 (familiarcow 11-12: "have the user's own agent generate the field inputs"): the copy-paste prompt (lib/betPrompt) as
// (1) a Copy prompt button, (2) the public /guide/custom-bet page and (3) the "Paste from your AI" box in the custom bet form.
// A paste fills the WHOLE form or nothing: a bad paste shows one plain error and the form is left exactly as it was.
import React, { useState } from "react";
import { Banner, Button, TextAreaField } from "../ui";
import { BET_EXAMPLES, BET_PROMPT, parseAiBet } from "../../lib/betPrompt";
import type { CustomForm } from "../../lib/customBuilder";

export const GUIDE_PATH = "/guide/custom-bet";
const HELP: React.CSSProperties = { display: "block", color: "var(--color-text-secondary)", marginTop: 2 };
// the app's CSS reset strips list markers; the guide's steps are numbered and its rules bulleted
const LIST = (type: "decimal" | "disc"): React.CSSProperties => ({ listStyleType: type, paddingLeft: "var(--spacing-5, 20px)", margin: "var(--spacing-2, 8px) 0" });
const PRE: React.CSSProperties = { whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "var(--color-background-secondary, #f6f6f6)", padding: "var(--spacing-3, 12px)", borderRadius: "var(--radius-element, 8px)", fontSize: "0.85em" };

export function CopyPromptButton({ testId = "ai-copy-prompt" }: { testId?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try { await navigator.clipboard.writeText(BET_PROMPT); setState("copied"); } catch { setState("failed"); }
  };
  return (
    <>
      <Button type="button" size="sm" data-testid={testId} onClick={copy}>{state === "copied" ? "Copied" : "Copy prompt"}</Button>
      {state === "failed" && <small style={HELP} data-testid={`${testId}-failed`} role="status">Couldn't copy. Open the guide and select the prompt by hand.</small>}
    </>
  );
}

/** The box at the top of the custom bet form. */
export function AiBetBox({ onFill }: { onFill: (form: CustomForm) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const fill = () => {
    const r = parseAiBet(text, Date.now());
    if (!r.ok) { setError(r.error); setDone(""); return; }
    setError("");
    setDone(r.ignored.length ? `Filled in. Ignored: ${r.ignored.join(", ")}.` : "Filled in. Check it below.");
    setText("");
    onFill(r.form);
  };
  return (
    <section data-testid="ai-bet" style={{ margin: "var(--spacing-2, 8px) 0 var(--spacing-4, 16px)" }}>
      <strong style={{ display: "block" }}>Write it with your AI</strong>
      <small style={HELP}>
        Give our prompt to ChatGPT, Claude or your agent, describe the bet, and paste its answer here.{" "}
        <a href={GUIDE_PATH} target="_blank" rel="noopener" data-testid="ai-guide-link" style={{ textDecoration: "underline" }}>How it works</a>
      </small>
      <span style={{ display: "inline-flex", gap: "var(--spacing-2, 8px)", marginTop: "var(--spacing-2, 8px)", flexWrap: "wrap" }}>
        <CopyPromptButton />
        <Button type="button" size="sm" variant="ghost" data-testid="ai-paste-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide paste box" : "Paste from your AI"}
        </Button>
      </span>
      {done && !open && <small style={HELP} role="status" data-testid="ai-paste-done">{done}</small>}
      {open && (
        <span style={{ display: "block", marginTop: "var(--spacing-2, 8px)" }}>
          <TextAreaField label="Your AI's answer" data-testid="ai-paste" placeholder='{ "claim": "...", "deadline_utc": "2027-12-31T23:59Z", "sources": [...] }'
            value={text} onChange={(e) => { setText(e.target.value); setError(""); }} />
          <small style={HELP}>This replaces what's in the form below.</small>
          {error && <Banner status="error" role="alert" data-testid="ai-paste-error">{error}</Banner>}
          {done && <small style={HELP} role="status" data-testid="ai-paste-done">{done}</small>}
          <Button type="button" size="sm" data-testid="ai-paste-fill" onClick={fill}>Fill the form</Button>
        </span>
      )}
    </section>
  );
}

/** /guide/custom-bet: public (no login), static. Same text as docs/BET-PROMPT.md. */
export function GuidePage() {
  return (
    <article data-testid="guide-page" className="about" style={{ maxWidth: 760, margin: "0 auto", padding: "var(--spacing-4, 16px)" }}>
      <p><a href="/" data-testid="guide-home">Praetorial</a></p>
      <h1>Write a custom bet with your AI</h1>
      <p>An "Anything else" bet is settled by an AI judge that reads public web pages after the deadline, so the fields have to be exact.
        The easiest way to fill them in is to let your own AI do it.</p>
      <ol data-testid="guide-steps" style={LIST("decimal")}>
        <li>Copy the prompt below.</li>
        <li>Paste it into ChatGPT, Claude or your agent, and replace <code>{"<<< DESCRIBE YOUR BET HERE >>>"}</code> with your bet, in your own words.</li>
        <li>Answer any questions it asks. It replies with a block of text that starts with <code>{"{"}</code>.</li>
        <li>In the bet form, press <strong>Paste from your AI</strong>, paste it and press <strong>Fill the form</strong>. The form runs the same checks as typing it yourself.</li>
      </ol>
      <h2>The prompt</h2>
      <CopyPromptButton testId="guide-copy-prompt" />
      <pre style={PRE} data-testid="guide-prompt">{BET_PROMPT}</pre>
      <h2>The rules</h2>
      <ul data-testid="guide-rules" style={LIST("disc")}>
        <li><strong>Sources.</strong> Use public sources neither of you can edit, from two different websites.</li>
        <li><strong>Deadline.</strong> One exact time in UTC, like 2027-12-31T23:59Z.</li>
        <li><strong>Question.</strong> One YES or NO question. YES means the claim happened.</li>
        <li><strong>Evidence.</strong> The judge counts only what those sources publish before the deadline (late reports for up to 7 days after). Opinions can't be judged.</li>
      </ul>
      <h2>Examples</h2>
      {BET_EXAMPLES.map((ex, i) => (
        <section key={i} data-testid={`guide-example-${i}`}>
          <h3>{i + 1}. {ex.title}</h3>
          <p>You tell your AI: <em>{ex.ask}</em></p>
          <pre style={PRE}>{JSON.stringify(ex.json, null, 2)}</pre>
        </section>
      ))}
    </article>
  );
}
