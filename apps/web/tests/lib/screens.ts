// SHOTS1: where spec screenshots go. Default is gitignored test-results/ so test runs keep the tree clean;
// set UPDATE_SCREENS=1 to regenerate the tracked docs/screens/** PNGs.
export function screenPath(rel: string, env: Record<string, string | undefined> = process.env): string {
  return `${env.UPDATE_SCREENS === "1" ? "docs/screens" : "test-results/screens"}/${rel}`;
}
