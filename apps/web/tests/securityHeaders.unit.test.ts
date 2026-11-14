// SECREV1 SR-4: the static HTML (served by Workers static assets, not worker/index.ts) gets security headers from public/_headers
// (Vite copies public/ into dist/; Workers static assets applies dist/_headers). A script-restricting CSP is NOT here yet: it needs a
// live check against Privy / WalletConnect / RPC origins (REPORT SR-4 open part).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");

test("SECREV1 SR-4: public/_headers sets no-framing, nosniff and a referrer policy for every path", () => {
  const p = join(web, "public", "_headers");
  assert.ok(existsSync(p), "apps/web/public/_headers exists");
  const lines = readFileSync(p, "utf8").split("\n");
  assert.equal(lines[0], "/*", "rules apply to every path");
  const h = new Map(lines.slice(1).filter((l) => /^\s+\S/.test(l)).map((l) => { const i = l.indexOf(":"); return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()] as const; }));
  assert.equal(h.get("x-content-type-options"), "nosniff");
  assert.equal(h.get("x-frame-options"), "DENY");
  assert.match(h.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.match(h.get("content-security-policy") ?? "", /object-src 'none'/);
  assert.match(h.get("content-security-policy") ?? "", /base-uri 'self'/);
  assert.equal(h.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.doesNotMatch(readFileSync(join(web, "vite.config.ts"), "utf8"), /publicDir\s*:\s*false/, "Vite still copies public/ into dist/");
});
