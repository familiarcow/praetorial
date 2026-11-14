"""Monte Carlo model of the Praetorial dispute game (Part B). Pure Python,
no LLM calls, no network. Models the round-by-round economics of a
challenge ladder given D-AUDIT8 (multi-round canonical; challenger's bond
pays its own run; loser pays; max_rounds default 3) and the evidence
design doc's bond/escalation proposals (flat 5%/$5 min vs doubling per
round; defender bond optional; evidence-freeze / conflict short-circuit
policy levers).

Run: python3 sim/run_sim.py
"""
import random
from dataclasses import dataclass, field

# ---------------------------------------------------------------- inputs
@dataclass
class JudgeErrorModel:
    """Per-round-type error rate: probability a round's verdict is WRONG
    (disagrees with ground truth), plus correlation between re-runs of the
    SAME judge type (panel re-run after a challenge isn't an independent
    draw -- same model family, same training-data blind spots)."""
    p_err_single: float = 0.07      # single attested model, tier <=$500
    p_err_panel3: float = 0.025     # 3-provider panel (escalation round)
    p_err_arbiter: float = 0.01     # named human arbiter, final-offer
    corr_same_judge: float = 0.35   # correlation between round N and round N+1 errors if same judge type repeats

@dataclass
class GameParams:
    pot_min: float = 20.0
    pot_max: float = 500.0
    frac_honest_ambiguous: float = 0.15   # fraction of bets where the true answer is genuinely ambiguous (honest disagreement, not fraud)
    bond_schedule: str = "flat"           # "flat" (5%/$5 min every round) or "doubling" (round r bond = base * 2**r)
    defender_posts_bond: bool = False     # whether the non-challenging side must also post a matching bond to keep contesting
    max_challenges: int = 1               # policy lever: 1, 2, or 3 (D-AUDIT8 default cap is 3; this sweeps it)
    evidence_frozen_after_round1: bool = False   # policy lever (family 7 finding)
    same_tier_conflict_action: str = "VOID"      # "VOID" or "ARBITER" -- policy lever
    attacker_flip_threshold: float = 0.30 # attacker challenges only if their believed P(flip) exceeds this
    time_per_round_h: float = 48.0        # settlement-period-equivalent time funds stay locked per round
    run_price_frac_of_bond_floor: float = 0.02  # run_price as a fraction of pot, floored by the $5 bond minimum covering it

BOND_FLOOR = 5.0

def bond_for_round(pot, r, schedule):
    """r is 1-indexed round (the Nth challenge). D8/D-AUDIT8: flat 5%/$5 min
    every round; design doc §14's escalation proposal: new bond x2 each round."""
    base = max(BOND_FLOOR, 0.05 * pot)
    if schedule == "flat":
        return base
    if schedule == "doubling":
        return base * (2 ** (r - 1))
    raise ValueError(schedule)

def run_price(pot, params: GameParams):
    return max(0.25, params.run_price_frac_of_bond_floor * pot)

# ---------------------------------------------------------------- one bet
@dataclass
class BetOutcome:
    wrong_final: bool
    rounds_run: int
    time_locked_h: float
    maker_profit: float
    taker_profit: float
    challenger_net_when_right: float   # None-able; filled only if an honest challenge occurred and won
    n_transfers: int
    honest_ambiguous: bool
    short_circuited_void: bool

