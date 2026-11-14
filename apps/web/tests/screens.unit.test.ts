// SHOTS1: screenshots go to gitignored test-results/ unless UPDATE_SCREENS=1.
import test from "node:test";
import assert from "node:assert/strict";
import { screenPath } from "./lib/screens";

test("default mode writes under test-results/screens", () => {
  assert.equal(screenPath("modal1a/modal-1280.png", {}), "test-results/screens/modal1a/modal-1280.png");
});

test("UPDATE_SCREENS=1 writes under docs/screens", () => {
  assert.equal(screenPath("modal1a/modal-1280.png", { UPDATE_SCREENS: "1" }), "docs/screens/modal1a/modal-1280.png");
});

test("any other UPDATE_SCREENS value is default mode", () => {
  assert.equal(screenPath("a/b.png", { UPDATE_SCREENS: "0" }), "test-results/screens/a/b.png");
  assert.equal(screenPath("a/b.png", { UPDATE_SCREENS: "" }), "test-results/screens/a/b.png");
});
