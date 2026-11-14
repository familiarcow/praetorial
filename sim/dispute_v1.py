"""Dispute design v1 Monte Carlo (b0nd, 2026-11-03). Pure stdlib, no LLM/network.

Differences vs sim/model.py (kept untouched):
  * per-judge votes with item hardness + shared-shock correlation (Kish n_eff),
    calibrated to "Nine Judges, Two Effective Votes" (arXiv 2605.29800):
    a 3-family panel is NOT 3 independent votes;
  * explicit per-side payoff accounting that mirrors escrow finalize():
    bonds settled by FINAL-outcome attribution (final != pre_challenge_outcome
    => challenger won), lost bond -> counterparty minus run_price -> keeper,
    won bond -> returned minus run_price (+ capped reserve-share reimbursement);
  * rational attacker: challenges a CORRECT outcome only in (policy, round,
    hardness) cells where pass-1 says it is +EV, and when it does it also
    submits adversarial evidence (raises per-judge error on hard items);
  * appeal decision rules: "unanimous_or_void" (today: ESCALATE->VOID) vs
    "deferential" (unanimous -> that outcome; majority against the standing
    outcome -> VOID; otherwise the standing outcome STANDS).
Usage: python3 sim/dispute_v1.py   (writes sim/dispute_v1_results.json)
"""
import json, os, random
from dataclasses import dataclass, replace

N = 20000

@dataclass
class Judge:
    n: int            # votes in the round
    e_easy: float     # per-vote error on an easy item
    e_hard: float     # per-vote error on a hard item
    abstain: float    # per-vote unresolved/invalid
    rho: float        # shared-shock prob (all votes copy one draw)
    p_conflict: float # per-vote "conflict" on a genuinely ambiguous bet
    price: float      # flat run price (USD)

R0      = Judge(3, 0.02, 0.20, 0.03, 0.80, 0.55, 0.25)   # one attested model x3 (same model: high rho)
PANEL3  = Judge(3, 0.015, 0.15, 0.03, 0.40, 0.65, 0.60)  # 3 providers / 3 families
PANEL5D = Judge(5, 0.01, 0.10, 0.02, 0.35, 0.75, 1.50)   # 5 families + adversarial-debate prompt
RERUN   = R0                                             # today: a challenge re-runs the same resolver

@dataclass
class Policy:
    name: str
    judges: tuple          # judge per challenge round
    rule: str              # "unanimous_or_void" | "deferential"
    bond_pct: float
    bond_min: float
    bond_mult: float       # x per round (1 flat, 2 doubling)
    defender_bond: bool = False
    frozen: bool = True    # no new exhibits after round 1 (attacker delta applies once)
    settle_h: float = 48.0
    r1_h: float = 49.0     # 24h exhibits + 24h rebuttal + judge
    later_window_h: float = 24.0
    later_h: float = 25.0  # rebuttal-only + judge

@dataclass
class World:
    s_min: float = 20.0
    s_max: float = 250.0          # beta cap per side
    frac_amb: float = 0.10        # genuinely ambiguous (correct = VOID)
    frac_hard: float = 0.20
    attack_delta: float = 0.10    # adversarial evidence: + per-vote error on hard items
    reserve_share: float = 0.25   # each side's reserve half (run-cost reimbursement cap)

def votes(rng, j: Judge, truth, hard, amb, delta):
    """Return list of votes in {'Y','N','V','A'} (A = abstain/unresolved)."""
    def one():
        if rng.random() < j.abstain:
            return "A"
        if amb:
            return "V" if rng.random() < j.p_conflict else rng.choice("YN")
        e = (j.e_hard + delta) if hard else j.e_easy
        if rng.random() < e:
            return "N" if truth == "Y" else "Y"
        return truth
    if rng.random() < j.rho:
        v = one(); return [v] * j.n
    return [one() for _ in range(j.n)]

def decide_r0(vs):
    s = set(vs)
    if len(s) == 1 and "A" not in s:
        return vs[0]
    return "V"        # ESCALATE -> VOID (resolver/wasm-bin main.rs:746)

def decide_appeal(vs, standing, rule):
    s = set(vs)
    if len(s) == 1 and "A" not in s:
        return vs[0]
    if rule == "unanimous_or_void":
        return "V"
    against = sum(1 for v in vs if v not in ("A", standing))
    return "V" if against * 2 > len(vs) else standing

def bond(pol, pot, r):
    return max(pol.bond_min, pol.bond_pct * pot) * (pol.bond_mult ** (r - 1))

def pay(o, side, S):   # side 'Y' or 'N' party's stake result
    return 0.0 if o == "V" else (S if o == side else -S)

