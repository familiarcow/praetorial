// Praetorial conformance audit -- NOT ENFORCED claims.
//
// STANDING TEST POLICY (familiarcow, 2026-11-03): a NOT ENFORCED claim is a
// real gap, not a thing to hide. These tests run for real (no
// `node:test` `skip` option) and FAIL until the claim is closed one of
// two ways: (a) the gap is fixed and the claim is re-tested as
// ENFORCED+TESTED elsewhere, moving its test out of this file; or (b) a
// recorded decision says the behavior is deliberately out of scope, in
// which case this test is rewritten to assert THAT decided design
// (green) and, if real enforcement moved elsewhere (e.g. app layer),
// the actual enforcing test lives there -- never left here pretending
// to pass. `tests/conformance/run.sh` runs this suite as a normal
// failing gate (exits non-zero while any claim here is still open) and
// reports each failing claim by ID.
//
// Each test names its claim ID; see the conformance
// matrix (internal design notes) for the full writeup, evidence and blast-radius ranking.
//
// Local only. No testnet/mainnet/NEAR AI calls.
//
// CM-18b (1y self-paid offer TTL tier) closed 2026-11-04 per Decision
// register D-TTL1: the two-tier TTL claim is dropped, not fixed in
// code. Its test was rewritten to assert the single-ceiling design
// against the real contract and moved to
// `tests/conformance/escrow_conformance` (behavioural, reaches the
// real contract via `mt_on_transfer`), per that crate's existing
// pattern for ENFORCED+TESTED claims. No claim is currently open in
// this file; it is kept as the standing NOT ENFORCED gate for the next
// one.
import { test } from "node:test";

// No open NOT ENFORCED claims right now. A real one, when found, gets
// a `test(...)` block here that fails until it's closed -- never a
// `test.skip`.
void test;
