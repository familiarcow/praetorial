// DOCS1 EXTENSION page 5 (own nav entry): "Trust and verification", for a skeptical stranger. Trust assumptions per layer, then a
// step-by-step check of every part with exact commands (each one <Cmd id/>, sourced and test-run in spikes/docs1/CLAIMS.md), then
// what cannot be proven yet. Anything a stranger can't do today says so here and is a line in spikes/docs1/FOLLOWUPS.md.
// It builds on docs/VERIFY.md (checks E1-E4, B1-B6) and services/verifier; it links them instead of repeating them.
// DOCS2: mainnet-first. Every step names the mainnet accounts and links nearblocks.io; checks that need a settled bet say "Needs a mainnet
// bet" (none yet, lib/mainnetEvidence.ts MAINNET_STATUS) instead of pointing at testnet. Claims: spikes/docs2/CLAIMS.md.
import React from "react";
import { Disclosure, Notice } from "../../kit/blocks";
import { FIXED_SYSTEM, AUDIT_SYSTEM } from "../../../lib/judgePrompt.generated";
import { LAUNCH_JUDGE_CHAIN, RESOLVER_WASM_HASH } from "../../../lib/about";
import { ESCROW_RELEASE, GUARDIAN_POWERS, MAINNET, OPERATOR_POWERS, explorer, NEAR_AI_GUIDE, RESOLVER_RELEASE, TODO } from "../../../lib/docsFacts";
import { MAINNET_STATUS, TX, txUrl } from "../../../lib/mainnetEvidence";
import ACCOUNTS from "../../../lib/mainnetAccounts.json" with { type: "json" };
import { Cmd, DocLink, DocsFrame, Ext, Tag, type Status } from "./parts";

const ESCROW = MAINNET.escrow;
const acct = (id: string) => <Ext href={explorer("mainnet", id)}><code>{id}</code></Ext>;
const tx = (t: { hash: string; label: string }) => <Ext href={txUrl("mainnet", t.hash)}>{t.label} (<code>{t.hash.slice(0, 8)}…</code>)</Ext>;

