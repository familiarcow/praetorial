// TFIX2: what the top-level crash screen (src/CrashBoundary.tsx) says and links to. A render error anywhere used to unmount the whole
// app (a plain white page: the theme's CSS variables live inside the React tree). Now the user gets one sentence, a Reload button and,
// on a bet page, that bet's link; the error goes to the console. Pure, so node tests cover it.

export const CRASH_COPY = {
  title: "Something went wrong. Reload",
  body: "The page hit an error while showing this screen. Your money and bets are not affected: anything you sent is already on NEAR.",
  reload: "Reload",
};

/** On /bet/<id> (query kept, so an invite link still works after the reload): the bet's own link. Anywhere else: null. */
export function crashBetLink(pathname: string, search: string): { href: string; label: string } | null {
  const m = /^\/bet\/(\d+)\/?$/.exec(pathname);
  if (!m) return null;
  return { href: `/bet/${m[1]}${search}`, label: `Open bet #${m[1]}` };
}

/** One console line: the error and React's component stack (where it threw). */
export function crashLogLine(error: unknown, componentStack: string | null | undefined): string {
  const what = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return `[praetorial] render crashed: ${what}${componentStack ? componentStack : ""}`;
}
