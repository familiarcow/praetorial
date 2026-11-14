"""Shared mini test runner (house style: plain asserts, no pytest). check() = must pass (exit 1 if not);
gap() = a design finding the engine does NOT satisfy today -- it stays RED, is listed, and never skipped."""
import sys, traceback
class Report:
    def __init__(self, name): self.name, self.n_pass, self.fails, self.reds = name, 0, [], []
    def check(self, name, fn):
        try:
            fn(); self.n_pass += 1; print("ok    %s" % name)
        except Exception:
            self.fails.append(name); print("FAIL  %s\n%s" % (name, traceback.format_exc(limit=3)))
    def gap(self, name, fn, why):
        """fn() should return True once the engine closes the gap. Until then it is RED (expected)."""
        try: closed = bool(fn())
        except Exception: closed = False
        if closed: self.n_pass += 1; print("ok    GAP-CLOSED %s" % name)
        else: self.reds.append((name, why)); print("RED   %s -- %s" % (name, why))
    def done(self):
        print("\n%s: %d passed, %d failed, %d RED (known engine gaps)" % (self.name, self.n_pass, len(self.fails), len(self.reds)))
        for n, w in self.reds: print("  RED:", n)
        sys.exit(1 if self.fails else 0)
