// K0 (UIR1 §2.3, familiarcow UX-37 #10): the /kit playground. Every kit component, every card variant and every bet state from
// tests/fixtures/bets.ts, drawn from the same lib/betView.ts model the screens will use. Compiled only into VITE_KIT=1 builds
// (lib/kitBuild.ts; never a mainnet bundle: tests/kitBundle.unit.test.ts, scripts/mainnetDeployGuard.ts). Fixtures only: the kit
// entry (src/kit/kitEntry.tsx) refuses every network request, nothing is signed or sent.
import React, { useMemo, useState } from "react";
import { betView, changeToast, person, PILL_WORDS, type BetView, type PillId } from "../../lib/betView";
import { money } from "../../lib/money";
import { betFixtures, fixtureByKey, ANON, ME, NAMES, DAY, HOUR, FIXTURE_CONTRACT, PLAY_PEOPLE, WNEAR, LEGACY } from "../../tests/fixtures/bets";
import { betDetail, type BetDetail } from "../../lib/betDetail";
import { releasePins } from "../../lib/releaseConfig";
import type { Bet } from "../../lib/escrowAdapter";
import realBet1 from "../../tests/fixtures/real-bet-testnet-1.json";
import realBet35 from "../../tests/fixtures/real-bet-testnet-35.json";
import {
  ActionBar, ActionCard, ActivityList, Amount, AssetLogo, BetCard, BetHeader, ConfirmSheet, DeciderChip, Disclosure, EmptyState,
  KeyValue, MoreActions, Notice, PayoutCard, ReviewSummary, RulingCard, StatusPill, TimeLeft, UserChip, useToast, DetailsCard, type DetailSection,
} from "./index";
import { Button } from "../ui";
import { VerifySheet, VerifyRow, ActionReceipt } from "./verify";
import { judgeVerify, withReceipts, type VerifyCtx, type VerifyItemData, type ActionReceiptData } from "../../lib/verify";
import type { BetTx, ChainFacts } from "../../lib/betTxs";
import bet49 from "../../tests/fixtures/v1/bet49-testnet.json";

export const KIT_MARKER = "praetorial-kit-playground";
const CONTRACT = FIXTURE_CONTRACT;
const SYMBOLS = ["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"];

/** B1: the release pins the Details card names (resolver wasm hash, judge models). */
export function kitRelease(): { resolverWasmHash: string; models: string[] } | null {
  try { const p = releasePins(); return { resolverWasmHash: p.resolver_wasm_hash, models: p.models }; } catch { return null; }
}
export const kitDetail = (bet: Bet): BetDetail => betDetail(bet, { names: NAMES, release: kitRelease(), contractId: CONTRACT });
/** B1: real bets read from the testnet escrow (get_bet, read-only), shown with every Details section. */
export const REAL_BETS: Array<{ key: string; label: string; bet: Bet; contract: string }> = [
  { key: "real-1", label: "Real bet #1 (testnet): custom claim, AI judge, voided", bet: realBet1.bet as unknown as Bet, contract: realBet1.contract_id },
  { key: "real-35", label: "Real bet #35 (testnet): NBA game winner template, code + AI audit", bet: realBet35.bet as unknown as Bet, contract: realBet35.contract_id },
];

function useViews(now: number) {
  return useMemo(() => betFixtures(now).map((f) => ({ f, v: betView(f.bet, f.me, now, { names: NAMES, pending: f.pending ?? null, shutdown: f.shutdown, contractId: CONTRACT }), d: kitDetail(f.bet) })), [now]);
}
/** `?details=all` or `?details=terms,sources` opens Details sections (shots); default all closed. */
function detailsOpen(): DetailSection[] | "all" {
  const q = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("details") : null;
  return q === "all" ? "all" : q ? (q.split(",") as DetailSection[]) : [];
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return <section id={id} className="k-stack" data-testid={`kit-section-${id}`}><h2>{title}</h2>{children}</section>;
}
function Item({ name, children }: { name: string; children: React.ReactNode }) {
  return <div className="k-stack" data-testid={`kit-item-${name}`}><p className="k-play__caption">{name}</p>{children}</div>;
}

