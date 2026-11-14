"""Extra sensitivity runs for dispute design v1. Usage: python3 sim/dispute_v1_extra.py"""
import json, os, sys
from dataclasses import replace
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dispute_v1 import POLICIES, World, PANEL3, PANEL5D, evaluate

w = World()
C10, C5 = POLICIES[2], POLICIES[3]
runs = [
    ("C_5pct attack_delta=0.25", C5, replace(w, attack_delta=0.25)),
    ("C_5pct frac_hard=0.40", C5, replace(w, frac_hard=0.40)),
    ("C_5pct panel3 e_hard=0.25", replace(C5, judges=(replace(PANEL3, e_hard=0.25), PANEL5D)), w),
    ("C_5pct small bets $20-50/side", C5, replace(w, s_min=20, s_max=50)),
    ("C_10pct small bets $20-50/side", C10, replace(w, s_min=20, s_max=50)),
    ("C_5pct + defender bond", replace(C5, defender_bond=True), w),
    ("C_5pct not frozen (fresh evidence every round)", replace(C5, frozen=False), w),
    ("C_5pct flat bonds (no doubling)", replace(C5, bond_mult=1), w),
    ("C_5pct worst case: delta=0.25, hard=0.40, e_hard=0.25, rho5=0.7",
     replace(C5, judges=(replace(PANEL3, e_hard=0.25), replace(PANEL5D, rho=0.7))), replace(w, attack_delta=0.25, frac_hard=0.40)),
    ("C_10pct same worst case",
     replace(C10, judges=(replace(PANEL3, e_hard=0.25), replace(PANEL5D, rho=0.7))), replace(w, attack_delta=0.25, frac_hard=0.40)),
]
out = []
for name, p, ww in runs:
    s = evaluate(p, ww); s["sweep"] = name; out.append(s)
    print(name)
    print("   wrong=%.2f%% void_clear=%.2f%% amb_not_void=%.1f%% attacks=%.2f%% honest_gain=$%.1f honest_worse=%.1f%% lock mean/max=%.0f/%.0fh"
          % (s["wrong_final_pct"], s["void_on_clear_pct"], s["ambiguous_not_voided_pct"], s["attack_rate_pct"],
             s["honest_mean_gain_usd"], s["honest_worse_off_pct"], s["mean_lock_h"], s["max_lock_h"]))
    print("   attacker EV: " + ", ".join("%s $%.2f (%.1f%%)" % (k, v["ev_usd"], v["ev_per_stake_pct"]) for k, v in sorted(s["attacker_ev_by_cell"].items())))
json.dump(out, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispute_v1_extra_results.json"), "w"), indent=1)
