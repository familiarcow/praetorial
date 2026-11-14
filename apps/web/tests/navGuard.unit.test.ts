// MODAL1c1b: while a flow's send is in flight, browser Back must not leave the flow's URL.
import test from "node:test";
import assert from "node:assert/strict";
import { setNavGuard, clearNavGuard, guardedUrl } from "../lib/navGuard";

test("no guard: Back is free", () => { clearNavGuard(); assert.equal(guardedUrl(), null); });
test("guard set: returns the url to stay on", () => { setNavGuard("/new"); assert.equal(guardedUrl(), "/new"); clearNavGuard(); });
test("cleared guard: Back is free again", () => { setNavGuard("/new"); clearNavGuard(); assert.equal(guardedUrl(), null); });
test("clearing a different owner's guard does not drop the live one", () => {
  setNavGuard("/new"); clearNavGuard("/other"); assert.equal(guardedUrl(), "/new"); clearNavGuard("/new"); assert.equal(guardedUrl(), null);
});
