"""D-DISPUTE1 (familiarcow, 2026-11-04): deferential appeal decision rule +
per-round panel config (dispute design doc v1, section
2/3.1/3.2). Pure logic, no model calls, deterministic.

Standalone, plain-assert script (no pytest dependency), same pattern as
test_oq_t9_window_close.py:
    python3 test_dispute1_appeal.py

Mirrors resolver/core/src/lib.rs's decide_appeal()/panel_for_round() --
parity is enforced by resolver/core/tests/parity.rs reading
dispute1_appeal.json, exported by export_fixtures.py.
"""
import judge as J


def test_unanimous_overturns_to_the_new_outcome():
    outcome, _ = J.decide_appeal("NO", ["YES", "YES", "YES"])
    assert outcome == "YES"


def test_unanimous_affirms_the_standing_outcome():
    outcome, _ = J.decide_appeal("NO", ["NO", "NO", "NO"])
    assert outcome == "NO"


def test_majority_against_but_not_unanimous_voids():
    outcome, _ = J.decide_appeal("NO", ["YES", "VOID", "NO"])
    assert outcome == "VOID"


def test_split_the_other_way_leaves_the_standing_outcome():
    outcome, _ = J.decide_appeal("NO", ["YES", "NO", "NO"])
    assert outcome == "NO"


def test_unanimous_void_overturns_to_void():
    outcome, _ = J.decide_appeal("YES", ["VOID", "VOID", "VOID"])
    assert outcome == "VOID"


def test_5_family_majority_against_not_unanimous_voids():
    outcome, _ = J.decide_appeal("NO", ["YES", "YES", "VOID", "NO", "NO"])
    assert outcome == "VOID"


def test_5_family_exact_half_against_is_not_a_majority_stands():
    outcome, _ = J.decide_appeal("NO", ["YES", "VOID", "NO", "NO", "NO"])
    assert outcome == "NO"


def test_panel_for_round_1_is_a_3_family_panel_no_debate():
    p = J.panel_for_round(1)
    assert len(p["families"]) == 3
    assert p["debate"] is False


def test_panel_for_round_2_is_a_5_family_panel_with_debate():
    p = J.panel_for_round(2)
    assert len(p["families"]) == 5
    assert p["debate"] is True
    p1 = J.panel_for_round(1)
    for f in p1["families"]:
        assert f in p["families"], f"round-2 panel should keep round-1's families: missing {f}"


if __name__ == "__main__":
    test_unanimous_overturns_to_the_new_outcome()
    test_unanimous_affirms_the_standing_outcome()
    test_majority_against_but_not_unanimous_voids()
    test_split_the_other_way_leaves_the_standing_outcome()
    test_unanimous_void_overturns_to_void()
    test_5_family_majority_against_not_unanimous_voids()
    test_5_family_exact_half_against_is_not_a_majority_stands()
    test_panel_for_round_1_is_a_3_family_panel_no_debate()
    test_panel_for_round_2_is_a_5_family_panel_with_debate()
    print("D-DISPUTE1 appeal/panel test: PASS (9/9)")
