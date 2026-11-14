// DOCS1 (familiarcow via b0nd 11-12): the Docs section that replaced About: its pages and URLs. Pure (no imports) so lib/router.ts stays
// light. Facts and command blocks: lib/docsFacts.ts. Page bodies: src/components/docs/*.tsx. Claims: spikes/docs1/CLAIMS.md.

export type DocsPageId = "what" | "verification" | "intents" | "trust" | "hackathon";

export interface DocsPage { id: DocsPageId; slug: string; title: string; blurb: string }

/** Nav order. "trust" has its own entry (EXTENSION: the concrete, skeptic-facing page); the others stay high level. */
export const DOCS_PAGES: readonly DocsPage[] = [
  { id: "what", slug: "", title: "What Praetorial is", blurb: "One-on-one bets, judged by AI, paid out by a contract" },
  { id: "verification", slug: "verification", title: "How a result is verified", blurb: "Why nobody, us included, can fix the result" },
  { id: "intents", slug: "near-intents", title: "NEAR Intents", blurb: "Bet in several tokens, add money from several chains" },
  { id: "trust", slug: "trust", title: "Trust and verification", blurb: "What you trust, and how to check each part yourself" },
  { id: "hackathon", slug: "hackathon", title: "Hackathon", blurb: "What is built, what is live, how to run it" },
];

export function docsPath(id: DocsPageId): string {
  const p = DOCS_PAGES.find((d) => d.id === id)!;
  return p.slug ? `/docs/${p.slug}` : "/docs";
}
