import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvFile } from "../src/envFile.js";

test("parseEnvFile: comments, export prefix, quotes, blanks, = inside values", () => {
  const env = parseEnvFile(`# c\n\nA=1\nexport B="two words"\nC='x'\nD=a=b\n  E = spaced  \nBAD LINE\n`);
  assert.deepEqual(env, { A: "1", B: "two words", C: "x", D: "a=b", E: "spaced" });
});

test("parseEnvFile: empty value stays empty string (treated as unset by check)", () => {
  assert.deepEqual(parseEnvFile("A=\n"), { A: "" });
});
