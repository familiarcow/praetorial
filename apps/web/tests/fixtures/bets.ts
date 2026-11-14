// K0 (UIR1 §2.3): the bet lifecycle catalogue, one fixture per state the UI must draw. Moved from spikes/uir1/shots.spec.ts `BETS`
// and extended with the states that spike could not reach (referee ready, stuck Resolving, runs exhausted, shut down, ruling won).
// Used by tests/kit.unit.test.ts (lib/betView.ts per state) and the /kit playground (src/kit/Playground.tsx). Pure data: no network.
import type { Bet } from "../../lib/escrowAdapter";
import type { PayoutLine } from "../../lib/payoutScreen";

export const ME = "11".repeat(32);
/** An implicit account with no username: the UI must show "a1b2…f9e0", never the 64 hex. */
export const ANON = `a1b2${"c".repeat(56)}f9e0`;
export const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const NEAR = "nep141:wrap.near";
export const BTC = "nep141:btc.omft.near";
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
const ns = (ms: number) => ms * 1_000_000;
export const usdc = (n: number) => String(Math.round(n * 1e6));
export const near = (n: number) => (BigInt(Math.round(n * 1e6)) * 10n ** 18n).toString();

/** Usernames the registry would return (ME is "familiarcow"; ANON and judge.near have none). */
/** The escrow id the fixtures pretend to live on (phaseOf checks a stored result is for this contract). */
export const FIXTURE_CONTRACT = "bets.praetorial.near";
/** Extra people for the /kit playground's chips: someone with a username, a named account without one, an outsider. */
export const PLAY_PEOPLE = { named: "bob.near", noName: "judge.near", referee: "kim.near", outsider: "zed.near" };
export const WNEAR = NEAR;

export const NAMES: Record<string, string> = {
  [ME]: "familiarcow", "alice.near": "alice", "bob.near": "bob", "carol.near": "carol", "dave.near": "dave", "erin.near": "erin",
  "frank.near": "frank", "gina.near": "gina", "hal.near": "hal", "kim.near": "kim", "ivy.near": "ivy", "jon.near": "jon", "kai.near": "kai",
  "lee.near": "lee",
};
/** B1: the ONE legacy fallback: a referee account with no username (shown "Unnamed account", never the raw id). */
export const LEGACY = `9f3c${"d".repeat(56)}77ab`;

const SOURCES = [
  { id: "S_CB", publisher: "Coinbase BTC-USD", url: "https://www.coinbase.com/price/bitcoin" },
  { id: "S_REUTERS", publisher: "Reuters", url: "https://www.reuters.com/markets/currencies/" },
  { id: "S_CG", publisher: "CoinGecko", url: "https://www.coingecko.com/en/coins/bitcoin/historical_data" },
];
/** B1: a custom sheet shaped like the ones the create form signs (lib/customSheet.ts: claim, elements, clauses, time, sources). */
export function customTerms(claim: string, eventMs: number): string {
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  return JSON.stringify({
    claim, clauses: ["UTC_V1", "PARTIAL_NONE_V1"],
    custom_definitions: ["Fallback: if a named source is unavailable the answer is could-not-check.", "No early resolution."],
    elements: [{ id: "e1", q: claim.replace(/\.$/, "?").replace(/^/, "Is it true that: ") }], rule: "ALL", sources: true, sources_allowed: SOURCES,
    time: { window_start: iso(eventMs - DAY), window_end: iso(eventMs), evidence_cutoff: iso(eventMs + 7 * DAY) },
  });
}
const RUN = (model: string, ms: number) => {
  const content = JSON.stringify({ answer: "met", quote: "BTC-USD daily close 121,410.55 on 2026-11-09", source_id: "S_CB",
    also: [{ source_id: "S_CG", quote: "Nov 09, 2026 close $121,402" }], reason: "Both sources put the 9 Nov close above 120,000 USD." });
  return { model, content, content_head: content, verify_result: "answer", verify_reason: null, signature_verified: true, total_ms: ms };
};
/** A stored resolver result shaped like a real one (tests/fixtures/real-bet-testnet-1.json), trimmed to what the UI reads. */
export const RAW = JSON.stringify({
  contract: "bets.praetorial.near",
  judge: {
    elements: [{ id: "e1", verdict: "met" }], judge_backend: "near-ai", judge_pair_index: 0,
    judge_chain: [{ model_a: "deepseek-ai/DeepSeek-V4.1-Flash-1017", model_b: "z-ai/glm-5.3-flash" }, { model_a: "Qwen/Qwen3.8-27B", model_b: "moonshotai/kimi-k3" }],
    models_requested: ["deepseek-ai/DeepSeek-V4.1-Flash-1017", "z-ai/glm-5.3-flash"],
    run_diagnostics: [RUN("deepseek-ai/DeepSeek-V4.1-Flash-1017", 10649), RUN("z-ai/glm-5.3-flash", 19526)],
  },
  notes: ["source fetched: S_CB (https://www.coinbase.com/price/bitcoin)", "source fetched: S_CG", "decision: met on 2 domains"],
  result: { bet_id: 0, run_no: 1, outcome: "YES", checked_until: 0, element_results_hash: "fe".repeat(32), judge_pair_index: 0, terms_hash: "ab".repeat(32) },
  signing: { pubkey_hex: "44".repeat(32), signature_hex: "71".repeat(64) },
});
/** The resolver returned an unsigned error object: the contract can't move on by itself (SM1 CON-2 / LIFE-9). */
const RAW_UNSIGNED = JSON.stringify({ error: "judge_api_key_missing" });

