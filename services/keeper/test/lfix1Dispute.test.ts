// LFIX1 (SM1 LIFE-1 / SVC-1, re-checked on main): one whole AI dispute driven minute by minute through the mainnet Worker keeper
// (workers/keeper/src/tick.ts -> keeper/src/policy.ts) against a mocked escrow that keeps the contract's own rules
// (contracts/escrow/src/lib.rs): handle_bond (no time guard), request_resolution (zero-deposit keeper call drawn from keeper_credit,
// can_request_resolution gates), the run landing as a new ruling (Proposed, outcome set, proposed_at = now, runs_used + 1), and
// finalize (bonded 24h window + "challenge round pending a ruling" gate; challenger_won = pre_challenge_outcome != outcome).
// This is the scenario of the mainnet dispute test (spikes/lfix1/M15-dispute-test.md): it must end with the re-judge run requested
// exactly once by the keeper, no refused tx, and the challenger's bond returned when the re-judge flips the ruling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runKeeperTick, MemoryStateStore } from "../../workers/keeper/src/tick.js";

const NS = 1_000_000_000, H = 3600 * NS, MIN = 60 * NS, DAY = 24 * H;
const ROUND_WINDOW_NS = DAY;
const RUN_DEPOSIT = 20_062_500_000_000_000_000_000n; // MIN_RESOLUTION_COMPUTE_DEPOSIT (requestResult.ts / lib.rs)
const RUN_PRICE = 5000n, BOND1 = 5_000_000n + RUN_PRICE; // USDC asset_limits on mainnet: max(min_bond 5 USDC, 10% pot) + run_price
const T0 = 1_900_000_000 * NS; // event / funding_deadline
const C = "bets.praetorial.near";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

interface Tx { atNs: number; method: string; ok: boolean; err?: string }

/** Minimal escrow: only the parts a dispute touches, each mirroring the lib.rs require()s. */
function escrow(rejudgeOutcome: "YES" | "NO") {
  const st = {
    credit: 500_000_000_000_000_000_000_000n, // keeper_credit_balance on mainnet 2026-11-12 (0.5 NEAR)
    resolverLandsAt: null as number | null,
    payouts: [] as { receiver: string; reason: string }[],
    txs: [] as Tx[],
  };
  const bet: any = {
    envelope: {
      bet_id: 1, maker: "maker.near", maker_side: "YES", maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: "10000000",
      max_paid_runs: 3, referee: null, funding_deadline: T0, resolve_deadline: T0 + 7 * DAY, settlement_period: DAY, early_settle_outcome: null,
    },
    taker: "taker.near", status: "Proposed", outcome: "YES", proposed_at: T0 + 10 * MIN, runs_used: 1, bonds: [] as any[],
    pending_resolution_request: 0, pending_run_no: null, window_extension_ns: "0", next_check_ns: null, no_live_judge_until_ns: null,
    last_resolution_raw: null, all_results: [{ outcome: "YES" }],
  };
  const refuse = (atNs: number, method: string, msg: string) => { st.txs.push({ atNs, method, ok: false, err: msg }); throw new Error(`Smart contract panicked: ${msg}`); };
  function finalizeRefusal(now: number): string | null {
    if (!["Proposed", "Challenged", "Evidence"].includes(bet.status)) return "bet not Proposed/Challenged/Evidence";
    if (bet.bonds.length && bet.status !== "Proposed" && !(now >= bet.envelope.resolve_deadline || bet.runs_used >= bet.envelope.max_paid_runs)) return "challenge round pending a ruling";
    const base = bet.bonds.length ? Math.min(bet.envelope.settlement_period, ROUND_WINDOW_NS) : bet.envelope.settlement_period;
    if (now < bet.proposed_at + base + Number(bet.window_extension_ns)) return "settlement_period not elapsed";
    return null;
  }
  function requestRefusal(now: number): string | null {
    if (!["Taken", "Challenged", "Evidence"].includes(bet.status)) return "bet not awaiting resolution";
    if (!(now >= bet.envelope.funding_deadline)) return "too early to request resolution";
    if (bet.runs_used >= bet.envelope.max_paid_runs) return "max_paid_runs reached";
    if (now >= bet.envelope.resolve_deadline) return "resolve_deadline passed";
    if (bet.envelope.referee) return "a person decides this bet (no AI run)";
    return null;
  }
  return {
    st, bet,
    /** mt_on_transfer {"kind":"Bond"} -> handle_bond: party, Proposed|Evidence, bonds < max_rounds, exact amount. NO time guard (CON-1). */
    bond(holder: string, amount: bigint) {
      if (!["Proposed", "Evidence"].includes(bet.status) || bet.bonds.length >= 2 || amount !== BOND1) return false;
      bet.bonds.push({ holder, amount: String(amount), round: bet.bonds.length + 1, pre_challenge_outcome: bet.outcome, asset: USDC });
      bet.pre_challenge_outcome = bet.outcome; bet.challenged_by = holder; bet.status = "Challenged";
      return true;
    },
    /** The OutLayer run finishing and its signed result being submitted (KEEPSUBMIT1 relay is covered by its own tests). */
    advance(now: number) {
      if (bet.status === "Resolving" && st.resolverLandsAt !== null && now >= st.resolverLandsAt) {
        bet.status = "Proposed"; bet.outcome = rejudgeOutcome; bet.proposed_at = now; bet.runs_used += 1; bet.pending_run_no = null;
        bet.all_results.push({ outcome: rejudgeOutcome }); st.resolverLandsAt = null;
      }
    },
    client(nowNs: () => number) {
      return {
        async view(_c: string, m: string, a: any) {
          if (m === "get_bet") return a.bet_id === 1 ? bet : null;
          if (m === "is_shutdown") return false;
          if (m === "pending_payouts_view") return [];
          return null;
        },
        async call(_c: string, m: string) {
          const now = nowNs();
          if (m === "request_resolution") {
            const r = requestRefusal(now);
            if (r) refuse(now, m, r);
            if (st.credit < RUN_DEPOSIT) refuse(now, m, "insufficient keeper credit"); // zero-deposit keeper call (lib.rs D5)
            st.credit -= RUN_DEPOSIT;
            bet.prior = bet.status; bet.status = "Resolving"; bet.pending_resolution_request = (bet.pending_resolution_request ?? 0) + 1;
            bet.pending_run_no = bet.runs_used + 1; st.resolverLandsAt = now + 5 * MIN;
          } else if (m === "finalize") {
            const r = finalizeRefusal(now);
            if (r) refuse(now, m, r);
            for (const b of bet.bonds) {
              const won = b.pre_challenge_outcome !== bet.outcome;
              st.payouts.push(won ? { receiver: b.holder, reason: "bond_returned_won_minus_run_cost" } : { receiver: b.holder === "maker.near" ? "taker.near" : "maker.near", reason: "bond_lost_to_counterparty" });
              st.payouts.push({ receiver: "keeper.praetorial.near", reason: "bond_round_cost_to_keeper" });
            }
            bet.bonds = []; bet.status = "Finalized";
          } else if (m !== "drain_payouts") {
            refuse(now, m, `unexpected ${m}`);
          }
          st.txs.push({ atNs: now, method: m, ok: true });
          return {};
        },
        async callPayable(_c: string, m: string) { refuse(nowNs(), m, "keeper attached a deposit (mainnet keeper is a function-call key: zero deposit only)"); },
      };
    },
  };
}

