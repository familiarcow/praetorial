// SRCW1 (4): the shared sheet linter (the web builder's port of the resolver lint; parity-pinned by apps/web/tests/lintParity).
// Byte-identical vendored copy in services/common/src/sheetLint (apps/web/lib is outside the services tsc rootDir; drift is a test failure). Returns the named problems; [] = valid.
import { lintAnySheet } from "../../../common/src/sheetLint/templates.js";

export function sharedLint(terms: string): string[] {
  let sheet: unknown;
  try { sheet = JSON.parse(terms); } catch { return ["TERMS_NOT_JSON: the term sheet must be JSON"]; }
  if (sheet === null || typeof sheet !== "object" || Array.isArray(sheet)) return ["TERMS_NOT_OBJECT: the term sheet must be a JSON object"];
  try { return lintAnySheet(sheet); } catch (e: any) { return [`LINT_ERROR: ${String(e?.message ?? e)}`]; }
}