type B = {
  maker: string; taker?: string | null; status: string; claim: string | null; ma?: string; ta?: string; sm: string; st: string; referee?: string;
  outcome?: string | null; proposedAt?: number | null; eventMs?: number; resolveMs?: number; bonds?: number; raw?: string; pendingReq?: boolean;
  runsUsed?: number; feeMin?: string; createdMs?: number; takenMs?: number; exhibits?: number; tip?: string; settlementMs?: number;
};

function bet(id: number, o: B, now: number): Bet {
  const terms = o.claim === null ? null : customTerms(o.claim, o.eventMs ?? now + 6 * DAY);
  return {
    envelope: {
      bet_id: id, version: 1, maker: o.maker, taker_allow: "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "55".repeat(32),
      outcomes: ["YES", "NO"], maker_side: "YES", maker_asset: o.ma ?? USDC, taker_asset: o.ta ?? o.ma ?? USDC,
      stake_maker: o.sm, stake_taker: o.st, taker_options: [], fee_bps: 100, reserve_per_side: "0", storage_charge_per_side: "0",
      keep_terms: o.claim !== null, terms, run_price: "0", max_paid_runs: 3, tier: 1, arbiter: null, arbiter_fee: "0",
      funding_deadline: ns(o.eventMs ?? now + 6 * DAY), early_settle_outcome: null, finality_delay: 0,
      settlement_period: ns(o.settlementMs ?? DAY), resolve_deadline: ns(o.resolveMs ?? now + 30 * DAY), consent_party_controlled: false,
      referee: o.referee ? { account: o.referee, mode: "Human" } : null,
    } as Bet["envelope"],
    status: o.status, taker: o.taker ?? null, created_at: ns(o.createdMs ?? now - 4 * DAY), taken_at: o.taker ? ns(o.takenMs ?? now - 3 * DAY) : null,
    proposed_at: o.proposedAt != null ? ns(o.proposedAt) : null, outcome: o.outcome ?? null, reserve_remaining: "0",
    bonds: Array.from({ length: o.bonds ?? 0 }, (_, i) => ({ holder: "bob.near", amount: near(2), round: i + 1, pre_challenge_outcome: "YES", asset: NEAR })),
    all_results: o.proposedAt != null && o.raw ? [{ run_no: 1, outcome: o.bonds ? "YES" : o.outcome, element_results_hash: "fe".repeat(32), checked_until: "0" }] : [],
    rebuttals: [],
    exhibits: Array.from({ length: o.exhibits ?? 0 }, (_, i) => ({ hash: `${i + 7}`.repeat(64).slice(0, 64), submitted_at: ns(now - (i + 1) * HOUR), submitted_by: "bob.near" })),
    challenged_by: o.bonds ? "bob.near" : null, window_extension_ns: 0, fee_min_taker: o.feeMin ?? "500000", fee_min_maker: o.feeMin ?? "500000",
    tip_maker: o.tip ?? "0", tip_taker: o.tip ?? "0", storage_maker: "1654", storage_taker: "1654",
    last_resolution_raw: o.raw ?? null, pending_resolution_request: o.pendingReq ? { requested_at: ns(now - HOUR) } : null, runs_used: o.runsUsed ?? 0,
  } as unknown as Bet;
}

export interface BetFixture {
  /** Stable key, used as the playground anchor and in tests. */
  key: string;
  /** What the state is, in plain words (playground caption). */
  label: string;
  /** Which bet id from the UIR1 catalogue (spikes/uir1/shots `bet-NN`), or a new id >= 230. */
  id: number;
  bet: Bet;
  /** The viewer. null = logged out. */
  me: string | null;
  pending?: PayoutLine[] | null;
  shutdown?: boolean;
}