async function run(rejudgeOutcome: "YES" | "NO", bondAtNs: number, minutes: number) {
  const e = escrow(rejudgeOutcome);
  let nowNs = e.bet.proposed_at;
  const store = new MemoryStateStore();
  let bonded = false;
  for (let i = 0; i < minutes; i++) {
    if (!bonded && nowNs >= bondAtNs) { assert.equal(e.bond("taker.near", BOND1), true, "bond accepted"); bonded = true; }
    e.advance(nowNs);
    await runKeeperTick({ client: e.client(() => nowNs) as any, contracts: [{ id: C, version: "1.0.0" }], store, nowMs: () => nowNs / 1e6, alerts: { async send() {} } });
    if (e.bet.status === "Finalized") break;
    nowNs += MIN;
  }
  return e;
}

test("LIFE-1/SVC-1 on main: after the taker's bond the keeper asks for the re-judge (once, at the window end), and the flipped ruling returns the bond", async () => {
  const P = T0 + 10 * MIN;
  const e = await run("NO", P + 2 * H, 4 * 24 * 60);
  const ok = (m: string) => e.st.txs.filter((t) => t.ok && t.method === m);
  const refused = e.st.txs.filter((t) => !t.ok);
  assert.deepEqual(refused.map((t) => `${t.method}: ${t.err}`), [], "no refused tx (gas burned for nothing)");
  assert.equal(ok("request_resolution").length, 1, "the keeper requested the re-judge exactly once");
  const req = ok("request_resolution")[0].atNs;
  assert.ok(req >= P + DAY && req <= P + DAY + 5 * MIN, `re-judge requested at window end +${(req - P - DAY) / MIN} min`);
  assert.equal(e.st.credit, 500_000_000_000_000_000_000_000n - RUN_DEPOSIT, "paid once from keeper_credit (zero-deposit call)");
  assert.equal(e.bet.all_results.length, 2, "the re-judge actually ran");
  assert.equal(e.bet.status, "Finalized");
  const fin = ok("finalize")[0].atNs;
  const newRuling = req + 5 * MIN;
  assert.ok(fin >= newRuling + DAY && fin <= newRuling + DAY + 5 * MIN, "finalized right after the re-judged ruling's 24h window");
  assert.deepEqual(e.st.payouts[0], { receiver: "taker.near", reason: "bond_returned_won_minus_run_cost" }, "challenger won: bond back");
});

test("LIFE-1/SVC-1 on main: a re-judge that confirms the ruling forfeits the bond only AFTER the run happened", async () => {
  const P = T0 + 10 * MIN;
  const e = await run("YES", P + 23 * H, 4 * 24 * 60);
  assert.deepEqual(e.st.txs.filter((t) => !t.ok), []);
  assert.equal(e.st.txs.filter((t) => t.ok && t.method === "request_resolution").length, 1);
  assert.equal(e.bet.all_results.length, 2, "the keeper paid for a real second look before the bond was lost");
  assert.equal(e.st.payouts[0].reason, "bond_lost_to_counterparty");
  const fin = e.st.txs.find((t) => t.ok && t.method === "finalize")!.atNs;
  assert.ok(fin < e.bet.envelope.resolve_deadline - 4 * DAY, "settled within ~2 days, not held to resolve_deadline");
});