def simulate_bet(rng: random.Random, params: GameParams, judge: JudgeErrorModel):
    pot = rng.uniform(params.pot_min, params.pot_max)
    honest_ambiguous = rng.random() < params.frac_honest_ambiguous
    true_answer_exists = not honest_ambiguous   # ambiguous bets have no single ground truth -- VOID is "correct"

    # Round 0: automatic resolution, single model, free (sponsored).
    err0 = judge.p_err_single
    round0_wrong = (rng.random() < err0) if true_answer_exists else False
    # For an honest-ambiguous bet, round 0 may still output a confident
    # (wrong-framing) YES/NO instead of flagging ambiguity -- modeled as the
    # same single-model error rate producing a "confidently wrong" proposal.
    if honest_ambiguous:
        round0_wrong = rng.random() < err0  # "wrong" here means it looks confidently decided when it should void

    n_transfers = 1   # the round-0 payout itself
    time_locked = params.time_per_round_h   # settlement window before anyone challenges
    rounds_run = 0
    maker_profit = 0.0
    taker_profit = 0.0
    challenger_net_when_right = None
    short_circuited_void = False
    final_wrong = round0_wrong
    outcome_is_void = False

    # Attacker (whichever side benefits from flipping) decides whether to
    # challenge based on their believed P(flip succeeding). We model the
    # attacker's true P(flip) as: if round0 is wrong, flipping back to truth
    # is easy (P high); if round0 is right, flipping it the WRONG way is hard
    # (P low, proportional to judge error rate of the escalation round).
    for r in range(1, params.max_challenges + 1):
        attacker_is_the_wronged_honest_party = final_wrong
        p_flip_true = (1 - judge.p_err_panel3) if attacker_is_the_wronged_honest_party else judge.p_err_panel3
        # Correlated re-runs: if the same judge class keeps getting used,
        # a prior error correlates with another error (corr_same_judge).
        if r > 1:
            p_flip_true = p_flip_true * (1 - judge.corr_same_judge) + (1.0 if final_wrong else 0.0) * judge.corr_same_judge

        believes_worth_it = p_flip_true > params.attacker_flip_threshold
        if not believes_worth_it:
            break

        # Evidence-freeze policy: after round 1, a challenger may not
        # introduce fresh unrelated evidence -- this mechanically lowers
        # their effective P(flip) in later rounds back toward the panel's
        # baseline error rate (no "fresh roll"), per the Part A family-7 finding.
        if params.evidence_frozen_after_round1 and r > 1:
            p_flip_true = judge.p_err_panel3 if not attacker_is_the_wronged_honest_party else (1 - judge.p_err_panel3)

        rounds_run += 1
        bond = bond_for_round(pot, r, params.bond_schedule)
        price = run_price(pot, params)
        time_locked += params.time_per_round_h
        n_transfers += 2   # bond post + round settlement

        if params.defender_posts_bond:
            n_transfers += 1

        # Same-tier honest conflict short-circuit: if this bet is genuinely
        # ambiguous, the policy decides VOID immediately (no further rounds,
        # no coin-flip risk) vs sending to arbiter (costs more, but can still
        # resolve decisively with the arbiter's low error rate).
        if honest_ambiguous and r == 1:
            if params.same_tier_conflict_action == "VOID":
                short_circuited_void = True
                outcome_is_void = True
                final_wrong = False   # VOID on a genuinely ambiguous bet is the CORRECT outcome
                maker_profit -= price / 2
                taker_profit -= price / 2
                break
            else:  # ARBITER
                arb_wrong = rng.random() < judge.p_err_arbiter
                final_wrong = arb_wrong
                n_transfers += 1
                break

        flipped = rng.random() < p_flip_true
        challenger_was_right = flipped == attacker_is_the_wronged_honest_party
        # cost/bond accounting: loser of the round pays (D-AUDIT3/D-AUDIT8)
        if flipped:
            final_wrong = not final_wrong
        if challenger_was_right:
            # challenger gets bond back + opponent's matching stake-side cost;
            # compute reimbursed by the loser (the party who was wrong this round)
            net = bond - price if not params.defender_posts_bond else bond + bond_for_round(pot, r, params.bond_schedule) - price
            challenger_net_when_right = net if challenger_net_when_right is None else challenger_net_when_right + net
            maker_profit += net / 2  # distributed across remaining accounting below (role resolved after loop)
        else:
            challenger_net_when_right = challenger_net_when_right  # unchanged
            maker_profit -= bond
    # fee/profit distribution: wrong final outcome means value transferred to the wrong side
    wrong_final = final_wrong and true_answer_exists and not outcome_is_void

    # crude profit model: being on the winning side of a wrong-final outcome
    # nets you the counterparty's stake share; this sim only needs the SIGN
    # and relative magnitude across policies, not cent-accurate accounting.
    role_sign = 1 if rng.random() < 0.5 else -1
    if wrong_final:
        maker_profit += role_sign * pot * 0.5
        taker_profit -= role_sign * pot * 0.5

    return BetOutcome(
        wrong_final=wrong_final, rounds_run=rounds_run, time_locked_h=time_locked,
        maker_profit=maker_profit, taker_profit=taker_profit,
        challenger_net_when_right=challenger_net_when_right,
        n_transfers=n_transfers, honest_ambiguous=honest_ambiguous,
        short_circuited_void=short_circuited_void,
    )

# ---------------------------------------------------------------- Monte Carlo driver
def run_policy(n, params: GameParams, judge: JudgeErrorModel, seed=0):
    rng = random.Random(seed)
    outcomes = [simulate_bet(rng, params, judge) for _ in range(n)]
    return outcomes

def summarize(outcomes):
    n = len(outcomes)
    wrong = sum(o.wrong_final for o in outcomes) / n
    times = sorted(o.time_locked_h for o in outcomes)
    mean_time = sum(times) / n
    p95_time = times[int(0.95 * n)] if n > 1 else times[0]
    maker_profit = sum(o.maker_profit for o in outcomes) / n
    taker_profit = sum(o.taker_profit for o in outcomes) / n
    honest_nets = [o.challenger_net_when_right for o in outcomes if o.challenger_net_when_right is not None]
    honest_net = sum(honest_nets) / len(honest_nets) if honest_nets else 0.0
    transfers = sum(o.n_transfers for o in outcomes) / n
    void_rate = sum(o.short_circuited_void for o in outcomes) / n
    return dict(n=n, wrong_final_rate=wrong, mean_time_locked_h=mean_time, p95_time_locked_h=p95_time,
                maker_expected_profit=maker_profit, taker_expected_profit=taker_profit,
                honest_challenger_expected_net=honest_net, mean_transfers_per_bet=transfers,
                void_short_circuit_rate=void_rate)
