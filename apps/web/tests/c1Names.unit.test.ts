// C1 (PM 2026-11-12, flaky payout-refund.spec.ts:102): a person whose @username is still being looked up is LOADING ("…"), not
// "Unnamed account". "Unnamed account" is only for an account the registry answered for with no username (or when no registry is
// configured, or the lookup failed). Names maps: a key present with value undefined = lookup in flight; absent = never asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { person, personLabel, NAME_LOADING } from "../lib/betView";
import { namesWithPending } from "../lib/betNames";
import { NO_USERNAME } from "../lib/appState";

test("loading vs unnamed vs named", () => {
  assert.equal(personLabel(person("ref.near", null, { "ref.near": undefined })), NAME_LOADING);
  assert.equal(NAME_LOADING, "…");
  assert.equal(personLabel(person("ref.near", null, { "ref.near": null })), NO_USERNAME);
  assert.equal(personLabel(person("ref.near", null, {})), NO_USERNAME); // never asked (no registry): unnamed, not loading forever
  assert.equal(personLabel(person("ref.near", null, { "ref.near": "ref" })), "@ref");
  assert.equal(personLabel(person("me.near", "me.near", { "me.near": undefined })), "You"); // me is never loading
});

test("namesWithPending: accounts not answered yet are marked loading from the FIRST render (no 'Unnamed account' flash)", () => {
  const cache = new Map<string, string | null>([["a.near", "alice"], ["n.near", null]]);
  const got = namesWithPending(["a.near", "n.near", "x.near"], {}, cache, true);
  assert.deepEqual(got, { "a.near": "alice", "n.near": null, "x.near": undefined });
  assert.ok("x.near" in got);
  // a lookup that landed in state wins
  assert.deepEqual(namesWithPending(["x.near"], { "x.near": "xavier" }, new Map(), true), { "x.near": "xavier" });
  // no registry configured: nobody is loading (they stay unnamed)
  assert.deepEqual(namesWithPending(["x.near"], {}, new Map(), false), {});
});