export interface TrustRow { id: string; layer: string; trustedFor: string; can: string; cannot: string; ifFails: string }
export const TRUST_ROWS: TrustRow[] = [
  { id: "chain", layer: "NEAR and the escrow contract", trustedFor: "Holding both stakes and applying the coded rules exactly.",
    can: `Pay stakes out only to the two sides, minus the fee and storage charge (to our fee account), a referee's tip if one was chosen, and a challenge's run cost (to the keeper, from the challenger's bond). Our guardian account (${ACCOUNTS.guardian}) can only: ${GUARDIAN_POWERS}. Our operator account (${ACCOUNTS.operator}) ${OPERATOR_POWERS}.`,
    cannot: "Be changed or upgraded: the account has no keys left. Nobody, us included, can move a stake by hand or change a taken bet.",
    ifFails: "A bug can't be patched after deploy. An emergency shutdown stops every new payout decision and lets anyone refund any bet whose ruling is not already final." },
  { id: "outlayer", layer: "OutLayer TEE", trustedFor: "Running exactly the pinned judge program, and keeping its signing key secret.",
    can: "Run the program and sign a ruling with the pinned key.",
    cannot: "Run a different program under that fingerprint, or get a ruling with any other key accepted by the escrow.",
    ifFails: "This is the largest assumption. If the TEE or its key handling were broken, a false ruling could be signed. A challenge re-runs the same program on the same service, so it would not help; only an emergency shutdown before payout would." },
  { id: "nearai", layer: "NEAR AI Cloud models", trustedFor: "Reading the page text and filling in the form honestly.",
    can: "Give a wrong answer, or no answer.",
    cannot: "Choose the outcome (code computes it), pick a winner alone (on a custom bet two models must agree; on a data-feed bet the one checking model can only confirm the code's answer or force a VOID), or use a quote that isn't in the page.",
    ifFails: "Disagreement or no answer: retries, then VOID and a refund. A wrong answer both models agree on: challenge it within 24 hours." },
  { id: "sources", layer: "Data sources (publishers)", trustedFor: "Publishing the true answer on the pages named in the term sheet.",
    can: "Be wrong, change a page, or go offline.",
    cannot: "Be picked after the bet: both sides agreed on them up front. A page one bettor controls can't make the result YES or NO, but it can force a refund (VOID).",
    ifFails: "Missing: For built-in bet types the judge retries for up to 7 days. For custom bets, a source that can't be read ends the bet as a refund (VOID). Wrong: the ruling follows the agreed source; you can challenge it." },
  { id: "intents", layer: "NEAR Intents and 1Click solvers", trustedFor: `Holding your betting balance (${MAINNET.intents}), and converting and moving money in and out at the quoted rate.`,
    can: "Be slow, fail a swap, or quote a poor rate.",
    cannot: "Take money that is locked in a bet: stakes sit in the escrow contract until the bet ends.",
    ifFails: "A failed 1Click deposit is refunded to your account by 1Click. Money already in the escrow is not affected." },
  { id: "privy", layer: "Privy login", trustedFor: "Your email login, and keeping the key of your NEAR account (an embedded wallet).",
    can: "If compromised, sign for your account: make bets, cash out from your betting balance, or concede your live bets (the other side then wins).",
    cannot: "Change a bet's terms or its ruling, or move a stake out of the escrow to anyone but the two sides.",
    ifFails: "Your betting balance is at risk like any wallet's. Bets already in the escrow still pay out to your account by the rules." },
  { id: "relayer", layer: "Relayer and keeper (our servers)", trustedFor: `Sending the transactions you signed and paying their network fee (${ACCOUNTS.relayer}); asking for the judge and the payout on time (${ACCOUNTS.keeper}).`,
    can: "Delay or refuse to send something.",
    cannot: "Move money: the relayer only forwards transactions you signed, on a short allow-list, with no deposit on escrow calls. The keeper can't decide a result: only a ruling signed with the pinned key is accepted.",
    ifFails: "Anyone can call the escrow directly: request a ruling, finalize a payout, or refund after the deadline." },
  { id: "frontend", layer: "This website (Cloudflare)", trustedFor: "Showing you the right data and the right transaction to sign.",
    can: "If hacked, show false data or ask you to sign something you didn't mean to.",
    cannot: "Move money without your signature, or change anything already on chain.",
    ifFails: "Check any bet without this site: the explorer, the scripts below, and the escrow's own views." },
];

export const NOT_TRUSTED: { id: string; text: string }[] = [
  { id: "frontend", text: "This website. Everything it shows can be checked on chain without it." },
  { id: "relayer", text: "The relayer. It can't move funds; it pays the fee for transactions you signed." },
  { id: "model", text: "The AI models. They can't choose the outcome: code computes it, and a model can only confirm or force a VOID (data-feed bets) or must agree with a second model (custom bets)." },
  { id: "operator", text: `Us. The escrow has no keys, and we can't change a taken bet, its terms or its ruling. Our powers are the guardian's and the operator's listed above.` },
];

/** One verification step. `screen` = the Verify screen (BetVerify) shows this check too. */
interface Step { id: string; title: string; status: Status; screen?: boolean; body: React.ReactNode }