function Blocks({ now }: { now: number }) {
  const toast = useToast();
  const amounts: Array<[string, string, boolean?]> = [
    ["USDC", "39300000"], ["USDT", "1234567891000"], ["USDC", "4000"], ["NEAR", "10000000000000000000000000"], ["NEAR", "1654", true],
    ["BTC", "39600"], ["BTC", "12345678"], ["ETH", "1000000000000000001"], ["ZEC", "250000000"],
  ];
  return (
    <Section id="blocks" title="Building blocks">
      <div className="k-play__grid">
        <Item name="Amount (hover for the exact value)">
          <KeyValue rows={amounts.map(([s, u, minor], i) => ({ id: `a${i}`, label: `${u} ${s}${minor ? " (fee)" : ""}`, value: <Amount money={money(u, s)} logo minor={minor} /> }))} />
          <Amount money={money("198000000", "USDC")} size="lg" logo />
        </Item>
        <Item name="AssetLogo"><span className="k-row">{SYMBOLS.map((s) => <span key={s} className="k-row"><AssetLogo symbol={s} size="1.6em" />{s}</span>)}<AssetLogo symbol="DOGE" size="1.6em" /></span></Item>
        <Item name="UserChip: you / named / short id / named account">
          <span className="k-stack">
            <UserChip person={person(ME, ME, NAMES)} />
            <UserChip person={person(PLAY_PEOPLE.named, ME, NAMES)} />
            <UserChip person={person(ANON, ME, NAMES)} />
            <UserChip person={person(PLAY_PEOPLE.noName, ME, NAMES)} />
            <UserChip person={person(LEGACY, ME, NAMES)} />
          </span>
        </Item>
        <Item name="DeciderChip">
          <span className="k-stack">
            <DeciderChip decider={{ kind: "ai" }} />
            <DeciderChip decider={{ kind: "person", who: person(PLAY_PEOPLE.referee, ME, NAMES) }} />
            <DeciderChip decider={{ kind: "person", who: person(ME, ME, NAMES) }} />
          </span>
        </Item>
        <Item name="StatusPill (every wording in lib/betView.ts PILL_WORDS)">
          <span className="k-row">{(Object.keys(PILL_WORDS) as PillId[]).map((id) => <StatusPill key={id} pill={{ id, ...PILL_WORDS[id] }} />)}</span>
        </Item>
        <Item name="TimeLeft (tap for exact local + UTC)">
          <span className="k-stack">
            <TimeLeft at={now + 6 * DAY + HOUR} label="Closes" past="Closed" />
            <TimeLeft at={now + 18 * HOUR + 5 * 60_000} label="Final" />
            <TimeLeft at={now + 25 * 60_000} label="Final" />
            <TimeLeft at={now - 2 * DAY} label="Closes" past="Closed" />
          </span>
        </Item>
        <Item name="Disclosure">
          <Disclosure title="More options" summary="Closes in 7 days · anyone can take · 24h to challenge"><p>Collapsed content.</p></Disclosure>
          <Disclosure title="Open by default" summary="summary" defaultOpen><p>Shown.</p></Disclosure>
        </Item>
        <Item name="KeyValue (total)">
          <KeyValue variant="total" rows={[
            { id: "s", label: "Your stake", value: <Amount money={money("40000000", "USDC")} /> },
            { id: "st", label: "Network storage", value: <Amount money={money("1654", "USDC")} minor /> },
            { id: "t", label: "You pay now", value: <Amount money={money("40001654", "USDC")} />, emphasis: true },
          ]} />
        </Item>
        <Item name="ActionBar"><ActionBar primary={{ id: "take", label: "Take this bet", kind: "primary" }} secondary={[{ id: "duplicate", label: "Duplicate", kind: "neutral" }, { id: "concede", label: "Concede", kind: "danger" }]} /></Item>
        <Item name="Notice">
          <Notice tone="info" title="Paused for maintenance" body="You can still look at your bets." />
          <Notice tone="warn" title="You're offline" body="Amounts may be out of date." />
          <Notice tone="bad" title="We can't load your bets" action={<Button>Retry</Button>} />
          <Notice tone="good" title="Moved to betting" />
          <Notice tone="warn" variant="page" title="This page is out of date" body="Reload to get the latest version." action={<Button variant="primary">Reload</Button>} />
        </Item>
        <Item name="EmptyState">
          <EmptyState title="No bets yet" body="Make one, or take one from Explore." action={<Button variant="primary">Create bet</Button>} />
          <EmptyState title="We can't find bet #999" action={<a href="/">Home</a>} />
        </Item>
        <Item name="Toast"><Button data-testid="kit-toast" onClick={() => toast({ tone: "success", text: "Link copied." })}>Show a toast</Button></Item>
      </div>
    </Section>
  );
}

