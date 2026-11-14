// MODAL1c5: pure helpers for the username / add money (move) / withdraw flow modals.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MOVE_STEPS, WITHDRAW_STEPS, MOVE_DRAFT_KEY, WITHDRAW_DRAFT_KEY, moveTerms, withdrawTerms, parseWithdrawAmount, accountFlowPhase,
} from "../lib/accountFlows";

const ME = "11".repeat(32);

test("steps: move is one confirm step; withdraw is amount then confirm; draft keys are per asset", () => {
  assert.deepEqual(MOVE_STEPS.map((s) => s.id), ["confirm"]);
  assert.deepEqual(WITHDRAW_STEPS.map((s) => s.id), ["amount", "confirm"]);
  assert.notEqual(WITHDRAW_DRAFT_KEY("USDC"), WITHDRAW_DRAFT_KEY("NEAR"));
  assert.notEqual(MOVE_DRAFT_KEY("NEAR", "token"), MOVE_DRAFT_KEY("NEAR", "native"));
});

test("moveTerms: names the amount, asset, where it goes and that there is no fee", () => {
  const t = moveTerms({ symbol: "USDC", source: "token", amountUnits: "7000000" });
  assert.equal(t.amountText, "7.00 USDC");
  assert.equal(t.confirmLabel, "Move to betting"); // M1 (UIR1 §3.6): short label, the amount is in the body
  const all = t.lines.join(" ");
  assert.match(all, /7\.00 USDC/);
  assert.match(all, /betting balance/);
  assert.match(all, /no fee/i);
});

test("moveTerms: native NEAR says it is wrapped first and that 0.05 NEAR stays in the account", () => {
  const t = moveTerms({ symbol: "NEAR", source: "native", amountUnits: "2000000000000000000000000" });
  assert.equal(t.amountText, "2 NEAR");
  const all = t.lines.join(" ");
  assert.match(all, /wrapped/i);
  assert.match(all, /0\.05 NEAR/);
});

test("parseWithdrawAmount: blank, zero, junk -> plain message; over balance -> plain message; good -> base units", () => {
  const bal = "3000000000000000000000000";
  for (const raw of ["", "  ", "0", "0.0", "abc", "-1"]) assert.deepEqual(parseWithdrawAmount("NEAR", raw, bal), { ok: false, message: "Enter an amount to withdraw." });
  assert.deepEqual(parseWithdrawAmount("NEAR", "4", bal), { ok: false, message: "That's more than your betting balance." });
  assert.deepEqual(parseWithdrawAmount("NEAR", "1", bal), { ok: true, units: "1000000000000000000000000" });
  assert.deepEqual(parseWithdrawAmount("NEAR", " 3 ", bal), { ok: true, units: bal });
  assert.deepEqual(parseWithdrawAmount("NEAR", "1", null), { ok: true, units: "1000000000000000000000000" });
});

test("withdrawTerms: amount, asset, destination wallet, no fee, and the registration + wrapped-NEAR notes", () => {
  const t = withdrawTerms("USDC", "3000000", ME);
  assert.equal(t.amountText, "3.00 USDC");
  assert.equal(t.confirmLabel, "Withdraw"); // M1 (UIR1 §3.6): short label, the amount is in the body
  const all = t.lines.join(" ");
  assert.match(all, /3\.00 USDC/);
  assert.match(all, /betting balance/);
  // M1 (UIR1 §3.6 "Account -> your wallet"): the user's own account is named, the 64-char id is not printed over 2 lines
  assert.match(all, /your NEAR account/);
  assert.ok(!all.includes(ME));
  assert.match(all, /no fee/i);
  assert.match(all, /registered/i);
  assert.doesNotMatch(all, /wrapped NEAR/);
  const n = withdrawTerms("NEAR", "1000000000000000000000000", ME);
  assert.equal(n.amountText, "1 NEAR");
  assert.match(n.lines.join(" "), /wrapped NEAR/);
});

test("accountFlowPhase: only a clean outcome is success; an unknown outcome is 'checking' (pending, SM2 F5-2), never a failure; everything else is a failure", () => {
  assert.equal(accountFlowPhase("checking"), "pending");
  assert.equal(accountFlowPhase("moved"), "success");
  assert.equal(accountFlowPhase("withdrawn"), "success");
  assert.equal(accountFlowPhase("failed"), "failure");
  assert.equal(accountFlowPhase("refused"), "failure");
  assert.equal(accountFlowPhase("whatever"), "failure");
});
