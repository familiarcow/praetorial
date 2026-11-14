// DOCS1 page 5, rewritten MAINNET-FIRST by DOCS2: the NEAR hackathon submission page. It leads with the technical achievements, each a
// card whose status and transactions come from lib/mainnetEvidence.ts (never "Proven" without a mainnet tx or bet id: effectiveStatus),
// then the testnet case studies from lib/caseStudies.ts (always labelled "Testnet rehearsal"; mainnet cases, once DOCS3 adds them,
// come first), then the mainnet deployment, built vs planned, rules and tracks, license, how to run, team and limits.
// Claims: spikes/docs2/CLAIMS.md (and spikes/docs1/CLAIMS.md "Page 5" for the rules). Rules: nearhackathon.com (read 12 Nov 2026).
import React from "react";
import { LAUNCH_JUDGE_CHAIN, RESOLVER_WASM_HASH, feeRows } from "../../../lib/about";
import { ASSET_TABLE, isAssetEnabled } from "../../../lib/assets";
import { ESCROW_RELEASE, GUARDIAN_POWERS, MAINNET, OPERATOR_POWERS, explorer, TODO } from "../../../lib/docsFacts";
import { MAINNET_EVIDENCE, MAINNET_STATUS, CLAIM_IDS, STATUS_LABEL, TX, effectiveStatus, txUrl, type ClaimId, type Evidence } from "../../../lib/mainnetEvidence";
import { CASE_STUDIES, caseLabel, orderedCases, type CaseStudy } from "../../../lib/caseStudies";
import { settledLine } from "../../../lib/settledBets";
import ACCOUNTS from "../../../lib/mainnetAccounts.json" with { type: "json" };
import { Cmd, DocLink, DocsFrame, Ext, Tag } from "./parts";

const acct = (id: string) => <Ext href={explorer("mainnet", id)}><code>{id}</code></Ext>;
const MAIN_SYMBOLS = ASSET_TABLE.filter((a) => isAssetEnabled(a.symbol, "mainnet")).map((a) => a.symbol);
const usd = (s: string) => { const n = Number(s.split(" ")[0]); return `$${Number.isInteger(n) ? n : n.toFixed(2)}`; };
const USDC_LIMITS = feeRows(["USDC"])[0]!;
/** "$10 per side" and "1% per side, at least $0.50": the USDC row of the release limits (release/mainnet-night/limits.md). */
export const MIN_STAKE_USD = usd(USDC_LIMITS.minStake);
export const MIN_FEE_USD = usd(USDC_LIMITS.minFee);

