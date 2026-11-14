// A1 (UIR1 §3.10): ONE page Notice at a time, by priority shutdown > out-of-date > offline > paused > busy > connection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageNotice, PAGE_NOTICE_ORDER } from "../lib/pageNotice";
import { COPY } from "../lib/globalStates";

const base = { paused: false, shutdown: false, offline: false, busySeconds: 0, outOfDate: false, viewFailed: false };

test("pageNotice: nothing wrong -> no notice", () => {
  assert.equal(pageNotice(base), null);
});

test("pageNotice: the order is shutdown > out-of-date > offline > paused > busy > connection", () => {
  assert.deepEqual(PAGE_NOTICE_ORDER, ["shutdown", "out-of-date", "offline", "paused", "busy", "connection"]);
  const all = { paused: true, shutdown: true, offline: true, busySeconds: 3, outOfDate: true, viewFailed: true };
  assert.equal(pageNotice(all)!.kind, "shutdown");
  assert.equal(pageNotice({ ...all, shutdown: false })!.kind, "out-of-date");
  assert.equal(pageNotice({ ...all, shutdown: false, outOfDate: false })!.kind, "offline");
  assert.equal(pageNotice({ ...base, paused: true, busySeconds: 3, viewFailed: true })!.kind, "paused");
  assert.equal(pageNotice({ ...base, busySeconds: 3, viewFailed: true })!.kind, "busy");
  assert.equal(pageNotice({ ...base, viewFailed: true })!.kind, "connection");
});

test("pageNotice: tone and wording come from the one copy table; the paused line is inside it (no second note)", () => {
  const s = pageNotice({ ...base, shutdown: true })!;
  assert.deepEqual([s.tone, s.text], ["bad", COPY.shutdown]);
  const p = pageNotice({ ...base, paused: true })!;
  assert.deepEqual([p.tone, p.text], ["warn", COPY.paused]);
  assert.match(p.text, /can't make or take a bet/);
  assert.equal(pageNotice({ ...base, offline: true })!.tone, "warn");
  assert.equal(pageNotice({ ...base, outOfDate: true })!.tone, "warn");
  assert.equal(pageNotice({ ...base, viewFailed: true })!.tone, "info");
  // out of date carries its one fix (reload); nothing else has a button
  assert.equal(pageNotice({ ...base, outOfDate: true })!.fix, "reload");
  assert.equal(pageNotice({ ...base, paused: true })!.fix, null);
});