/** Every lifecycle state, at a fixed `now` (ms). */
export function betFixtures(now: number): BetFixture[] {
  const f = (key: string, label: string, id: number, o: B, extra: Partial<BetFixture> = {}): BetFixture =>
    ({ key, label, id, bet: bet(id, o, now), me: ME, pending: [], ...extra });
  return [
    f("open-mine", "Open, mine", 201, { maker: ME, status: "Open", claim: "Bitcoin closes above 120,000 USD on Coinbase on 31 Dec 2026.", sm: usdc(25), st: usdc(25) }),
    f("open-theirs", "Open, someone else's", 202, { maker: "alice.near", status: "Open", claim: "ETH trades above 6,000 USD on Coinbase before 1 Jan 2027.", sm: usdc(50), st: usdc(40), eventMs: now + 2 * DAY }),
    f("open-lapsed", "Open, nobody took it in time", 230, { maker: ME, status: "Open", claim: "SOL above 400 USD on 10 Nov 2026.", sm: usdc(15), st: usdc(15), eventMs: now - HOUR }),
    f("live", "Taken, before the event", 203, { maker: ME, taker: "lee.near", status: "Taken", claim: "The Lakers beat the Celtics on 14 Nov 2026 (ESPN final score).", ma: NEAR, sm: near(10), st: near(10), eventMs: now + 3 * DAY }),
    f("awaiting-result", "Taken, event passed (AI)", 215, { maker: ME, taker: "ivy.near", status: "Taken", claim: "Bitcoin closes above 110,000 USD on Coinbase on 8 Nov 2026.", sm: usdc(40), st: usdc(40), eventMs: now - 2 * DAY }),
    f("judging", "The AI is deciding", 204, { maker: "carol.near", taker: ME, status: "Resolving", claim: "It snows in central London on 1 Nov 2026 (Met Office).", sm: usdc(15), st: usdc(15), eventMs: now - DAY, pendingReq: true }),
    f("ruling-lost", "Ruling made, I lost, can challenge", 205, { maker: "carol.near", taker: ME, status: "Proposed", outcome: "YES", proposedAt: now - 5 * HOUR, claim: "Bitcoin closes above 120,000 USD on Coinbase on 9 Nov 2026.", sm: usdc(30), st: usdc(30), eventMs: now - 2 * DAY, raw: RAW }),
    f("ruling-won", "Ruling made, I won", 231, { maker: ME, taker: "carol.near", status: "Proposed", outcome: "YES", proposedAt: now - 5 * HOUR, claim: "Bitcoin closes above 120,000 USD on Coinbase on 9 Nov 2026.", sm: usdc(30), st: usdc(30), eventMs: now - 2 * DAY, raw: RAW }),
    f("ruling-final", "Ruling made, challenge window closed", 218, { maker: ME, taker: "bob.near", status: "Proposed", outcome: "NO", proposedAt: now - 2 * DAY, claim: "It rains in Paris on 7 Nov 2026 (Meteo-France).", sm: usdc(12), st: usdc(12), eventMs: now - 3 * DAY, raw: RAW }),
    f("challenged", "Challenged, waiting for the second look", 206, { maker: ME, taker: "bob.near", status: "Challenged", outcome: "YES", proposedAt: now - 10 * HOUR, bonds: 1, exhibits: 1, claim: "Apple announces a foldable iPhone before 1 Nov 2026.", ma: NEAR, sm: near(25), st: near(25), eventMs: now - 2 * DAY, raw: RAW }),
    f("rejudge", "Second look in progress", 219, { maker: ME, taker: "bob.near", status: "Rejudge", outcome: "YES", proposedAt: now - 20 * HOUR, bonds: 1, claim: "Tesla delivers over 500k cars in Q3 2026.", sm: usdc(30), st: usdc(30), eventMs: now - 3 * DAY, raw: RAW }),
    f("paying", "Final, paying out", 207, { maker: ME, taker: "bob.near", status: "Finalized", outcome: "YES", proposedAt: now - 2 * DAY, claim: "NYC records a high above 25 C on 1 Nov 2026 (NWS Central Park).", sm: usdc(100), st: usdc(100), eventMs: now - 4 * DAY, raw: RAW },
      { pending: [{ id: 1, bet_id: 207, token_id: USDC, receiver: ME, amount: usdc(198), reason: "win", attempts: 1, done: false, in_flight: true }] }),
    f("payout-stuck", "Final, payout delayed", 216, { maker: ME, taker: "jon.near", status: "Finalized", outcome: "YES", proposedAt: now - 3 * DAY, claim: "Arsenal top the Premier League on 1 Nov 2026.", ma: BTC, ta: BTC, sm: "20000", st: "20000", feeMin: "200", eventMs: now - 5 * DAY, raw: RAW },
      { pending: [{ id: 2, bet_id: 216, token_id: BTC, receiver: ME, amount: "39600", reason: "win", attempts: 3, done: false, in_flight: false }] }),
    f("won", "Settled, I won", 208, { maker: "dave.near", taker: ME, status: "Settled", outcome: "NO", proposedAt: now - 3 * DAY, claim: "Real Madrid beats Barcelona on 26 Oct 2026.", sm: usdc(20), st: usdc(20), eventMs: now - 5 * DAY, raw: RAW }),
    f("lost", "Settled, I lost", 209, { maker: "erin.near", taker: ME, status: "Settled", outcome: "YES", proposedAt: now - 3 * DAY, claim: "Gold closes above 3,000 USD on 30 Oct 2026.", sm: usdc(20), st: usdc(20), eventMs: now - 5 * DAY, raw: RAW }),
    f("voided", "Nobody ruled in time: refunded", 210, { maker: ME, taker: "frank.near", status: "Voided", outcome: "VOID", claim: "The ECB cuts rates on 30 Oct 2026.", sm: usdc(10), st: usdc(10), eventMs: now - 10 * DAY, resolveMs: now - 2 * DAY }),
    f("conceded", "I conceded", 211, { maker: ME, taker: "gina.near", status: "Settled", outcome: "NO", proposedAt: null, claim: "Our 5k: familiarcow finishes under 22 minutes on 2 Nov 2026.", sm: usdc(5), st: usdc(5), eventMs: now - 9 * DAY }),
    f("referee-decided", "A person decided", 212, { maker: ME, taker: "hal.near", status: "Settled", outcome: "YES", proposedAt: now - DAY, referee: "kim.near", claim: "Hal finishes the marathon on 3 Nov 2026.", sm: usdc(20), st: usdc(20), eventMs: now - 8 * DAY, tip: "200000" }),
    f("expired", "Nobody took it", 213, { maker: ME, status: "Expired", claim: "SOL above 400 USD on 1 Nov 2026.", sm: usdc(15), st: usdc(15), eventMs: now - 10 * DAY }),
    f("cancelled", "Cancelled by the maker", 214, { maker: ME, status: "Cancelled", claim: "Dodgers win the 2026 World Series.", sm: usdc(15), st: usdc(15), eventMs: now - 10 * DAY }),
    f("referee-ready", "I'm the referee, ready to rule", 217, { maker: "ivy.near", taker: "jon.near", status: "Taken", referee: ME, claim: "Ivy finishes our 10k under 50 minutes on 9 Nov 2026.", sm: usdc(20), st: usdc(20), eventMs: now - DAY, tip: "200000" }),
    f("referee-waiting", "Waiting for the referee", 220, { maker: ME, taker: "kai.near", status: "Taken", referee: "kim.near", claim: "Kai can do 20 pull-ups by 30 Nov 2026.", sm: usdc(10), st: usdc(10), eventMs: now - HOUR }),
    f("stuck", "Stuck: the AI's answer can't be used", 232, { maker: ME, taker: "bob.near", status: "Resolving", outcome: "YES", proposedAt: now - DAY, bonds: 1, claim: "Bitcoin closes above 115,000 USD on Coinbase on 5 Nov 2026.", sm: usdc(25), st: usdc(25), eventMs: now - 6 * DAY, raw: RAW_UNSIGNED }),
    f("no-result", "The AI used all its checks", 233, { maker: ME, taker: "bob.near", status: "Taken", runsUsed: 3, claim: "The Met Office reports snow in London on 5 Nov 2026.", sm: usdc(25), st: usdc(25), eventMs: now - 6 * DAY }),
    f("shutdown", "The app was shut down", 234, { maker: ME, taker: "bob.near", status: "Taken", claim: "Bitcoin closes above 130,000 USD on Coinbase on 1 Dec 2026.", sm: usdc(25), st: usdc(25), eventMs: now + 20 * DAY }, { shutdown: true }),
    f("referee-legacy", "Legacy: the referee has no username", 236, { maker: ME, taker: "kai.near", status: "Taken", referee: LEGACY, claim: "Kai runs 5k under 25 minutes on 8 Nov 2026.", sm: usdc(10), st: usdc(10), eventMs: now - HOUR }),
    f("no-terms", "Terms not kept on chain", 235, { maker: "alice.near", status: "Open", claim: null, sm: usdc(10), st: usdc(10) }, { me: null }),
  ];
}

export const fixtureByKey = (now: number, key: string): BetFixture => {
  const x = betFixtures(now).find((b) => b.key === key);
  if (!x) throw new Error(`no fixture ${key}`);
  return x;
};