/** The eight achievement cards, (a) to (h). Status and transactions: lib/mainnetEvidence.ts. */
export const ACHIEVEMENTS: Record<ClaimId, { title: string; body: React.ReactNode }> = {
  judge: { title: "An AI judge that cannot pick the outcome", body: <>
    <p>On a custom bet, for each part of the question, each model fills in a fixed form: met, not met, not enough evidence, or the sources conflict, with a quote from a source page. Code checks every quote against the page the judge read, needs two different models (the launch pairs are each from two companies) to agree, and then computes YES, NO or VOID itself (resolver/core/src/lib.rs, <code>decide</code>). On a data-feed bet (a price, a game, a temperature) code reads the data and decides, and one model checks it: it can only confirm or force a VOID. No model ever writes the outcome.</p>
  </> },
  "signed-keys": { title: "Enclave-signed results with pinned keys", body: <>
    <p>The judge program runs inside OutLayer's sealed computer (a TEE) and signs each ruling with a key that OutLayer derives for that exact program and caller. At deploy the escrow pinned the ruling key, the attest key and the program fingerprint <code>{RESOLVER_WASM_HASH.slice(0, 8)}…</code>, and it refuses any other signature.</p>
  </> },
  immutable: { title: "A locked contract nobody can change", body: <>
    <p>{acct(MAINNET.escrow)} holds every stake. Its last access key was deleted right after deploy, so there are no upgrades and no admin withdrawals. The guardian {acct(ACCOUNTS.guardian)} can do only this: {GUARDIAN_POWERS}. After a shutdown anyone can refund a bet whose ruling is not already final.</p>
  </> },
  reproducible: { title: "Reproducible builds anyone can re-check", body: <>
    <p>Rebuild both programs from the source with Docker and compare with these hashes:</p>
    <ul className="facts">
      <li>Escrow: sha256 <code className="wrap">{ESCROW_RELEASE.sha256}</code>, which NEAR shows in base58 as <code className="wrap">{ESCROW_RELEASE.codeHashB58}</code>.</li>
      <li>Judge program: sha256 <code className="wrap">{RESOLVER_WASM_HASH}</code>.</li>
    </ul>
    <Cmd id="escrow-build" />
    <Cmd id="resolver-build" />
    <p>Then compare with the chain (checks E1 and E3): <DocLink to="/docs/trust#step-contract">Trust and verification, steps 1 and 3</DocLink>.</p>
  </> },
  failsafe: { title: "Fail-safe: when in doubt, a refund", body: <>
    <p>Missing data never counts as NO. For built-in bet types the judge retries for up to 7 days. For custom bets, a source that can't be read ends the bet as a refund (VOID). If the judge rules VOID, or no ruling arrives by the bet's last date, each side gets its own stake back with no protocol fee; the small terms-storage charge is not refunded. Anyone can trigger that refund.</p>
  </> },
  disputes: { title: "Disputes with a doubling bond and an AI re-judge", body: <>
    <p>Either side has 24 hours to challenge an AI ruling. The bond is the larger of a fixed minimum and 10% of the pot, doubled for the second challenge, plus the cost of the new run; then the same program judges again. There can be up to two challenges.</p>
  </> },
  intents: { title: "Bet in any of six tokens, fund and cash out from other chains", body: <>
    <p>Stakes come from your own NEAR Intents account ({acct(ACCOUNTS.intents)}) in {MAIN_SYMBOLS.join(", ")}. The contract supports each side using a different token; the app creates same-token bets for now. 1Click gives you a deposit address on another chain and converts what you send; it also cashes out to an address on another chain. <DocLink to="/docs/near-intents">NEAR Intents</DocLink> has the details.</p>
  </> },
  verifier: { title: "A public verifier", body: <>
    <p>Every bet has a Verify screen that re-checks its terms hash and ruling signature in your browser. <code>scripts/verify-bet.mjs</code> does the same from a terminal with no dependencies (this site serves it as <a href="/verify-bet.mjs" download="verify-bet.mjs">verify-bet.mjs</a>), and <code>services/verifier</code> runs every check in docs/VERIFY.md (E1 to E4 for the escrow, B1 to B6 for a bet).</p>
  </> },
};

function TxList({ network, txs }: { network: "mainnet" | "testnet"; txs: { hash: string; label: string }[] }) {
  return (
    <ul className="docs-txs">
      {txs.map((t) => <li key={t.hash + t.label}>{t.label}: <Ext href={txUrl(network, t.hash)}><code>{t.hash.slice(0, 10)}…</code></Ext></li>)}
    </ul>
  );
}

