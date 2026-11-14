// DOCS1 page 2: how an outcome is verified and why it is safe, high level. The concrete commands are on the Trust page. The judge
// models and "How to verify a bet" rows are About's (lib/about.ts), unchanged, so /about#verify and the Verify sheets land here.
// Claims: spikes/docs1/CLAIMS.md "Page 2".
import React from "react";
import { NETWORK } from "../../../lib/network";
import { AboutSections } from "../AboutPage";
import { DocLink, DocsFrame, Ext } from "./parts";
import { GUARDIAN_POWERS, MAINNET, explorer } from "../../../lib/docsFacts";

const ESCROW = MAINNET.escrow;

export const SAFEGUARDS: { id: string; title: string; text: React.ReactNode }[] = [
  { id: "terms", title: "The terms are fixed", text: "The term sheet's sha256 hash is stored with the bet when it is made. Every ruling must carry the same hash, or the escrow refuses it." },
  { id: "contract", title: "The contract can't change", text: `The escrow's account has no keys left, so nobody, us included, can change its code or move its money by hand. Its code matches a reproducible build of its source. Our guardian account can only do what the code allows: ${GUARDIAN_POWERS}. After a shutdown, anyone can refund a bet whose ruling is not already final.` },
  { id: "code-decides", title: "Code decides, the models only fill in a form", text: "The models don't pick a winner. For bets that code can check from a data feed (such as a price, a game result or a temperature), code reads the data and proposes YES or NO, and one model checks it: it can only confirm that answer or force a VOID. For a custom bet, each model fills in a fixed form for each part of the question: met, not met, not enough evidence, or the sources conflict, with a quote from the source for met or not met. Fixed code then turns those answers into YES, NO or VOID." },
  { id: "burden", title: "Burden of proof is on YES", text: "YES needs the sources to prove it. A part that isn't proven counts as not met. Missing or not-yet-final data is different: it never counts as a NO. The judge waits until the bet's date. For built-in bet types the judge retries for up to 7 days. For custom bets, a source that can't be read ends the bet as a refund (VOID). A VOID refunds both sides." },
  { id: "two-models", title: "Two models, real quotes", text: "On a custom bet, two models answer separately and must agree (each launch pair is from two different companies; the escrow only requires two different models). If they disagree they run once more, and if they still disagree that part has no answer and the bet is VOID. Every quote must appear in the page the judge read (ignoring case, spacing and punctuation; numbers must match exactly). Unless every source is on our fixed list of data pages (such as price feeds), a YES or NO needs quotes from two different websites." },
  { id: "tee", title: "A sealed program, a pinned key", text: "The judge is one fixed program, run by OutLayer inside a sealed computer (a TEE). It signs each ruling with a key the escrow pinned at deploy, and the escrow refuses any other signature. The key is tied to the program: OutLayer derives it from the program's fingerprint and the account that runs it. That this key belongs to that program was checked at deploy, and those runs are public mainnet transactions (see Trust and verification, step 4); the escrow can't check the TEE itself." },
  { id: "run-order", title: "Strict run order", text: "Judge runs are numbered, and the escrow accepts results only in that order. Nobody can run the judge again and again and keep the answer they like. A final YES or NO pays the winner, unless no ruling can be made in time (for example someone uses up the 3 paid runs early); then both sides are refunded." },
  { id: "disputes", title: "Challenges with a doubling bond", text: "After an AI ruling, either side has 24 hours to challenge it. The challenger posts a bond (the larger of a fixed minimum and 10% of the pot, doubled for the second challenge, plus the cost of the new run), and the bet is judged again. There can be up to two challenges." },
  { id: "failsafe", title: "When in doubt, a refund", text: "If the judge rules VOID, or no ruling arrives before the bet's last date, each side gets its own stake back with no protocol fee; the small terms-storage charge is not refunded. After an emergency shutdown, anyone can trigger the refund of a bet whose ruling is not already final." },
];

export default function VerificationPage() {
  return (
    <DocsFrame page="verification">
      <h1>How a result is verified</h1>
      <p className="docs-lede">The rules are fixed before the bet, one fixed program applies them, and every step is signed and recorded on NEAR mainnet, in the escrow <Ext href={explorer("mainnet", ESCROW)}><code>{ESCROW}</code></Ext>.
        Stakes go back to each side, never to the wrong one. A challenge bond can be lost: see <DocLink to="/docs/trust#known-limits">Trust › Known limits</DocLink>.</p>
      <ul className="facts" data-testid="docs-safeguards">
        {SAFEGUARDS.map((s) => <li key={s.id} id={s.id} data-testid={`safeguard-${s.id}`}><strong>{s.title}.</strong> {s.text}</li>)}
      </ul>

      <h2 id="check">Check a settled bet yourself</h2>
      <ol className="steps">
        <li><strong>In the app.</strong> Open the bet, then Activity, then Verify, or tap "Verify this ruling" on the ruling. The Verify screen re-checks the terms hash and the ruling's signature in your browser, and links every transaction to a public explorer.</li>
        <li><strong>On a block explorer.</strong> Open the escrow <Ext href={explorer("mainnet", ESCROW)}>{ESCROW} on NearBlocks</Ext>. Its transaction list has every step of every bet: making and taking it, each ruling (<code>submit_outcome</code>), each challenge, and each payout (<code>finalize</code>).</li>
        <li><strong>What to compare.</strong> The bet's terms hash (<code>get_bet</code>, <code>envelope.terms_hash</code>) must equal the sha256 of its terms. The escrow's <code>resolver_keys</code> gives the ruling key, the attest key (it signs the source check when a bet is made) and the program fingerprint; every ruling must verify under that ruling key.</li>
        <li><strong>Step by step.</strong> The exact commands, and what each check does not prove, are on <DocLink to="/docs/trust" data-testid="docs-trust-link">Trust and verification</DocLink>.</li>
      </ol>
      {NETWORK.networkId !== "mainnet" && <p className="muted small">This site runs on the NEAR test network. Its escrow is on <Ext href={explorer("testnet", NETWORK.escrow)}>testnet NearBlocks</Ext>.</p>}

      <h2 id="details">Judge models and the Verify sheet</h2>
      <AboutSections ids={["models", "verify"]} />
    </DocsFrame>
  );
}