export const TRUST_STEPS: Step[] = [
  { id: "contract", title: "The contract code, and that it is locked", status: "mainnet", body: <>
    <p>The escrow is {acct(ESCROW)}. It was deployed in {tx(TX.deploy)}, and its last access key was removed in {tx(TX.deleteKey)}. Its guardian and fee account is {acct(ACCOUNTS.guardian)}.</p>
    <p>The escrow's code hash must equal the reproducible build in the release record ({ESCROW_RELEASE.record}): sha256 <code className="wrap">{ESCROW_RELEASE.sha256}</code>, which NEAR shows in base58 as <code className="wrap">{ESCROW_RELEASE.codeHashB58}</code>. Its account must have no access keys.</p>
    <Cmd id="escrow-code-hash" />
    <Cmd id="escrow-keys" />
    <p>Rebuild it yourself from the source (Docker; the script pins the compiler image by digest and prints the sha256):</p>
    <Cmd id="escrow-build" />
    <p>Or let the verifier do E1 to E3 at once (docs/VERIFY.md). E4 is skipped (see step 4), so it ends with exit code 3, not 0: read the three PASS lines.</p>
    <Cmd id="verify-escrow" />
  </> },
  { id: "terms", title: "The terms hash (B1)", status: "pending", screen: true, body: <>
    <p>The bet stores <code>envelope.terms_hash</code>, and every ruling repeats it. sha256 of the bet's terms text must equal it. The terms text is on the bet's Verify screen and in its verification file.</p>
    <Cmd id="get-bet" />
  </> },
  { id: "program", title: "The judge program (E2, E3)", status: "mainnet", screen: true, body: <>
    <p>The third value of <code>resolver_keys</code> is the program fingerprint. OutLayer downloads the program from the address in <code>outlayer_config</code>; the file must hash to the fingerprint. On mainnet that address is under {acct(ACCOUNTS.wasmUploader)}, the account that uploaded the program; the NEAR AI key the program uses is held for it by {acct(ACCOUNTS.aiKeyOwner)}. Rebuild it from the source with the resolver's own script ({RESOLVER_RELEASE.record}).</p>
    <Cmd id="resolver-keys" />
    <Cmd id="outlayer-config" />
    <Cmd id="wasm-download" />
    <Cmd id="resolver-build" />
  </> },
  { id: "keys", title: "The pinned keys, and that they belong to the program (D-KEY1, E4)", status: "mainnet", body: <>
    <p>The first two values of <code>resolver_keys</code> are the ruling key and the attest key. They were set when the escrow was deployed and can't change. The escrow accepts a ruling only if it verifies under the ruling key, and a new bet only with a source check signed by the attest key ({acct(ACCOUNTS.attestSigner)} runs that check).</p>
    <p>OutLayer derives a key from the program and the account that runs it. On mainnet, the pinned program was run in report-pubkey mode four times, and each result is public in the transaction: as the escrow before deploy ({tx(TX.outcomeKeyRun)}) and after ({tx(TX.outcomeKeyCheck)}), and as the attest signer before deploy ({tx(TX.attestKeyRun)}) and after ({tx(TX.attestKeyCheck)}). Read all four; each line must show program <code className="wrap">{RESOLVER_WASM_HASH}</code>, the escrow's runs must show the first <code>resolver_keys</code> value as the ruling key, and the attest signer's runs the second value as the attest key:</p>
    <Cmd id="e4-onchain" />
    <p><strong>Not possible for you yet:</strong> running it again. Only the escrow's own account can ask OutLayer for the escrow's key, and the escrow has no keys left. So you rely on OutLayer's report in those transactions, and the escrow doesn't check it on chain.</p>
  </> },
  { id: "signature", title: "The ruling's signature, and the attestation (B3, B4)", status: "pending", screen: true, body: <>
    <p>Every ruling must verify under the pinned ruling key over the exact message the escrow checks. Run the small checker (no dependencies, Node 18+; this site also serves it as <a href="/verify-bet.mjs" download="verify-bet.mjs">verify-bet.mjs</a>), or the full verifier:</p>
    <Cmd id="verify-bet-mjs" />
    <Cmd id="services-install" />
    <Cmd id="verify-bet-full" />
    <p>Each NEAR AI answer carries NEAR AI's own signature. The full verifier re-checks it and matches the signer against NEAR AI's public attestation report:</p>
    <Cmd id="nearai-attestation" />
    <p><strong>Not working today:</strong> NEAR AI's current reports name each model in <code>model_name</code> (the verifier reads <code>model</code>) and answer HTTP 503 when asked about a <code>signing_address</code>, so this binding ends in SKIP or FAIL until the verifier is updated (checked 13 November 2026).</p>
    <p><strong>Not checked yet:</strong> the hardware quote inside that report (verify it with <Ext href={NEAR_AI_GUIDE}>NEAR AI's attestation guide</Ext>), and an attestation of the OutLayer run itself, which neither the escrow nor our verifier checks today.</p>
  </> },
  { id: "models", title: "The exact models, prompt and settings", status: "mainnet", screen: true, body: <>
    <p>The escrow's <code>judge_chain</code> lists the model pairs; the first pair judges, and a backup is used only once a model before it is retired (3 "model not found" answers at least 24 hours apart). Each model gets <code>temperature: 0</code>, a maximum answer length and JSON-only output (resolver/wasm-bin/src/main.rs).</p>
    <Cmd id="judge-chain" />
    <p>Launch pairs: {LAUNCH_JUDGE_CHAIN.map((p) => `${p.model_a} + ${p.model_b}`).join("; ")}.</p>
    <p>The prompt is fixed text compiled into the judge program (resolver/core/src/lib.rs, FIXED_SYSTEM; the audit prompt is in resolver/wasm-bin/src/template_audit.rs), so the program fingerprint above covers it. <strong>No separate prompt hash is stored on chain</strong>, and the signed ruling doesn't carry one either: to check the prompt, check the program fingerprint.</p>
    <Disclosure title="The judge prompt (from the source)" data-testid="trust-prompt">
      <pre className="docs-pre" data-testid="trust-prompt-system">{FIXED_SYSTEM}</pre>
      <p className="muted small">The audit prompt, used when code has already proposed YES or NO from the extracted values:</p>
      <pre className="docs-pre">{AUDIT_SYSTEM}</pre>
    </Disclosure>
    <p><strong>Re-running it yourself: not possible end to end yet.</strong> Only the sha256 of each page the judge read is on chain, not the page text, and there is no replay tool. With the same page text you could rebuild the request and send it to NEAR AI at temperature 0, but models are not fully deterministic, so an answer can differ.</p>
  </> },
  { id: "evidence", title: "The evidence and the quotes", status: "pending", screen: true, body: <>
    <p>The latest run's record (<code>last_resolution_raw</code> in <code>get_bet</code>; it is not signed, and earlier runs are only in their transactions) lists each page read (address, publisher, sha256 of the text) and each answer with its quotes. With the page text, the full verifier checks that every quote is in it (<code>--judge-evidence</code>, docs/VERIFY.md B4). That text is not published yet, so for now you can check the hashes and quotes, not the match.</p>
  </> },
  { id: "sourcecheck", title: "The source check when the bet was made (B2)", status: "pending", body: <>
    <p>Before a bet opens, a checker confirms its sources can be read and signs the terms hash with the attest key. The full verifier (B2) checks that signature and that it was at most 1 hour old when the bet opened.</p>
  </> },
  { id: "verdict", title: "The verdict, recomputed (B4)", status: "pending", body: <>
    <p>The full verifier applies the same public decision rule (resolver/core/src/lib.rs, <code>decide</code>) to the recorded part verdicts and compares it with the signed outcome.</p>
  </> },
  { id: "order", title: "Run order and timeline (B3, B6)", status: "pending", body: <>
    <p>The escrow refuses a result whose run number is not the next one. The verifier checks the run numbers (B3) and that taking, ruling and payout happened inside the bet's deadlines (B6).</p>
  </> },
  { id: "bonds", title: "Challenge bonds", status: "manual", body: <>
    <p>A challenged bet lists its bonds in <code>get_bet</code> (<code>bonds</code>), and each challenge is a transaction on the explorer. The escrow refuses any bond that is not exactly the required amount: the larger of the token's minimum bond and 10% of the pot, doubled for the second challenge, plus the run price (contracts/escrow/src/lib.rs:2408-2411, <code>required_challenge_bond</code> shows it). The verifier doesn't check bonds yet, so compare them by hand.</p>
    <p className="muted small">Known error in the source comments: lib.rs:1560 and lib.rs:2393 still say the bond is 5% of the pot. The code uses 10%. The contract is locked, so the comments stay as they are.</p>
  </> },
  { id: "payouts", title: "Payouts against balances (B5)", status: "pending", body: <>
    <p>The full verifier (B5) recomputes the winner's payout and the fee and checks them against the payout transactions. VOID refunds and challenged bets are skipped, so check those on the explorer.</p>
  </> },
];

/** COPY1: the SECREV1 on-chain findings (spikes/secrev1/REPORT.md SR-C1, SR-C2, SR-C4), in plain words. The escrow is frozen, so
 *  each is fixed in the next escrow version or off chain; until then they are disclosed here and in the README's Known limits. */
export const KNOWN_LIMITS: { id: string; title: string; text: string }[] = [
  { id: "paid-runs", title: "Paid runs can be used up early (SR-C1)", text: "An AI bet allows 3 paid runs of the judge, and anyone can request one. A side that is losing before the result is final (say, at half-time) can use up all 3 paid runs early. The bet is then refunded at its deadline instead of paid: both stakes come back, but the winner doesn't get their winnings. Planned fix in the next escrow version: refuse a run before its scheduled check time, or don't count an early run." },
  { id: "hash-only", title: "Bets without stored terms (SR-C2)", text: "A bet made outside the app without stored terms can be forced to VOID by anyone, and a challenger on such a bet can lose their challenge bond. The app never makes these and won't take them. Planned fix: the next escrow version." },
  { id: "custom-source", title: "Custom-bet sources (SR-C4)", text: "On a custom bet, if a source can't be read when the judge runs (the site is down or blocks the judge, or it is a page one side controls), the bet ends as a refund (VOID) at once, with no retry. That VOID can be challenged. Planned fix: our keeper will check that the sources can be read before it asks for a ruling." },
];

export const CANNOT_PROVE: { id: string; title: string; text: string }[] = [
  { id: "nondeterminism", title: "Models are not fully deterministic", text: "Run the same question twice and an answer can differ. That is why quotes must be in the source, code decides, a second model or a code check backs each answer, and you can challenge." },
  { id: "tee", title: "TEE trust", text: "We rely on OutLayer and its hardware vendor for the sealed computer. Nothing on chain proves a ruling ran in it." },
  { id: "nearai", title: "NEAR AI Cloud trust", text: "We rely on NEAR AI to run the named model. Our verifier matches its signer to NEAR AI's report but does not check the hardware quote chain." },
  { id: "unaudited", title: "Early, unaudited code", text: "The contract and the judge have not had an external audit. Bugs are possible." },
  { id: "e4", title: "Key-to-program binding", text: "You can read the mainnet E4 runs on chain (step 4), but only the escrow's own account can run them again, and the result is OutLayer's report." },
  { id: "evidence", title: "Page text and re-runs", text: "Page text is not published, so strangers can't re-check quotes against the page or re-run the judge (steps 6 and 7)." },
  { id: "bonds", title: "Challenge bonds", text: "Not checked by the verifier yet (step 11)." },
  { id: "record", title: "Release record gaps", text: "The mainnet release record now names the deploy and key-removal transactions, the setup arguments' hash and the key-binding runs (all checked on chain). The transaction that bound the NEAR AI key is still marked pending." },
  { id: "indexer", title: "History from an indexer", text: "Plain NEAR RPC can't list an account's transactions, so the verifier gets the history from a public indexer and trusts it to be complete." },
  { id: "mainnet-bets", title: "One settled mainnet bet so far", text: `The escrow's bet_count was ${MAINNET_STATUS.betCount} on ${MAINNET_STATUS.checkedAt}: bet 1 has settled and bet 2 awaits its ruling. Challenges, referee rulings and refunds have so far run on the testnet escrow (docs/BETS.md lists every settled bet).` },
  { id: "testnet", title: "The testnet rehearsal escrow is not locked", text: "The testnet escrow we rehearsed on still has an access key. Only the mainnet escrow is locked." },
];

export default function TrustPage() {
  return (
    <DocsFrame page="trust">
      <h1>Trust and verification</h1>
      <p className="docs-lede">For a skeptic. What you have to trust, what each part can and can't do, and how to check each part yourself with public tools. No account, key or server of ours is needed.</p>
      <Notice tone="info" data-testid="trust-status" title="Status on 14 November 2026"
        body={<>The mainnet escrow is <Ext href={explorer("mainnet", ESCROW)}>{ESCROW}</Ext>: deployed ({tx(TX.deploy)}) and locked ({tx(TX.deleteKey)}). Mainnet bet 1 settled on 13 November (ruled NO by the AI judge; <code>node scripts/verify-bet.mjs --network mainnet 1</code> passes all 12 checks), and bet 2, the hackathon bet, is taken and awaiting its ruling: the escrow's <code>bet_count</code> is {MAINNET_STATUS.betCount} (block {MAINNET_STATUS.blockText}). Steps 1, 3 and 4 check the escrow; the per-bet steps use bet 1; put in your bet's number.</>} />

      <h2 id="assumptions">What you trust, layer by layer</h2>
      <table className="docs-table docs-table--trust" data-testid="trust-table">
        <thead><tr><th scope="col">Layer</th><th scope="col">Trusted for</th><th scope="col">Can</th><th scope="col">Cannot</th><th scope="col">If it fails or lies</th></tr></thead>
        <tbody>
          {TRUST_ROWS.map((r) => (
            <tr key={r.id} data-testid={`trust-row-${r.id}`}>
              <th scope="row" data-label="Layer">{r.layer}</th>
              <td data-label="Trusted for">{r.trustedFor}</td>
              <td data-label="Can">{r.can}</td>
              <td data-label="Cannot">{r.cannot}</td>
              <td data-label="If it fails or lies">{r.ifFails}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 id="not-trusted">Not trusted</h3>
      <ul className="facts" data-testid="trust-not-trusted">
        {NOT_TRUSTED.map((n) => <li key={n.id}>{n.text}</li>)}
      </ul>

      <h2 id="verify">How to verify every part</h2>
      <p>Start from the source code ({TODO.repoUrl}). You need git, Node 18 or newer, curl and shasum, and Docker for the two rebuilds. The full list of checks, and what each one does not prove, is docs/VERIFY.md in the source. The <DocLink to="/docs/verification#verify">Verify screen</DocLink> on each bet's page runs several of them in your browser.</p>
      <p>Define this helper once; every <code>view</code> below uses it to read the escrow over public NEAR RPC:</p>
      <Cmd id="view-helper" />
      <ol className="docs-steps" data-testid="trust-steps">
        {TRUST_STEPS.map((s, i) => (
          <li key={s.id} id={`step-${s.id}`} data-testid={`trust-step-${s.id}`}>
            <h3><span className="docs-step-n">{i + 1}.</span> {s.title} <Tag s={s.status} />{s.screen && <span className="docs-tag" data-status="screen">Also on the Verify screen</span>}</h3>
            {s.body}
          </li>
        ))}
      </ol>

      <h2 id="known-limits">Known limits</h2>
      <p>Stakes are never paid to the wrong side. What these gaps can cost is the winnings of a bet you were winning, and in one case a challenge bond.</p>
      <ul className="facts" data-testid="trust-known-limits">
        {KNOWN_LIMITS.map((k) => <li key={k.id} data-testid={`known-limit-${k.id}`}><strong>{k.title}.</strong> {k.text}</li>)}
      </ul>

      <h2 id="limits">What we can't prove yet</h2>
      <ul className="facts" data-testid="trust-limits">
        {CANNOT_PROVE.map((c) => <li key={c.id} data-testid={`limit-${c.id}`}><strong>{c.title}.</strong> {c.text}</li>)}
      </ul>
    </DocsFrame>
  );
}