/** The cards (a)-(h). `evidence` is a prop so a test can prove a proven claim without txs renders as In progress. */
export function AchievementCards({ evidence = MAINNET_EVIDENCE }: { evidence?: Record<ClaimId, Evidence> }) {
  return (
    <ol className="docs-cards" data-testid="hack-achievements">
      {CLAIM_IDS.map((id, i) => {
        const e = evidence[id];
        const status = effectiveStatus(e);
        const a = ACHIEVEMENTS[id];
        return (
          <li key={id} className="docs-card" data-testid={`achievement-${id}`} data-status={status}>
            <h3><span className="docs-step-n">({String.fromCharCode(97 + i)})</span> {a.title}</h3>
            <p><span className="docs-tag" data-status={status}>{STATUS_LABEL[status]}</span></p>
            {a.body}
            {status !== "in-progress" && <>
              <p><strong>On mainnet.</strong> {e.shows}</p>
              <TxList network="mainnet" txs={e.txs} />
              {e.betIds.length > 0 && <p>Bets: {e.betIds.map((b) => <span key={b} data-bet-id={b}>#{b} </span>)}</p>}
            </>}
            {status === "in-progress" && <p className="muted"><strong>In progress.</strong> {e.shows}</p>}
            {e.pending && <p className="muted">{e.pending}</p>}
          </li>
        );
      })}
    </ol>
  );
}

/** The case studies: only cases with at least one tx, mainnet first. Testnet ones carry the "Testnet rehearsal" label. */
export function CaseStudyList({ cases = CASE_STUDIES }: { cases?: readonly CaseStudy[] }) {
  return (
    <ol className="docs-cards" data-testid="hack-cases">
      {orderedCases(cases).map((c) => (
        <li key={c.id} className="docs-card" data-testid={`case-${c.id}`} data-network={c.network}>
          <h3>{c.title}</h3>
          <p>
            <span className="docs-tag" data-status={c.network === "testnet" ? "rehearsal" : "proven"}>{caseLabel(c)}</span>
            <span className="muted small"> {c.date}{c.betIds.length > 0 && <> · bet {c.betIds.map((b) => `#${b}`).join(", ")}</>}{c.stake && <> · {c.stake}</>} · outcome {c.outcome}</span>
          </p>
          <p><strong>What happened.</strong> {c.happened}</p>
          <p><strong>What it proves.</strong> {c.proves}</p>
          <TxList network={c.network} txs={c.txs} />
        </li>
      ))}
    </ol>
  );
}

/** The mainnet deployment: every account, from lib/mainnetAccounts.json (test-checked against the release args and Workers' config). */
export const STATUS_ROWS: { id: string; part: string; account: React.ReactNode; note: React.ReactNode }[] = [
  { id: "escrow", part: "Escrow contract", account: acct(MAINNET.escrow), note: <>Deployed (<Ext href={txUrl("mainnet", TX.deploy.hash)}>deploy tx</Ext>) and locked (<Ext href={txUrl("mainnet", TX.deleteKey.hash)}>key deleted</Ext>). Code sha256 <code>{ESCROW_RELEASE.sha256.slice(0, 8)}…</code> = the reproducible build. Bets so far: {MAINNET_STATUS.betCount}.</> },
  { id: "guardian", part: "Guardian and fee account", account: acct(ACCOUNTS.guardian), note: <>Can {GUARDIAN_POWERS}. Receives the 1% fee and the storage charges.</> },
  { id: "operator", part: "Operator", account: acct(ACCOUNTS.operator), note: <>The escrow's operator: it {OPERATOR_POWERS}. Nothing else.</> },
  { id: "judge", part: "AI judge program on OutLayer", account: acct(ACCOUNTS.outlayer), note: <>Fingerprint <code>{RESOLVER_WASM_HASH.slice(0, 8)}…</code>, uploaded by {acct(ACCOUNTS.wasmUploader)}. Models from NEAR AI Cloud, API key held for the program by {acct(ACCOUNTS.aiKeyOwner)}. Model pairs: {LAUNCH_JUDGE_CHAIN.map((p) => `${p.model_a} + ${p.model_b}`).join("; ")}.</> },
  { id: "attest", part: "Source check signer", account: acct(ACCOUNTS.attestSigner), note: "Runs the judge program in source-check mode; the escrow opens a bet only with its signature." },
  { id: "keeper", part: "Keeper", account: acct(ACCOUNTS.keeper), note: "Asks for rulings and payouts on time. It can't decide anything, and anyone can make the same calls." },
  { id: "relayer", part: "Relayer", account: acct(ACCOUNTS.relayer), note: "Pays the network fee for transactions you signed. It can't move money." },
  { id: "intents", part: "NEAR Intents balance", account: acct(MAINNET.intents), note: <>Bet tokens: {MAIN_SYMBOLS.join(", ")}. Minimum stake {MIN_STAKE_USD} per side, no maximum stake per side. Fee 1% per side, at least {MIN_FEE_USD}, only when a bet has a winner.</> },
  { id: "funding", part: "1Click add money, cash out, convert", account: "1Click", note: "Switched on in the mainnet site." },
  { id: "registry", part: "Usernames", account: <code>{MAINNET.registryId}</code>, note: "A Cloudflare Worker keeps usernames; this is the name their signatures are made out to. The escrow stores it but never calls it, and no contract is deployed at that name." },
  { id: "web", part: "Web app", account: "Cloudflare", note: <>Deployed, unlisted while in beta. Demo: {TODO.demoUrl}.</> },
];

export const BUILT: { id: string; text: string }[] = [
  { id: "escrow", text: "Escrow contract (Rust, contracts/escrow): make, take, cancel, AI or person ruling, two challenge rounds, payouts, refunds, pause and shutdown." },
  { id: "judge", text: "Judge program (Rust to WebAssembly, resolver/): reads the named pages or data feeds, asks two models (custom bets) or one checking model (data-feed bets), checks quotes, decides in code, signs." },
  { id: "web", text: "Web app (React, apps/web): email login, six bet types (price at a time, hits a price, which outperforms, who wins a game, daily high temperature, any web page), a person as referee, challenges, Verify screens, Account and funding." },
  { id: "services", text: "Services (Cloudflare Workers, services/workers): relayer (pays network fees), keeper (asks for rulings and payouts on time), source check, indexer, usernames, 1Click funding." },
  { id: "verifier", text: "Verifiers: services/verifier (checks E1 to E4, B1 to B6 in docs/VERIFY.md) and scripts/verify-bet.mjs (no dependencies)." },
  { id: "tests", text: "Tests: ./test.sh fast runs the contract, judge, services and web unit tests, mocked browser tests, a visual gate, and recorded red-team replays." },
];

export const PLANNED: { id: string; text: string }[] = [
  { id: "mainnet-run", text: "More mainnet runs: the hackathon bet's ruling (after 25 November), and a challenged, refereed or refunded bet on mainnet, which turn the remaining In progress cards above into proof." },
  { id: "repo", text: "A public repository address (see below)." },
  { id: "replay", text: "Publish the page text each ruling read, and a tool to re-run the judge on it." },
  { id: "attest", text: "Check the OutLayer run's attestation." },
  { id: "bonds", text: "Check challenge bonds in the verifier." },
  { id: "audit", text: "An external security audit." },
];

export const KNOWN_LIMITS: string[] = [
  "Early, unaudited code. Bets use real money on mainnet; only bet what you can afford to lose.",
  `One mainnet bet has settled so far (bet_count ${MAINNET_STATUS.betCount} on ${MAINNET_STATUS.checkedAt}: bet 1 settled, bet 2 awaits its ruling). Challenges, referee rulings and refunds have run on the testnet escrow so far; those cards are marked In progress above.`,
  "The judge relies on OutLayer's TEE and NEAR AI Cloud; see Trust and verification for what that means.",
  "AI models are not fully deterministic; a re-run can differ. Quotes, code decisions, a second model or a code check, and challenges are the safeguards.",
  `No maximum stake per side at launch; the minimum is ${MIN_STAKE_USD} per side (each token's minimum is set to about that value) and the fee is 1% per side, at least ${MIN_FEE_USD}.`,
  "The site is unlisted while in beta.",
];

export default function HackathonPage() {
  return (
    <DocsFrame page="hackathon">
      <h1>Hackathon</h1>
      <p className="docs-lede">Praetorial runs on NEAR mainnet: the escrow {acct(MAINNET.escrow)} is deployed and locked. It is entered in the <Ext href="https://nearhackathon.com">NEAR hackathon</Ext>. Below: what we built, what has already run on mainnet (with its transactions), what is still to run, and the testnet rehearsals that came first.</p>
      <p data-testid="hack-bets">Mainnet bet 1, on Bitcoin's price at a set time, was ruled NO and settled; bet 2, the hackathon bet, is taken and awaiting its ruling. In all, {settledLine("text")} Every one, with its transactions, is in docs/BETS.md in the repository.</p>
      <p className="muted small" data-testid="hack-bet-count">Mainnet bets so far: {MAINNET_STATUS.betCount} (escrow <code>bet_count</code>, block {MAINNET_STATUS.blockText}, {MAINNET_STATUS.checkedAt}). A claim shows "Proven on mainnet" only with a mainnet transaction or bet id you can open on nearblocks.io.</p>

      <h2 id="achievements">Technical achievements</h2>
      <AchievementCards />

      <h2 id="case-studies">Case studies</h2>
      <p>Before launch we rehearsed on the NEAR test network with test money. Each case below links its testnet transactions. They show how the system behaved, including failures, not that mainnet works. The mainnet bets are in the cards above.</p>
      <CaseStudyList />

      <h2 id="status">The mainnet deployment</h2>
      <table className="docs-table" data-testid="hack-status">
        <thead><tr><th scope="col">Part</th><th scope="col">Account</th><th scope="col">Status</th><th scope="col">Notes</th></tr></thead>
        <tbody>
          {STATUS_ROWS.map((r) => (
            <tr key={r.id} data-testid={`hack-status-${r.id}`}>
              <th scope="row" data-label="Part">{r.part}</th>
              <td data-label="Account">{r.account}</td>
              <td data-label="Status"><Tag s="mainnet" /></td>
              <td data-label="Notes">{r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Checked on 12 November 2026 against the release config and the chain. "Mainnet" means deployed and switched on; what has carried real money is in the cards above.</p>

      <h2 id="built">Built, and planned</h2>
      <h3>Built</h3>
      <ul className="facts" data-testid="hack-built">{BUILT.map((b) => <li key={b.id}>{b.text}</li>)}</ul>
      <h3>Planned</h3>
      <ul className="facts" data-testid="hack-planned">{PLANNED.map((p) => <li key={p.id}>{p.text}</li>)}</ul>

      <h2 id="rules">The rules and tracks</h2>
      <ul className="facts" data-testid="hack-rules">
        <li>Development runs 1 to 14 November 2026; submissions close 14 November, 23:59 UTC.</li>
        <li>A submission needs both a public repository and a public demo post on X (video or screenshots) that says it was built at the NEAR hackathon and tags @NEARProtocol and #NEARHackathon.</li>
        <li>Projects are screened by Claude Code and Codex, which check that the project runs and does what its README says.</li>
        <li>The site lists no official judging criteria; as a guide it names what past NEAR hackathons judged: technical implementation, design, impact, originality and sustainability.</li>
        <li>Tracks entered: Unstoppable DeFi (NEAR Intents and a locked escrow: cards g and c), Privacy &amp; Private AI (the judge in a TEE: cards a, b and h), Real-World Money (email login, no gas, stablecoins: card g), Open Innovation.</li>
      </ul>
      <p className="muted small">Summarised from nearhackathon.com on 12 November 2026. The site is the authority.</p>

      <h2 id="source">Source and license</h2>
      <ul className="facts" data-testid="hack-source">
        <li><strong>Repository.</strong> {TODO.repoUrl}</li>
        <li><strong>License.</strong> MIT (the LICENSE file at the repository root).</li>
        <li><strong>Public sources only.</strong> Built from public sources only: public docs, public APIs and public chain data.</li>
      </ul>

      <h2 id="run">Run it locally</h2>
      <p>You need Node and npm (checked with Node 26). From the repository root:</p>
      <Cmd id="web-install" />
      <Cmd id="web-dev" />
      <p>Open <code>http://localhost:3000/docs</code>. The dev server uses the NEAR test network, so you can try bets with test money; pages that need an account ask you to log in with an email code. Tests (no network, no secrets):</p>
      <Cmd id="web-unit" />
      <Cmd id="web-e2e-docs" />
      <p>The whole suite runs from the repository root. It also needs Rust (cargo) and Python 3 with the judge prototype's packages, and takes several minutes:</p>
      <Cmd id="test-fast" />

      <h2 id="demo">Demo</h2>
      <p>{TODO.demoUrl}. To check a bet yourself without our site, follow <DocLink to="/docs/trust">Trust and verification</DocLink>.</p>

      <h2 id="team">Team</h2>
      <p data-testid="hack-team">{TODO.team}</p>

      <h2 id="limits">Known limits</h2>
      <ul className="facts" data-testid="hack-limits">{KNOWN_LIMITS.map((l) => <li key={l}>{l}</li>)}</ul>
    </DocsFrame>
  );
}
