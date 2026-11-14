// F5 (FUND4 SPEC §7.2): the browser checks cash-out addresses and the payload it is asked to sign with EXACTLY the funding
// Worker's code. lib/funding/chainAddress.ts and lib/funding/intentCheck.ts are byte copies of services/common/src/funding/*
// (like lib/nep413.ts): this test fails the moment either side changes without the other.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

for (const f of ["chainAddress.ts", "intentCheck.ts"]) {
  test(`lib/funding/${f} is byte-identical to services/common/src/funding/${f}`, () => {
    const web = readFileSync(new URL(`../../lib/funding/${f}`, import.meta.url), "utf8");
    const svc = readFileSync(new URL(`../../../../services/common/src/funding/${f}`, import.meta.url), "utf8");
    assert.equal(web, svc);
  });
}
