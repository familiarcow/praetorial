// MODAL1c1b: while a flow's send is in flight, browser Back must not leave the flow's URL (the result screen would be lost).
let guarded: string | null = null;

export function setNavGuard(url: string): void { guarded = url; }
/** Clear the guard. With `owner`, only if it is still the url that set it. */
export function clearNavGuard(owner?: string): void { if (owner === undefined || owner === guarded) guarded = null; }
/** The url to stay on while guarded, else null. */
export function guardedUrl(): string | null { return guarded; }
