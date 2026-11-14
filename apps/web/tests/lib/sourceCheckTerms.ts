// C1: the review no longer prints the terms fingerprint (UIR1 §3.4, familiarcow UX-37 #5). Specs that pinned "the sheet the app built IS the
// canonical sheet" read the terms the app actually sends to the source check (the exact text that is hashed and signed at Open).
import type { Page } from "@playwright/test";
import { createHash } from "node:crypto";

/** Starts recording; returns a getter for the sha256 of every `terms` the page POSTed to the source check, in order. */
export function recordSourceCheckHashes(page: Page): () => string[] {
  const hashes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "POST" || !/\/sourcecheck\b/.test(r.url())) return;
    try {
      const terms = JSON.parse(r.postData() ?? "{}").terms;
      if (typeof terms === "string") hashes.push(createHash("sha256").update(terms).digest("hex"));
    } catch { /* not JSON */ }
  });
  return () => [...hashes];
}