def sim_bet(rng, pol: Policy, w: World, attack_ok):
    S = rng.uniform(w.s_min, w.s_max); pot = 2 * S
    amb = rng.random() < w.frac_amb
    truth = "V" if amb else rng.choice("YN")
    hard = amb or (rng.random() < w.frac_hard)
    o = decide_r0(votes(rng, R0, truth if not amb else "Y", hard, amb, 0.0))
    bonds = []   # (holder, amount, pre, price, def_bond)
    t = pol.settle_h
    attacked = False; attack_cells = []
    delta_used = False
    for r, j in enumerate(pol.judges, start=1):
        # who challenges?
        challenger = None; honest = False
        if o != truth:
            # honest wronged party: the side whose truth-payoff beats o
            for side in "YN":
                if pay(truth, side, S) > pay(o, side, S):
                    challenger, honest = side, True; break
        if challenger is None:
            # attacker: a party that prefers some other outcome to o (o == truth or o better for them)
            cand = [sd for sd in "YN" if o != sd]
            cell = (r, hard)
            if cand and attack_ok(cell):
                challenger = cand[0] if o == "V" and truth == "V" else [sd for sd in "YN" if pay(o, sd, S) < S][0]
                attacked = True; attack_cells.append(cell)
        if challenger is None:
            break
        b = bond(pol, pot, r)
        bonds.append((challenger, b, o, j.price, b if pol.defender_bond else 0.0, honest))
        delta = 0.0
        if not honest and (not pol.frozen or not delta_used):
            delta = w.attack_delta; delta_used = True
        if not honest and pol.frozen and r > 1:
            delta = 0.0
        vs = votes(rng, j, truth if not amb else "Y", hard, amb, delta)
        o = decide_appeal(vs, o, pol.rule)
        t += pol.r1_h if r == 1 else (pol.later_window_h + pol.later_h)
    final = o
    # accounting per side (relative to stake result only => compute both)
    net = {"Y": pay(final, "Y", S), "N": pay(final, "N", S)}
    for holder, b, pre, price, db, honest in bonds:
        other = "N" if holder == "Y" else "Y"
        won = final != pre
        if won:
            net[holder] += -price + min(price, w.reserve_share)
            net[other] -= min(price, w.reserve_share)
            if db:
                net[holder] += db; net[other] -= db
        else:
            net[holder] -= b
            net[other] += b - price
    return dict(S=S, amb=amb, hard=hard, truth=truth, final=final, rounds=len(bonds),
                t=t, net=net, bonds=bonds, attacked=attacked, attack_cells=attack_cells)

def truth_payoff(res, side):
    return pay(res["truth"], side, res["S"])

def run(pol, w, attack_ok, n=N, seed=1):
    rng = random.Random(seed)
    return [sim_bet(rng, pol, w, attack_ok) for _ in range(n)]

def attacker_ev_by_cell(pol, w, n=N, seed=7):
    """Pass 1: force an attack in exactly one cell, everything else honest-only.
    EV = attacker net(with attack) - attacker net(no attack: correct loss), per $ of own stake."""
    out = {}
    for cell in [(r, h) for r in range(1, len(pol.judges) + 1) for h in (False, True)]:
        res = run(pol, w, lambda c, cell=cell: c == cell, n, seed)
        gains = []
        for x in res:
            if cell not in x["attack_cells"]:
                continue
            # the attacker is the holder of the first dishonest bond
            atk = next(bd[0] for bd in x["bonds"] if not bd[5])
            base = truth_payoff(x, atk)
            gains.append((x["net"][atk] - base, x["S"]))
        if gains:
            out["r%d_%s" % (cell[0], "hard" if cell[1] else "easy")] = dict(
                n=len(gains), ev_usd=sum(g for g, _ in gains) / len(gains),
                ev_per_stake_pct=100 * sum(g / s for g, s in gains) / len(gains))
    return out

