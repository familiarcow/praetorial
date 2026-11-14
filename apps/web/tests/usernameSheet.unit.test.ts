// A1 (UIR1 §3.9): the "Pick a username" sheet's view model: one title, one live availability line, rules collapsed unless the typed
// name breaks one, Save only for a valid name that is free (or unknown: the claim is the authority).
import { test } from "node:test";
import assert from "node:assert/strict";
import { usernameSheetView, USERNAME_SHEET_TITLE, type SheetStatus } from "../lib/usernameSheet";

const v = (raw: string, status: SheetStatus, o: { busy?: boolean; current?: string } = {}) => usernameSheetView({ raw, status, busy: !!o.busy, current: o.current ?? null });

test("titles: first claim 'Pick a username', rename 'Change username' (no full stops, no step labels)", () => {
  assert.equal(USERNAME_SHEET_TITLE.pick, "Pick a username");
  assert.equal(USERNAME_SHEET_TITLE.change, "Change username");
  assert.equal(v("", { kind: "idle" }).title, "Pick a username");
  assert.equal(v("", { kind: "idle" }, { current: "bob" }).title, "Change username");
});

test("rules stay collapsed until the typed name breaks one", () => {
  assert.equal(v("", { kind: "idle" }).rulesOpen, false);
  assert.equal(v("alice", { kind: "avail", a: { state: "free" }, name: "alice" }).rulesOpen, false);
  const bad = v("al ice", { kind: "local", text: "Use only letters, digits and underscore (no spaces)." });
  assert.equal(bad.rulesOpen, true);
  assert.equal(bad.line, "Use only letters, digits and underscore (no spaces).");
  assert.equal(bad.tone, "bad");
  assert.equal(bad.canSave, false);
});

test("the live line: checking / available / taken / look-alike / unknown / same name", () => {
  assert.deepEqual([v("alice", { kind: "checking" }).line, v("alice", { kind: "checking" }).canSave], ["Checking…", false]);
  const free = v("Alice", { kind: "avail", a: { state: "free" }, name: "alice" });
  assert.deepEqual([free.line, free.tone, free.canSave], ["@alice is available", "good", true]);
  const taken = v("alice", { kind: "avail", a: { state: "taken" }, name: "alice" });
  assert.match(taken.line, /^That name is taken\. Try /);
  assert.equal(taken.canSave, false);
  assert.equal(v("a1ice", { kind: "avail", a: { state: "lookalike", of: "alice" }, name: "a1ice" }).line, "That name looks too much like @alice. Pick a different one.");
  const unk = v("alice", { kind: "avail", a: { state: "unknown" }, name: "alice" });
  assert.equal(unk.canSave, true, "unknown: the claim decides");
  const same = v("bob", { kind: "avail", a: { state: "free" }, name: "bob" }, { current: "Bob" });
  assert.deepEqual([same.line, same.canSave], ["That is already your username.", false]);
  assert.equal(v("alice", { kind: "avail", a: { state: "free" }, name: "alice" }, { busy: true }).canSave, false, "never twice");
});

test("save label: 'Save username' / 'Change username' / 'Saving…'", () => {
  const ok = { kind: "avail", a: { state: "free" }, name: "alice" } as const;
  assert.equal(v("alice", ok).saveLabel, "Save username");
  assert.equal(v("alice", ok, { current: "bob" }).saveLabel, "Change username");
  assert.equal(v("alice", ok, { busy: true }).saveLabel, "Saving…");
});
