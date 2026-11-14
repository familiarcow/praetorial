// FE2 / S1b: username rules (mirror of services/registry/src/rules.ts, parity test-enforced against the SAME fixture
// list), plain-English messages for every refusal, and the live availability check (GET /search).
export const RESERVED = ["praetorial", "admin", "support", "referee", "ai", "guardian"];

export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}
/** Look-alike fold: rn->m first, then 0->o, 1->l, i->l, 5->s. */
export function foldUsername(name: string): string {
  return normalizeUsername(name).replace(/rn/g, "m").replace(/[01i5]/g, (c) => ({ "0": "o", "1": "l", i: "l", "5": "s" } as Record<string, string>)[c]);
}
export type UsernameError = "too_short" | "too_long" | "bad_chars" | "reserved";
export function validateUsername(raw: string): UsernameError | null {
  const n = normalizeUsername(raw);
  if (!/^[a-z0-9_]*$/.test(n)) return "bad_chars";
  if (n.length < 3) return "too_short";
  if (n.length > 20) return "too_long";
  const f = foldUsername(n);
  if (RESERVED.some((r) => foldUsername(r) === f)) return "reserved";
  return null;
}

export const USERNAME_RULES: string[] = [
  "3 to 20 characters.",
  "Letters, digits and underscore only. No spaces.",
  "Not case-sensitive: Alice and alice are the same name.",
  "Names that look like someone else's (a1ice for alice) are refused.",
  "A few names are kept for Praetorial itself.",
];

export function usernameErrorMessage(code: UsernameError): string {
  switch (code) {
    case "too_short": return "Use at least 3 characters.";
    case "too_long": return "Use 20 characters or fewer.";
    case "bad_chars": return "Use only letters, digits and underscore (no spaces).";
    case "reserved": return "That name can't be used. Pick a different one.";
  }
}

/** A valid alternative to a refused name (never the input itself). */
export function suggestUsername(name: string): string {
  const base = normalizeUsername(name).replace(/[^a-z0-9_]/g, "").slice(0, 17) || "user";
  for (let i = 2; i < 100; i++) {
    const s = `${base}_${i}`;
    if (s !== normalizeUsername(name) && validateUsername(s) === null) return s;
  }
  return `${base.slice(0, 10)}_${Date.now() % 1000}`;
}

export const REGISTRY_DOWN_MESSAGE =
  "We can't reach usernames right now. You can look around; betting needs a username, so try again in a moment.";

export type ClaimFailure = { ok: false; error: string; status?: number };
export type ClaimMessageKind = "taken" | "reserved" | "invalid" | "rate_limited" | "signature" | "down";

/** Map a claimUsername failure to a user message (taken carries a suggestion). */
export function claimErrorMessage(r: ClaimFailure, attempted: string): { kind: ClaimMessageKind; message: string; suggestion?: string } {
  switch (r.error) {
    case "username_taken": {
      const suggestion = suggestUsername(attempted);
      return { kind: "taken", message: `That name is taken. Try ${suggestion}.`, suggestion };
    }
    case "username_reserved": return { kind: "reserved", message: "That name can't be used. Pick a different one." };
    case "invalid_username": return { kind: "invalid", message: "That name isn't valid. Use 3 to 20 letters, digits or underscores." };
    case "rate_limited": return { kind: "rate_limited", message: "Too many tries. Wait a minute and try again." };
  }
  if (r.error.startsWith("signature_failed")) return { kind: "signature", message: "We need your approval to save the name. Approve the request and try again." };
  return { kind: "down", message: REGISTRY_DOWN_MESSAGE };
}

export type Availability = { state: "free" } | { state: "taken" } | { state: "lookalike"; of: string } | { state: "invalid" } | { state: "unknown" };

/** Live check via the registry's GET /search (it folds look-alikes). The claim's 409 stays the authority. */
export async function checkAvailability(baseUrl: string, raw: string, opts: { myAccount?: string; fetchImpl?: typeof fetch } = {}): Promise<Availability> {
  const name = normalizeUsername(raw);
  if (validateUsername(name) !== null) return { state: "invalid" };
  const f = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  try {
    const res = await f(baseUrl.replace(/\/+$/, "") + `/search?q=${encodeURIComponent(name)}`);
    if (!res.ok) return { state: "unknown" };
    const rows = (await res.json()) as { username: string; account_tail: string }[];
    const others = rows.filter((r) => !opts.myAccount || r.account_tail !== opts.myAccount);
    if (others.some((r) => r.username.toLowerCase() === name)) return { state: "taken" };
    const alike = others.find((r) => foldUsername(r.username) === foldUsername(name));
    if (alike) return { state: "lookalike", of: alike.username };
    return { state: "free" };
  } catch { return { state: "unknown" }; }
}
