"""Policy grid + sensitivity sweeps for the dispute-game Monte Carlo model.
Pure Python stdlib only, no LLM/network calls. Usage: python3 run_sim.py
"""
import itertools, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model import GameParams, JudgeErrorModel, run_policy, summarize

N = 20000   # Monte Carlo draws per policy cell

def grid():
    rows = []
    for max_ch, schedule, frozen, def_bond, conflict in itertools.product(
            [1, 2, 3], ["flat", "doubling"], [False, True], [False, True], ["VOID", "ARBITER"]):
        params = GameParams(max_challenges=max_ch, bond_schedule=schedule,
                             evidence_frozen_after_round1=frozen, defender_posts_bond=def_bond,
                             same_tier_conflict_action=conflict)
        judge = JudgeErrorModel()
        outcomes = run_policy(N, params, judge, seed=hash((max_ch, schedule, frozen, def_bond, conflict)) & 0xffffffff)
        s = summarize(outcomes)
        s.update(max_challenges=max_ch, bond_schedule=schedule, evidence_frozen_after_round1=frozen,
                  defender_posts_bond=def_bond, same_tier_conflict_action=conflict)
        rows.append(s)
    return rows

def sensitivity():
    """Vary one assumption at a time off a baseline policy (max_challenges=3,
    flat bonds, frozen evidence, no defender bond, VOID short-circuit) to see
    which assumptions move the headline numbers the most."""
    base = dict(max_challenges=3, bond_schedule="flat", evidence_frozen_after_round1=True,
                defender_posts_bond=False, same_tier_conflict_action="VOID")
    sweeps = {
        "frac_honest_ambiguous": [0.05, 0.15, 0.30],
        "attacker_flip_threshold": [0.10, 0.30, 0.50],
        "p_err_single (judge)": [0.03, 0.07, 0.15],
        "p_err_panel3 (judge)": [0.01, 0.025, 0.06],
        "corr_same_judge (judge)": [0.0, 0.35, 0.70],
        "pot_max": [100.0, 500.0],
    }
    rows = []
    for name, values in sweeps.items():
        for v in values:
            params_kwargs = dict(base)
            judge_kwargs = {}
            if name == "frac_honest_ambiguous":
                params_kwargs["frac_honest_ambiguous"] = v
            elif name == "attacker_flip_threshold":
                params_kwargs["attacker_flip_threshold"] = v
            elif name == "pot_max":
                params_kwargs["pot_max"] = v
            elif name.startswith("p_err_single"):
                judge_kwargs["p_err_single"] = v
            elif name.startswith("p_err_panel3"):
                judge_kwargs["p_err_panel3"] = v
            elif name.startswith("corr_same_judge"):
                judge_kwargs["corr_same_judge"] = v
            params = GameParams(**params_kwargs)
            judge = JudgeErrorModel(**judge_kwargs)
            outcomes = run_policy(N, params, judge, seed=hash((name, v)) & 0xffffffff)
            s = summarize(outcomes)
            s.update(sweep=name, value=v)
            rows.append(s)
    return rows

def main():
    g = grid()
    s = sensitivity()
    out_dir = os.path.dirname(os.path.abspath(__file__))
    json.dump(g, open(os.path.join(out_dir, "grid_results.json"), "w"), indent=1)
    json.dump(s, open(os.path.join(out_dir, "sensitivity_results.json"), "w"), indent=1)

    print("=== POLICY GRID (n=%d per cell) ===" % N)
    hdr = "%-4s %-9s %-7s %-6s %-8s | %-9s %-9s %-9s %-12s %-12s %-9s %-6s"
    print(hdr % ("maxC", "bonds", "frozen", "defBd", "conflict", "wrong%", "meanT_h", "p95T_h", "maker$", "taker$", "honest$", "xfers"))
    for r in sorted(g, key=lambda r: (r["max_challenges"], r["bond_schedule"], r["evidence_frozen_after_round1"])):
        print(hdr % (r["max_challenges"], r["bond_schedule"], r["evidence_frozen_after_round1"],
                      r["defender_posts_bond"], r["same_tier_conflict_action"],
                      "%.2f" % (r["wrong_final_rate"] * 100), "%.1f" % r["mean_time_locked_h"],
                      "%.1f" % r["p95_time_locked_h"], "%.2f" % r["maker_expected_profit"],
                      "%.2f" % r["taker_expected_profit"], "%.2f" % r["honest_challenger_expected_net"],
                      "%.2f" % r["mean_transfers_per_bet"]))

    print("\n=== SENSITIVITY SWEEPS (baseline: maxC=3, flat bonds, frozen, no defender bond, VOID) ===")
    for r in s:
        print("%-28s = %-6s  wrong%%=%.2f  meanT_h=%.1f  maker$=%.2f  taker$=%.2f  honest$=%.2f" %
              (r["sweep"], r["value"], r["wrong_final_rate"] * 100, r["mean_time_locked_h"],
               r["maker_expected_profit"], r["taker_expected_profit"], r["honest_challenger_expected_net"]))

if __name__ == "__main__":
    main()