def summarize(pol, w, res):
    n = len(res)
    clear = [x for x in res if not x["amb"]]
    wrong = sum(1 for x in clear if x["final"] not in (x["truth"], "V")) / len(clear)
    void_clear = sum(1 for x in clear if x["final"] == "V") / len(clear)
    amb = [x for x in res if x["amb"]]
    amb_wrong = sum(1 for x in amb if x["final"] != "V") / max(1, len(amb))
    honest = []
    for x in res:
        hb = [bd for bd in x["bonds"] if bd[5]]
        if hb:
            h = hb[0][0]
            # honest gain vs. accepting the wrong round-0 outcome: approx by (net - pay(r0 outcome))
            honest.append(x["net"][h] - pay(hb[0][2], h, x["S"]))
    honest_lost_money = sum(1 for g in honest if g < 0) / max(1, len(honest))
    ts = sorted(x["t"] for x in res)
    attacks = sum(1 for x in res if x["attacked"]) / n
    return dict(policy=pol.name, wrong_final_pct=100 * wrong, void_on_clear_pct=100 * void_clear,
                ambiguous_not_voided_pct=100 * amb_wrong, attack_rate_pct=100 * attacks,
                honest_challenges=len(honest), honest_mean_gain_usd=sum(honest) / max(1, len(honest)),
                honest_worse_off_pct=100 * honest_lost_money,
                mean_rounds=sum(x["rounds"] for x in res) / n, max_rounds_used=max(x["rounds"] for x in res),
                mean_lock_h=sum(ts) / n, p99_lock_h=ts[int(0.99 * n)], max_lock_h=ts[-1])

POLICIES = [
    Policy("A_current_code: 3 reruns, flat 5%/$5, ESCALATE->VOID", (RERUN, RERUN, RERUN), "unanimous_or_void", 0.05, 5, 1, frozen=False),
    Policy("B_redteam_rec: 2 panel rounds, doubling 5%, defender bond, ESCALATE->VOID", (PANEL3, PANEL3), "unanimous_or_void", 0.05, 5, 2, defender_bond=True),
    Policy("C_v1_rec: panel3 then panel5+debate, deferential, 10%/$10 doubling", (PANEL3, PANEL5D), "deferential", 0.10, 10, 2),
    Policy("C_5pct: as C but 5%/$5 doubling", (PANEL3, PANEL5D), "deferential", 0.05, 5, 2),
    Policy("C_1round: panel3 only, deferential, 10%/$10", (PANEL3,), "deferential", 0.10, 10, 2),
    Policy("C_3rounds: + 3rd panel5+debate round, 10%/$10 doubling", (PANEL3, PANEL5D, PANEL5D), "deferential", 0.10, 10, 2),
    Policy("D_void_rule_with_C_judges: C but ESCALATE->VOID", (PANEL3, PANEL5D), "unanimous_or_void", 0.10, 10, 2),
]

def evaluate(pol, w):
    ev = attacker_ev_by_cell(pol, w)
    plus = {k for k, v in ev.items() if v["ev_usd"] > 0}
    def ok(cell):
        return ("r%d_%s" % (cell[0], "hard" if cell[1] else "easy")) in plus
    res = run(pol, w, ok)
    s = summarize(pol, w, res)
    s["attacker_ev_by_cell"] = ev
    s["attack_profitable_cells"] = sorted(plus)
    return s

def main():
    w = World()
    rows = [evaluate(p, w) for p in POLICIES]
    sens = []
    base = POLICIES[2]
    for name, kw in [("attack_delta=0.25", dict(attack_delta=0.25)), ("frac_hard=0.40", dict(frac_hard=0.40)),
                     ("attack_delta=0.0", dict(attack_delta=0.0))]:
        for p in (POLICIES[0], base):
            s = evaluate(p, replace(w, **kw)); s["sweep"] = name; sens.append(s)
    for name, j2 in [("panel5 rho=0.7 (more correlated)", replace(PANEL5D, rho=0.7)),
                     ("panel3 e_hard=0.25", None)]:
        if j2 is not None:
            p = replace(base, judges=(PANEL3, j2))
        else:
            p = replace(base, judges=(replace(PANEL3, e_hard=0.25), PANEL5D))
        s = evaluate(p, w); s["sweep"] = name; sens.append(s)
    out = dict(world=w.__dict__, n=N, grid=rows, sensitivity=sens)
    json.dump(out, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispute_v1_results.json"), "w"), indent=1)
    for r in rows + sens:
        print("%-75s %s" % (r["policy"][:75], r.get("sweep", "")))
        print("   wrong=%.2f%% void_clear=%.2f%% amb_not_void=%.1f%% attacks=%.2f%% honest_gain=$%.1f honest_worse=%.1f%% rounds=%.3f lock mean/p99/max=%.0f/%.0f/%.0fh"
              % (r["wrong_final_pct"], r["void_on_clear_pct"], r["ambiguous_not_voided_pct"], r["attack_rate_pct"],
                 r["honest_mean_gain_usd"], r["honest_worse_off_pct"], r["mean_rounds"], r["mean_lock_h"], r["p99_lock_h"], r["max_lock_h"]))
        print("   attacker EV: " + ", ".join("%s $%.2f (%.1f%% of stake)" % (k, v["ev_usd"], v["ev_per_stake_pct"]) for k, v in sorted(r["attacker_ev_by_cell"].items())))

if __name__ == "__main__":
    main()
