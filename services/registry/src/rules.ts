export const RESERVED = ["praetorial", "admin", "support", "referee", "ai", "guardian"];

export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}
/** Look-alike fold: rn->m first, then 0->o, 1->l, i->l, 5->s. Used for uniqueness, search and reserved checks. */
export function foldUsername(name: string): string {
  return normalizeUsername(name).replace(/rn/g, "m").replace(/[01i5]/g, (c) => ({ "0": "o", "1": "l", i: "l", "5": "s" } as Record<string, string>)[c]);
}
export type UsernameError = "too_short" | "too_long" | "bad_chars" | "reserved";
/** Returns an error code, or null if the (normalized) name is acceptable. Does NOT check uniqueness. */
export function validateUsername(raw: string): UsernameError | null {
  const n = normalizeUsername(raw);
  if (!/^[a-z0-9_]*$/.test(n)) return "bad_chars";
  if (n.length < 3) return "too_short";
  if (n.length > 20) return "too_long";
  const f = foldUsername(n);
  if (RESERVED.some((r) => foldUsername(r) === f)) return "reserved";
  return null;
}
/** Public account hint: last 8 chars for implicit (64-hex) accounts, the full id for named accounts. */
export function accountTail(id: string): string {
  return /^[0-9a-f]{64}$/.test(id) ? id.slice(-8) : id;
}
