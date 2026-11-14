// F1 (FUND4 SPEC §5.2, §7.2): parse a 1Click /v0/generate-intent `swap_transfer` NEP-413 payload and assert it is EXACTLY one
// `transfer` of `amountIn` of `originAsset` from the user to the quote's deposit address inside intents.near, signed by the user,
// expiring no later than the quote. Anything else (extra intent, other token, other amount, other receiver, msg/state_init,
// callbackUrl, a later deadline) is refused: we never hand a user a payload we have not parsed. Shared by the funding Worker
// and the web (apps/web/lib/funding/intentCheck.ts re-exports it), so both refuse identically.
// Pure + host-neutral: js-sha256 only (no node:crypto, so it runs in the Worker and the browser).
import { sha256 } from "js-sha256";

export const INTENTS_CONTRACT = "intents.near";
export const NEP413_TAG = 2 ** 31 + 413;

export interface IntentExpect {
  /** the user's intents account (64-hex implicit id on mainnet) */
  signerId: string;
  depositAddress: string;
  /** the token id leaving the user's intents balance, e.g. "nep141:usdt.tether-token.near" */
  originAsset: string;
  /** exact base units */
  amountIn: string;
  /** epoch ms; the signed deadline must not be later (the quote's deadline) */
  maxDeadlineMs: number;
  /** epoch ms; the signed deadline must still be in the future */
  nowMs: number;
}
export interface Nep413PayloadJson { message: string; nonce: string; recipient: string; callbackUrl?: string | null }
export type IntentCheck =
  | { ok: true; payload: Nep413PayloadJson; message: { signer_id: string; deadline: string; intents: unknown[] } }
  | { ok: false; problems: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).filter((k) => !allowed.includes(k));

function b64decode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); } catch { return null; }
}

export function checkSwapTransferIntent(intent: unknown, e: IntentExpect): IntentCheck {
  const p: string[] = [];
  if (!isObj(intent)) return { ok: false, problems: ["intent is not an object"] };
  const extraTop = onlyKeys(intent, ["standard", "payload"]);
  if (extraTop.length) p.push(`unexpected intent fields: ${extraTop.join(",")}`);
  if (intent.standard !== "nep413") p.push(`standard is ${JSON.stringify(intent.standard)}, expected nep413`);
  const payload = intent.payload;
  if (!isObj(payload)) return { ok: false, problems: [...p, "payload is not an object"] };
  const extraPayload = onlyKeys(payload, ["message", "nonce", "recipient", "callbackUrl"]);
  if (extraPayload.length) p.push(`unexpected payload fields: ${extraPayload.join(",")}`);
  if (payload.callbackUrl !== undefined && payload.callbackUrl !== null) p.push("payload has a callbackUrl");
  if (payload.recipient !== INTENTS_CONTRACT) p.push(`payload recipient is ${JSON.stringify(payload.recipient)}, expected ${INTENTS_CONTRACT}`);
  const nonce = typeof payload.nonce === "string" ? b64decode(payload.nonce) : null;
  if (!nonce || nonce.length !== 32) p.push("payload nonce is not 32 bytes of base64");
  if (typeof payload.message !== "string") return { ok: false, problems: [...p, "payload message is not a string"] };
  let m: unknown;
  try { m = JSON.parse(payload.message); } catch { return { ok: false, problems: [...p, "payload message is not JSON"] }; }
  if (!isObj(m)) return { ok: false, problems: [...p, "message is not an object"] };
  const extraMsg = onlyKeys(m, ["signer_id", "deadline", "intents"]);
  if (extraMsg.length) p.push(`unexpected message fields: ${extraMsg.join(",")}`);
  if (m.signer_id !== e.signerId) p.push(`signer_id is ${JSON.stringify(m.signer_id)}, expected ${e.signerId}`);
  const dl = typeof m.deadline === "string" ? Date.parse(m.deadline) : NaN;
  if (!Number.isFinite(dl)) p.push("deadline is missing or not a date");
  else {
    if (dl > e.maxDeadlineMs) p.push(`deadline ${m.deadline} is later than the quote deadline`);
    if (dl <= e.nowMs) p.push(`deadline ${m.deadline} has passed`);
  }
  const intents = m.intents;
  if (!Array.isArray(intents) || intents.length !== 1) p.push(`expected exactly 1 intent, got ${Array.isArray(intents) ? intents.length : "none"}`);
  else {
    const t = intents[0];
    if (!isObj(t)) p.push("intent[0] is not an object");
    else {
      const extra = onlyKeys(t, ["intent", "receiver_id", "tokens", "memo"]);
      if (extra.length) p.push(`unexpected transfer fields: ${extra.join(",")}`);
      if (t.intent !== "transfer") p.push(`intent[0] is ${JSON.stringify(t.intent)}, expected transfer`);
      if (t.receiver_id !== e.depositAddress) p.push(`receiver_id is ${JSON.stringify(t.receiver_id)}, expected the quote deposit address`);
      if (t.memo !== undefined && t.memo !== null && typeof t.memo !== "string") p.push("memo is not a string");
      if (!isObj(t.tokens)) p.push("tokens is not an object");
      else {
        const ids = Object.keys(t.tokens);
        if (ids.length !== 1 || ids[0] !== e.originAsset) p.push(`tokens are ${JSON.stringify(ids)}, expected only ${e.originAsset}`);
        else if (t.tokens[e.originAsset] !== e.amountIn) p.push(`amount is ${JSON.stringify(t.tokens[e.originAsset])}, expected ${e.amountIn}`);
      }
    }
  }
  if (p.length) return { ok: false, problems: p };
  return { ok: true, payload: payload as unknown as Nep413PayloadJson, message: m as any };
}

function borshString(s: string): Uint8Array {
  const b = new TextEncoder().encode(s), out = new Uint8Array(4 + b.length);
  new DataView(out.buffer).setUint32(0, b.length, true); out.set(b, 4); return out;
}

/** NEP-413 hash of a JSON payload (nonce base64), byte-identical to services/common/src/nep413.ts hashNep413. */
export function hashNep413Payload(p: Nep413PayloadJson): Uint8Array {
  const nonce = b64decode(p.nonce);
  if (!nonce || nonce.length !== 32) throw new Error("nep413 nonce must be exactly 32 bytes");
  const tag = new Uint8Array(4); new DataView(tag.buffer).setUint32(0, NEP413_TAG, true);
  const cb = p.callbackUrl == null ? new Uint8Array([0]) : (() => { const s = borshString(p.callbackUrl!); const o = new Uint8Array(1 + s.length); o[0] = 1; o.set(s, 1); return o; })();
  const parts = [tag, borshString(p.message), nonce, borshString(p.recipient), cb];
  const buf = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0; for (const x of parts) { buf.set(x, o); o += x.length; }
  return new Uint8Array(sha256.arrayBuffer(buf));
}
