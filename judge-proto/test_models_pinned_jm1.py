"""JM1 (D-JUDGE6): judge.lint rejects a non-empty `models` field. Mirrors resolver/core/tests/jm1_lint.rs.
    python3 test_models_pinned_jm1.py   (or pytest)"""
import copy, json, os
import judge as J

PROBLEM = "models: judge models are pinned by the resolver (D-JUDGE6); to fix: remove the models field from the sheet"
FX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "resolver", "core", "tests", "fixtures", "lint.json")


def _good():
    cases = json.load(open(FX))["cases"]
    return copy.deepcopy(next(c["ts"] for c in cases if c["name"] == "baseline_passes_lint"))


def test_baseline_has_no_models_problem():
    assert not [p for p in J.lint(_good()) if p.startswith("models:")]


def test_rejects_non_empty_models():
    for m in (["X"], ["A", "B"], ["mock"], "X", {"a": 1}):
        ts = _good(); ts["models"] = m
        assert PROBLEM in J.lint(ts), (m, J.lint(ts))


def test_allows_absent_or_empty_models():
    ts = _good(); ts["models"] = []
    assert not [p for p in J.lint(ts) if p.startswith("models:")]


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f(); print("ok", n)
