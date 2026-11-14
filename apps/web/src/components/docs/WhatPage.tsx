// DOCS1 page 1: what Praetorial is, the term sheet, and a bet's life in one diagram. The intro and the collapsed "how / fees / good
// to know" rows are About's copy (lib/about.ts), unchanged. Claims: spikes/docs1/CLAIMS.md "Page 1".
import React from "react";
import { ABOUT } from "../../../lib/about";
import { AboutSections } from "../AboutPage";
import { DocLink, DocsFrame, Ext } from "./parts";
import { MAINNET, explorer } from "../../../lib/docsFacts";
import { settledLine } from "../../../lib/settledBets";

/** The lifecycle, left to right (top to bottom on a phone). The last step forks: payout or refund. */
export const LIFECYCLE: { id: string; title: string; text: string }[] = [
  { id: "create", title: "Create", text: "You write the question, the sources and the deadline, and put in your stake." },
  { id: "take", title: "Take", text: "Someone puts in their stake. Until then you can cancel, and if nobody takes it, your stake comes back." },
  { id: "deadline", title: "Deadline", text: "The bet's date passes. The named sources publish the answer." },
  { id: "judge", title: "Judge", text: "The AI judge reads the named sources. For a data-feed bet (a price, a game, a temperature) code decides and one model checks it; for a custom bet two models must agree. Code turns their answers into YES, NO or VOID. Then 24 hours to challenge." },
];
export const LIFECYCLE_ENDS: { id: string; title: string; text: string }[] = [
  { id: "payout", title: "Payout", text: "YES or NO: the winner gets both stakes, minus the fee." },
  { id: "refund", title: "Refund", text: "VOID, or no ruling in time: each side gets its own stake back. No fee." },
];

export function Lifecycle() {
  return (
    <figure className="docs-flow" data-testid="docs-lifecycle" aria-label="A bet's life: create, take, deadline, judge, then payout or refund">
      <ol>
        {LIFECYCLE.map((s, i) => (
          <li key={s.id} data-testid={`flow-${s.id}`} className="docs-flow__step">
            <span className="docs-flow__n" aria-hidden="true">{i + 1}</span>
            <strong>{s.title}</strong>
            <span>{s.text}</span>
          </li>
        ))}
        <li className="docs-flow__fork">
          <ul>
            {LIFECYCLE_ENDS.map((s) => (
              <li key={s.id} data-testid={`flow-${s.id}`} className="docs-flow__step" data-end={s.id}>
                <strong>{s.title}</strong>
                <span>{s.text}</span>
              </li>
            ))}
          </ul>
        </li>
      </ol>
    </figure>
  );
}

export default function WhatPage() {
  const what = ABOUT.find((s) => s.id === "what")!;
  return (
    <DocsFrame page="what">
      <h1>What Praetorial is</h1>
      <p className="docs-lede">Somebody has to hold the money and decide who won. Praetorial does both: an escrow on NEAR that nobody controls, and an AI judge you can check.</p>
      <p>Bet anyone on anything the internet can prove: prices, sports, the weather, announcements and news. Your bet reads like a short contract: the claim, the sources that will answer it, the deadline. The stakes sit in a NEAR contract with no access keys, so nobody can touch them, not even us. The judge runs in a sealed computer (a TEE) and its code is pinned on chain. It's settled by the AI judge, or by a person you both trust.</p>
      {what.paragraphs!.map((p) => <p key={p}>{p}</p>)}
      <p data-testid="docs-mainnet">It runs on NEAR mainnet. The escrow contract is <Ext href={explorer("mainnet", MAINNET.escrow)}><code>{MAINNET.escrow}</code></Ext>: deployed, with no access keys left, so nobody can change it. Mainnet bet 1, on Bitcoin's price at a set time, was ruled NO and settled; bet 2, the hackathon bet, is taken and awaiting its ruling. In all, {settledLine("text")} The <DocLink to="/docs/hackathon">Hackathon</DocLink> page has the details.</p>

      <h2 id="term-sheet">The term sheet</h2>
      <p>Before any money moves, both sides agree on a term sheet: one YES or NO question, the public sources that will answer it, and the deadline.
        Its fingerprint (a sha256 hash) is stored with the bet on NEAR, so neither side can change the terms alone afterwards.</p>
      <p>The judge only reads those sources. Missing data never counts as a NO. For built-in bet types the judge retries for up to 7 days. For custom bets, a source that can't be read ends the bet as a refund (VOID). If the answer isn't there, both sides are refunded.
        To write a custom bet, you can let your own AI fill in the term sheet: <DocLink to="/guide/custom-bet" data-testid="docs-guide-link">Write a custom bet with your AI</DocLink>.</p>

      <h2 id="lifecycle">A bet's life</h2>
      <Lifecycle />
      <p className="muted small">A bet can name a person both sides trust instead of the AI. That person rules once, and the bet pays out straight away.</p>

      <h2 id="more">More detail</h2>
      <AboutSections ids={["how", "fees", "know"]} />
      <p>Next, see <DocLink to="/docs/verification">how a result is verified</DocLink>, or <DocLink to="/docs/trust">check each part yourself</DocLink>.</p>
    </DocsFrame>
  );
}