function Cards({ views }: { views: Array<{ f: { key: string }; v: BetView }> }) {
  const by = (k: string) => views.find((x) => x.f.key === k)!.v;
  const mine = views.filter((x) => (x.v.role === "maker" || x.v.role === "taker") && !["settled", "refunded", "cancelled", "expired"].includes(x.v.phase));
  const done = views.filter((x) => ["settled", "refunded", "cancelled", "expired"].includes(x.v.phase));
  return (
    <Section id="cards" title="Bet cards">
      <h3>mine (My Bets)</h3>
      <div className="k-play__grid">{mine.map(({ f, v }) => <BetCard key={f.key} view={v} variant="mine" onOpen={() => undefined} />)}</div>
      <h3>offer (Explore)</h3>
      <div className="k-play__grid"><BetCard view={by("open-theirs")} variant="offer" onOpen={() => undefined} /><BetCard view={by("no-terms")} variant="offer" onOpen={() => undefined} /></div>
      <h3>public (In progress, someone else's bet)</h3>
      <div className="k-play__grid">{["live", "judging", "ruling-lost", "challenged"].map((k) => { const f = fixtureByKey(Date.now(), k); const v = betView(f.bet, PLAY_PEOPLE.outsider, Date.now(), { names: NAMES, contractId: CONTRACT }); return <BetCard key={k} view={v} variant="public" onOpen={() => undefined} />; })}</div>
      <h3>decide (Bets you decide)</h3>
      <div className="k-play__grid"><BetCard view={by("referee-ready")} variant="decide" onOpen={() => undefined} /></div>
      <h3>compact (Settled, collapsed history)</h3>
      <div className="k-stack" style={{ maxWidth: 560 }}>{done.map(({ f, v }) => <BetCard key={f.key} view={v} variant="compact" onOpen={() => undefined} />)}</div>
    </Section>
  );
}

export function BetPageState({ f, v, d, open = [] }: { f: { key: string; label: string; id: number }; v: BetView; d: BetDetail; open?: DetailSection[] | "all" }) {
  return (
    <article id={`state-${f.key}`} className="k-play__state" data-testid={`kit-state-${f.key}`} data-phase={v.phase}>
      <p className="k-play__caption">{f.label} · <code>{f.key}</code> · phase <code>{v.phase}</code> · bet {f.id}</p>
      <div className="k-play__page">
        <div className="k-stack">
          <BetHeader view={v} />
          {(v.primary || !v.payout) && <ActionCard view={v} />}
          {v.ruling && <RulingCard ruling={v.ruling} />}
        </div>
        <div className="k-stack">
          {v.payout && <PayoutCard payout={v.payout} onRetry={() => undefined} />}
          <MoreActions view={v} />
          <ActivityList entries={v.activity} />
          <DetailsCard detail={d} contractId={CONTRACT} open={open} />
        </div>
      </div>
    </article>
  );
}

function Sheets({ views, now }: { views: Array<{ f: { key: string }; v: BetView }>; now: number }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const by = (k: string) => views.find((x) => x.f.key === k)!.v;
  const offer = by("open-theirs");
  const [live, setLive] = useState<BetView>(by("ruling-lost"));
  const simulate = () => {
    const f = fixtureByKey(now, "ruling-lost");
    const next = betView({ ...f.bet, status: "Challenged", bonds: [{ holder: ME, amount: "2000000000000000000000000", round: 1, pre_challenge_outcome: "YES", asset: WNEAR }] }, ME, now, { names: NAMES, contractId: CONTRACT });
    const t = changeToast(live, next);
    if (t) toast({ tone: "info", text: t });
    setLive(next);
  };
  return (
    <Section id="sheets" title="Confirm sheets and review">
      <div className="k-play__grid">
        <Item name="ReviewSummary (take)"><ReviewSummary view={offer} variant="take" /></Item>
        <Item name="ConfirmSheet: take (one step)">
          <ConfirmSheet inline title="Take this bet" confirmLabel="Take bet" onConfirm={() => undefined} onCancel={() => undefined}
            rows={[{ id: "pay", label: "You pay now", value: <Amount money={offer.taker.stake} logo />, emphasis: true }, { id: "win", label: "You win", value: <Amount money={offer.maker.stake} logo /> }, { id: "st", label: "Network storage", value: <Amount money={money("1654", "USDC")} minor /> }]}
            risk="The fee (1%) is taken only if someone wins." />
        </Item>
        <Item name="ConfirmSheet: challenge">
          <ConfirmSheet inline title="Challenge the ruling" confirmLabel="Post bond & challenge" onConfirm={() => undefined} onCancel={() => undefined}
            rows={[{ id: "bond", label: "Bond", value: <Amount money={money("2000000000000000000000000", "NEAR")} logo />, emphasis: true }]}
            risk="You get the bond back if the AI changes its ruling." />
        </Item>
        <Item name="ConfirmSheet: concede (danger)">
          <ConfirmSheet inline danger title="Concede this bet?" confirmLabel="Concede" onConfirm={() => undefined} onCancel={() => undefined}
            rows={[{ id: "paid", label: "@carol is paid", value: <Amount money={money("59000000", "USDC")} />, emphasis: true }]}
            risk="Your side loses now. This can't be undone." />
        </Item>
        <Item name="ConfirmSheet: as a real sheet">
          <Button data-testid="kit-open-sheet" onClick={() => setOpen(true)}>Open the take sheet</Button>
          <ConfirmSheet open={open} title="Take this bet" confirmLabel="Take bet" onConfirm={() => setOpen(false)} onCancel={() => setOpen(false)}
            rows={[{ id: "pay", label: "You pay now", value: <Amount money={offer.taker.stake} logo />, emphasis: true }]} risk="Nothing is sent from the playground." />
        </Item>
        <Item name="Toast on a live change (replaces the Notifications panel)">
          <span className="k-row"><StatusPill pill={live.pill} /><Button data-testid="kit-live-change" onClick={simulate}>Simulate: someone challenges</Button></span>
        </Item>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- V1 Verify (real testnet bet 49 + its real indexed transactions)
const V49_BET = JSON.parse(bet49.get_bet_text) as Bet;
const V49_TXS = bet49.txs as unknown as BetTx[];
const V49_NAMES: Record<string, string> = { "979f2614c265b2dfacbde2628b66979c26afac83ba2f98f826a010aaab8eba7d": "maya", "371f9add3a51c946173fafd90dac5c6a0da149bf7f4ddc03f3b5fe6268bc0488": "theo" };
const V49_CTX: VerifyCtx = { network: "testnet", contractId: bet49.escrow, names: V49_NAMES, feeAccount: bet49.fee_account };
const V49_FACTS: ChainFacts = {
  outcomeKey: bet49.resolver_keys[0], attestKey: bet49.resolver_keys[1], wasmHash: bet49.resolver_keys[2], wasmBaseUrl: bet49.outlayer_config.wasm_base_url,
  codeHashB58: bet49.code_hash_b58, accessKeys: 0, betText: bet49.get_bet_text, judgeChain: null,
};
const V49_RELEASE = { resolverWasmHash: bet49.resolver_keys[2], models: ["deepseek-ai/DeepSeek-V4.1-Flash-1017", "z-ai/glm-5.3-flash"] };
const V49_DETAIL = betDetail(V49_BET, { names: V49_NAMES, release: V49_RELEASE, contractId: bet49.escrow });
const REFEREE = "bd647fa44695487cedebee20d528d41d76739a6e0d718cfe432cb41b898851a4";

/** Every state of the Verify views, from real data where it exists. Exported for the kit render tests. */
export function verifyStates(now: number) {
  const sheet = (txs: BetTx[] | null | undefined, facts: ChainFacts | null | undefined, bet: Bet = V49_BET, release = V49_RELEASE, names: Record<string, string> = V49_NAMES) =>
    judgeVerify({ bet, detail: betDetail(bet, { names, release, contractId: bet49.escrow }), txs, facts, release, ctx: { ...V49_CTX, names } });
  const refBet = { ...V49_BET, last_resolution_raw: null, envelope: { ...V49_BET.envelope, referee: { account: REFEREE, mode: "Human" } } } as unknown as Bet;
  const refTx: BetTx = { bet_id: 49, hash: "3BH5nqcibwvfpTjMHi8L81AiGohvGnRPzFZCmMVqVq4b", at_ns: "1794445712490887086", kind: "referee-rule", method: "referee_rule", signer: V49_TXS.find((t) => t.kind === "challenge")!.signer, actor: REFEREE, ok: true, moved_in: [], moved_out: [], outcome: "YES" };
  const pending = { ...V49_BET, status: "Resolving", outcome: null, proposed_at: null, last_resolution_raw: null, all_results: [] } as unknown as Bet;
  const sheets: Array<{ key: string; label: string; data: ReturnType<typeof judgeVerify> }> = [
    { key: "ai", label: "AI judge, ruled and accepted (real testnet bet 49)", data: sheet(V49_TXS, V49_FACTS) },
    { key: "loading", label: "Loading (tx list and chain read pending)", data: sheet(undefined, undefined) },
    { key: "gaps", label: "Indexer and RPC unavailable: gaps listed, nothing invented", data: sheet(null, null) },
    { key: "mismatch", label: "Something doesn't match (wrong key / other program)", data: sheet(V49_TXS, { ...V49_FACTS, outcomeKey: V49_FACTS.attestKey }, V49_BET, { ...V49_RELEASE, resolverWasmHash: "00".repeat(32) }) },
    { key: "no-ruling", label: "Not judged yet", data: sheet([], V49_FACTS, pending) },
    { key: "referee", label: "A person decides (referee)", data: sheet([refTx], V49_FACTS, refBet, V49_RELEASE, { ...V49_NAMES, [REFEREE]: "rita" }) },
  ];
  const view = betView(V49_BET, null, now, { names: V49_NAMES, contractId: bet49.escrow });
  const entries = withReceipts(view.activity, V49_TXS, V49_CTX);
  const pick = (re: RegExp) => entries.find((e) => re.test(e.text))!.receipt;
  const refused: ActionReceiptData = { ...pick(/took it/), entryId: "refused", txs: [{ ...pick(/took it/).txs[0], ok: false, moved: [] }], note: "" };
  const receipts: Array<{ key: string; label: string; r: ActionReceiptData }> = [
    { key: "made", label: "Made: stake into the escrow", r: pick(/made this bet/) },
    { key: "relayed", label: "Relayed: signed and paid by the relayer for @theo", r: pick(/challenged/) },
    { key: "paid", label: "Paid out: winner, keeper run cost and fee", r: pick(/^Paid out/) },
    { key: "repeated", label: "Repeated keeper requests (one row, every tx)", r: pick(/\(9 times\)/) },
    { key: "refused", label: "Refused by the escrow", r: refused },
    { key: "loading", label: "Loading", r: { entryId: "loading", title: "", state: "loading", txs: [], note: "Loading the transaction…", escrowHref: entries[0].receipt.escrowHref } },
    { key: "missing", label: "Not indexed yet", r: { entryId: "missing", title: "", state: "missing", txs: [], note: "No transaction found for this yet. It can take a few minutes to be indexed.", escrowHref: entries[0].receipt.escrowHref } },
    { key: "unavailable", label: "Indexer unavailable", r: { entryId: "unavailable", title: "", state: "unavailable", txs: [], note: "The transaction list isn't available right now. Every transaction is on the escrow's NearBlocks page.", escrowHref: entries[0].receipt.escrowHref } },
  ];
  const rows: Array<{ key: string; item: VerifyItemData }> = [
    { key: "hash-ok", item: { id: "hash-ok", label: "Terms hash", value: V49_BET.envelope.terms_hash, valueKind: "hash", how: "Stored in the escrow with the bet.", status: "ok", statusText: "Matches the terms (checked in your browser)" } },
    { key: "bad", item: { id: "bad", label: "Signature (ed25519)", value: "ab".repeat(64), valueKind: "hash", how: "Valid only for this exact result.", status: "bad", statusText: "Does NOT check out against the escrow's key" } },
    { key: "person-link-cmd", item: { id: "person-link-cmd", label: "The run (request transaction)", value: "9SbiLsizpBHSGnnragbY5Z8porbzpnZtWggaYfKPLG6j", valueKind: "hash", person: { label: "@theo", account: "371f9add3a51c946173fafd90dac5c6a0da149bf7f4ddc03f3b5fe6268bc0488" }, link: { href: "https://testnet.nearblocks.io/txns/9SbiLsizpBHSGnnragbY5Z8porbzpnZtWggaYfKPLG6j", text: "Open on NearBlocks" }, how: "Its logs show OutLayer's execution_requested event.", command: "node verify-bet.mjs 49 --network testnet", status: "ok" } },
    { key: "text-info", item: { id: "text-info", label: "AI models", value: V49_RELEASE.models.join(", "), valueKind: "text", how: "As recorded in this bet's ruling.", status: "info" } },
    { key: "block", item: { id: "block", label: "The bet's terms (exact text)", value: V49_BET.envelope.terms ?? "", valueKind: "block", how: "The terms hash is the sha256 of exactly this text." } },
    { key: "missing", item: { id: "missing", label: "Accepted by the escrow", value: null, how: "The transaction list isn't available right now.", link: { href: "https://testnet.nearblocks.io/address/x", text: "The escrow's transactions on NearBlocks" }, status: "missing" } },
  ];
  return { sheets, receipts, rows, entries };
}

function VerifyKit({ now }: { now: number }) {
  const [open, setOpen] = useState(false);
  const v = useMemo(() => verifyStates(now), [now]);
  const only = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("verify") : null;
  return (
    <Section id="verify" title="Verify (V1): sheets, rows, receipts">
      <div className="k-play__grid">
        {v.sheets.filter((s) => !only || only === s.key).map((s) => (
          <Item key={s.key} name={`VerifySheet: ${s.label}`}><div data-testid={`kit-verify-sheet-${s.key}`}><VerifySheet inline data={s.data} onClose={() => undefined} onDownload={() => undefined} /></div></Item>
        ))}
      </div>
      {!only && (
        <>
          <div className="k-play__grid">
            {v.rows.map((r) => <Item key={r.key} name={`VerifyRow: ${r.key}`}><div className="k-card" data-raw-ids="allowed"><VerifyRow item={r.item} /></div></Item>)}
          </div>
          <div className="k-play__grid">
            {v.receipts.map((r) => <Item key={r.key} name={`ActionReceipt: ${r.label}`}><ActionReceipt receipt={r.r} /></Item>)}
          </div>
          <Item name="Activity with Verify on every row (real bet 49)"><ActivityList entries={v.entries} defaultOpen /></Item>
          <Item name="VerifySheet as a real sheet">
            <Button data-testid="kit-open-verify" onClick={() => setOpen(true)}>Open the AI judge's Verify sheet</Button>
            <VerifySheet open={open} data={v.sheets[0].data} onClose={() => setOpen(false)} onDownload={() => undefined} />
          </Item>
        </>
      )}
    </Section>
  );
}

export default function Playground() {
  const [now] = useState(() => Date.now());
  const views = useViews(now);
  const only = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("state") : null;
  const states = only === "verify" ? [] : only ? views.filter((x) => x.f.key === only) : views;
  const open = detailsOpen();
  return (
    <main className="k-play" data-testid={KIT_MARKER}>
      <header className="k-stack">
        <h1 style={{ margin: 0 }}>Praetorial UI kit</h1>
        <p className="k-play__banner">Preview with made-up bets. Nothing here is real money; the page blocks every network request.</p>
        <nav className="k-play__nav" aria-label="Kit sections">
          <a href="#blocks">Building blocks</a><a href="#cards">Bet cards</a><a href="#states">Bet page, every state</a><a href="#real">Details on real bets</a><a href="#sheets">Confirm sheets</a><a href="#verify">Verify</a>
          <a href="?details=all#states">Open every Details section</a>
          {views.map(({ f }) => <a key={f.key} href={`?state=${f.key}#states`}>{f.key}</a>)}
        </nav>
      </header>
      {!only && <Blocks now={now} />}
      {!only && <Cards views={views} />}
      <Section id="states" title={`Bet page, every state (${states.length})`}>
        {states.map(({ f, v, d }) => <BetPageState key={f.key} f={f} v={v} d={d} open={open} />)}
      </Section>
      {(!only || only.startsWith("real-")) && (
        <Section id="real" title="Details on real bets (read from the testnet escrow)">
          {REAL_BETS.filter((r) => !only || r.key === only).map((r) => (
            <article key={r.key} className="k-play__state" data-testid={`kit-state-${r.key}`}>
              <p className="k-play__caption">{r.label}</p>
              <DetailsCard detail={betDetail(r.bet, { names: {}, release: kitRelease(), contractId: r.contract })} contractId={r.contract} open={open} />
            </article>
          ))}
        </Section>
      )}
      {!only && <Sheets views={views} now={now} />}
      {(!only || only === "verify") && <VerifyKit now={now} />}
    </main>
  );
}
