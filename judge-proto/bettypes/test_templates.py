"""Lint-only check: every one of the 12 bet-type term sheets (3 prototypes + 7 templates) is writable under J.lint.
Templates are NOT resolvable end to end yet -- that is the point of the verdict table. Run from judge-proto/."""
import os, sys, glob, json
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import judge as J
from bettypes.test_common import Report
r = Report("templates")
files = sorted(glob.glob(os.path.join(HERE, "templates", "*.json"))) + [os.path.join(HERE, p) for p in ("social_post/term_sheet.json", "polymarket/term_sheet.json", "github_release/term_sheet.json")]
for f in files:
    t = json.load(open(f))
    r.check("lint clean: " + os.path.relpath(f, HERE), lambda t=t: (_ for _ in ()).throw(AssertionError(J.lint(t))) if J.lint(t) else None)
r.check("12 sheets: social_post, polymarket, github_release + 9 templates (x oembed is a variant of social_post, counted separately in the doc)", lambda: None if len(files) == 12 else (_ for _ in ()).throw(AssertionError(len(files))))
r.done()
