// NAV1 (UX-31 About): static, plain English. Copy and sources live in lib/about.ts (unit-tested). The judge models are read live from
// the escrow's judge_chain view; until that answers (or if it fails) the launch chain from the mainnet args is shown.
// DOCS1: About is no longer a page of its own (/about redirects to /docs). Its sections are rendered INSIDE the Docs pages by
// <AboutSections ids=[...]/>: "what"/"how"/"fees"/"know" on /docs, "models"/"verify" on /docs/verification. Same copy, same test ids.
// The 3 step cards (ABOUT_STEPS) are replaced on /docs by the lifecycle diagram (spec: "a one-diagram lifecycle").
import React, { useEffect, useState } from "react";
import { ABOUT, LAUNCH_JUDGE_CHAIN, aboutSummary, judgePairsForAbout, feeRows, modelLabel, RESOLVER_WASM_HASH } from "../../lib/about";
import { loadJudgeChain, judgeChainDisplay, type RawJudgePair, type JudgeChainDisplay } from "../../lib/judgeChain";
import { WALLET_ASSETS } from "../../lib/walletCards";
import { isAssetEnabled } from "../../lib/assets";
import type { AboutSection } from "../../lib/about";

export function AboutSections({ ids }: { ids: ReadonlyArray<AboutSection["id"]> }) {
  const [chain, setChain] = useState<RawJudgePair[]>(LAUNCH_JUDGE_CHAIN);
  const [live, setLive] = useState<"loading" | "live" | "fallback">("loading");
  const [pending, setPending] = useState<JudgeChainDisplay["pending"]>(null);
  useEffect(() => {
    let off = false;
    loadJudgeChain().then(
      (v) => { if (off) return; if (v.chain.length) { setChain(v.chain); setLive("live"); } else setLive("fallback"); setPending(judgeChainDisplay(v).pending); },
      () => { if (!off) setLive("fallback"); },
    );
    return () => { off = true; };
  }, []);
  // V1: /about#verify (linked from every Verify sheet) lands on "How to verify a bet", opened (A1: sections are collapsed).
  const [hash, setHash] = useState(() => (typeof window !== "undefined" ? window.location.hash.slice(1) : ""));
  useEffect(() => {
    const on = () => setHash(window.location.hash.slice(1));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash);
    if (el instanceof HTMLDetailsElement) el.open = true;
    el?.scrollIntoView?.({ block: "start" });
  }, [hash]);
  const pairs = judgePairsForAbout(chain);
  const first = chain[0] ? `${modelLabel(chain[0].model_a)} + ${modelLabel(chain[0].model_b)}` : "";
  const fees = feeRows(WALLET_ASSETS.filter((s) => isAssetEnabled(s)));

  return (
    <div data-testid="about-sections">
      {/* A1 (UIR1 §3.7): "What Praetorial is" stays open; every other section is a collapsed row with a summary. */}
      {ABOUT.filter((s) => ids.includes(s.id)).map((s) => {
        const summary = aboutSummary(s.id, first ? { firstPair: first, pairs: chain.length } : undefined);
        const body = (<>
          {s.paragraphs?.map((p) => <p key={p}>{p}</p>)}
          {s.steps && (
            <ol className="steps">
              {s.steps.map((st) => <li key={st.title}><strong>{st.title}.</strong> {st.text}</li>)}
            </ol>
          )}
          {s.bulletsTitle && <h3 data-testid={`about-${s.id}-bullets-title`}>{s.bulletsTitle}</h3>}
          {s.bullets && (
            <ul className="facts">
              {s.bullets.map((b) => <li key={b.title}><strong>{b.title}.</strong> {b.text}</li>)}
            </ul>
          )}
          {s.id === "models" && (
            <>
              <ol data-testid="judge-models" data-source={live} className="models">
                {pairs.map((p) => (
                  <li key={p.position} data-testid={`judge-pair-${p.position}`}><span className="muted">{p.role}:</span> {p.label}</li>
                ))}
              </ol>
              {pending && <p data-testid="judge-pending">{pending.label}: {pending.modelA} + {pending.modelB}</p>}
            </>
          )}
          {s.id === "verify" && (
            <p className="muted small">Full fingerprint: <code data-testid="about-wasm-hash" className="wrap">{RESOLVER_WASM_HASH}</code></p>
          )}
          {s.dev && (
            <aside className="about-dev" data-testid={`about-${s.id}-dev`}>
              <h3>{s.dev.title}</h3>
              <p>{s.dev.text}</p>
              <p><code className="wrap" data-testid="about-dev-command">{s.dev.command}</code></p>
              <p><a href={s.dev.scriptHref} download="verify-bet.mjs" data-testid="about-dev-script">Download verify-bet.mjs</a></p>
            </aside>
          )}
          {s.id === "fees" && (
            <table data-testid="about-fee-table">
              <thead><tr><th scope="col">Token</th><th scope="col">Minimum fee per side</th><th scope="col">Minimum stake per side</th></tr></thead>
              <tbody>
                {fees.map((r) => <tr key={r.symbol} data-testid={`about-fee-${r.symbol}`}><td>{r.symbol}</td><td>{r.minFee}</td><td>{r.minStake}</td></tr>)}
              </tbody>
            </table>
          )}
        </>);
        if (summary === null) return (
          <section key={s.id} id={s.id} data-testid={`about-${s.id}`} aria-labelledby={`about-${s.id}-title`}>
            <h2 id={`about-${s.id}-title`}>{s.title}</h2>
            {body}
          </section>
        );
        return (
          <details key={s.id} id={s.id} data-testid={`about-${s.id}`} className="k-disc about-disc" open={hash === s.id || undefined}>
            <summary>
              <h2 id={`about-${s.id}-title`} className="k-disc__title">{s.title}</h2>
              <span className="k-disc__summary" data-testid={`about-${s.id}-summary`}>{summary}</span>
              <span className="k-disc__chev" aria-hidden="true">›</span>
            </summary>
            <div className="k-disc__body">{body}</div>
          </details>
        );
      })}
    </div>
  );
}
