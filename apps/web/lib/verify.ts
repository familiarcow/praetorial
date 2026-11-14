// V1 (familiarcow 2026-11-11: "Do we have any modals for the AI judge? This is important for the verifiability components. We should be
// able to verify the results of every action ... the users should easily be able to get all of their information to verify.")
// Pure builders, no network (data comes from lib/betTxs.ts):
//   judgeVerify      the AI judge's Verify sheet: what it was asked, which program, where it ran, what it said, that the escrow
//                    accepted it. Every item: the value (copyable), a link, one line on how to check it, the exact command.
//   withReceipts     every Activity entry + its on-chain proof (tx hash -> explorer, who signed, who acted, exact amounts moved);
//                    actions the bet record can't show (referee change, each result request, each payout) come from the txs.
//   verificationFile the "Download verification file" JSON; the SAME shape scripts/verify-bet.mjs buildFile writes and checks.
// Wording follows spikes/v1/CLAIMS.md: nothing here says more than the code and chain prove. Raw account ids are allowed here
// (STATES.md V1-1): always @username first, the id under it.
import { sha256 } from "js-sha256";
import { KeyType, PublicKey } from "@near-js/crypto";
import type { Bet } from "./escrowAdapter";
import type { BetDetail, When } from "./betDetail";
import { personName, whenFromMs } from "./betDetail";
import type { ActivityEntry } from "./betView";
import type { BetTx, BetTxKind, ChainFacts } from "./betTxs";
import { formatMoney, money } from "./money";
import { findAsset } from "./assets";
import { fromBaseUnits } from "./decimal";

export const VERIFY_FORMAT = "praetorial-verification/1";
// DOCS1: About's "How to verify a bet" now lives on the Docs verification page (/about#verify redirects there too).
export const ABOUT_VERIFY_HREF = "/docs/verification#verify";
export const SCRIPT_NAME = "verify-bet.mjs";

export interface VerifyCtx {
  network: "mainnet" | "testnet";
  contractId: string;
  names?: Record<string, string | null | undefined>;
  me?: string | null;
  feeAccount?: string | null;
  intents?: string;
  timeZone?: string;
}

// ---------------------------------------------------------------- links, people, amounts
const EXPLORER = { mainnet: "https://nearblocks.io", testnet: "https://testnet.nearblocks.io" };
export const explorerTx = (net: VerifyCtx["network"], hash: string): string => `${EXPLORER[net]}/txns/${encodeURIComponent(hash)}`;
export const explorerAccount = (net: VerifyCtx["network"], account: string): string => `${EXPLORER[net]}/address/${encodeURIComponent(account)}`;

/** A person or service in a Verify view: label first (@username / You / a service name), the raw id under it. */
export interface PersonRef { label: string; account: string }
const SERVICE = /^(relayer|keeper)\.praetorial(?:-dev-\d+)?\.(?:near|testnet)$/;
export function personRef(account: string, ctx: VerifyCtx): PersonRef {
  if (account === ctx.contractId) return { label: "The escrow contract", account };
  if (ctx.feeAccount && account === ctx.feeAccount) return { label: "Praetorial fee account", account };
  if (ctx.intents && account === ctx.intents) return { label: "NEAR Intents", account };
  const s = account.match(SERVICE);
  if (s) return { label: s[1] === "relayer" ? "Praetorial relayer (pays the gas)" : "Praetorial keeper", account };
  if (ctx.me && account === ctx.me) return { label: "You", account };
  return { label: personName(account, ctx.names?.[account] ?? null), account };
}

/** Exact amount in token units ("20.062783 USDC", "0.0200625 NEAR"); an unknown token shows its base units and id. */
export function exactAmount(token: string, units: string): string {
  if (token === "near") return `${fromBaseUnits(units, 24)} NEAR`;
  const m = money(units, token);
  return findAsset(m.symbol) ? formatMoney(m).exact : `${units} base units of ${token}`;
}

const nsToMs = (ns: string): number => Number(BigInt(ns) / 1_000_000n);
const whenNs = (ns: string | undefined, ctx: VerifyCtx): When | null => (ns && /^\d+$/.test(ns) && ns !== "0" ? whenFromMs(nsToMs(ns), { timeZone: ctx.timeZone }) : null);

// ---------------------------------------------------------------- exact JSON + the ruling signature (browser side)
/** JSON.parse keeping every 16+ digit integer as an exact string (u64 ns); digits inside strings are left alone. */
export function parseExact(text: string): any {
  let out = "", i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') { let j = i + 1; while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1; out += text.slice(i, j + 1); i = j + 1; continue; }
    if (c === "-" || (c >= "0" && c <= "9")) { let j = i + 1; while (j < text.length && /[0-9.eE+-]/.test(text[j])) j++; const n = text.slice(i, j); out += /^-?\d{16,}$/.test(n) ? `"${n}"` : n; i = j; continue; }
    out += c; i++;
  }
  return JSON.parse(out);
}

class Borsh {
  private parts: number[] = [];
  u32(v: number | string) { const n = Number(v) >>> 0; this.parts.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255); return this; }
  u64(v: number | string | bigint) { let n = BigInt(String(v)); for (let i = 0; i < 8; i++) { this.parts.push(Number(n & 255n)); n >>= 8n; } return this; }
  string(s: string) { const b = new TextEncoder().encode(String(s)); this.u32(b.length); this.parts.push(...b); return this; }
  bytes() { return Uint8Array.from(this.parts); }
}
/** The exact message the escrow's submit_outcome verifies (services/common/src/resolverSign.ts; scripts/verify-bet.mjs). */
export function outcomeMessage(escrow: string, r: any): Uint8Array {
  const w = new Borsh().string(escrow).u64(r.bet_id).string(r.terms_hash).string(r.outcome).string(r.element_results_hash).u64(r.run_no).u64(r.checked_until ?? 0);
  if (r.judge_pair_index !== undefined && r.judge_pair_index !== null) w.u32(r.judge_pair_index);
  if (r.outcome === "RETRY" || r.outcome === "RETRY:no_live_judge") w.u64(r.next_check_ns);
  const obs: any[] = Array.isArray(r.model_not_found) ? r.model_not_found : [];
  if (obs.length) { w.u32(obs.length); for (const o of obs) w.string(o.model).u64(o.observed_ns); }
  return w.bytes();
}
const hexBytes = (h: string): Uint8Array => Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
export function verifyRulingSig(pubHex: string, sigHex: string, escrow: string, result: any): boolean {
  try {
    if (!/^[0-9a-f]{64}$/i.test(pubHex) || !/^[0-9a-f]{128}$/i.test(sigHex)) return false;
    return new PublicKey({ keyType: KeyType.ED25519, data: hexBytes(pubHex) }).verify(outcomeMessage(escrow, result), hexBytes(sigHex));
  } catch { return false; }
}
export const sha256Hex = (s: string): string => sha256(s);

/** The signed result inside a stored ruling (last_resolution_raw), as exact JSON text. */
export function storedResultJson(raw: string): string | null {
  return raw.match(/"result"\s*:\s*(\{[^{}]*(?:\[[^\]]*\][^{}]*)*\})/)?.[1] ?? null;
}

// ---------------------------------------------------------------- Verify sheet data
export interface VerifyItemData {
  id: string;
  label: string;
  /** The value: copyable. `hash` = short with copy, `text` = inline, `block` = a closed monospace block with copy. */
  value?: string | null;
  valueKind?: "hash" | "text" | "block";
  person?: PersonRef;
  link?: { href: string; text: string } | null;
  /** One line: how to check this. */
  how: string;
  command?: string | null;
  status?: "ok" | "bad" | "info" | "missing";
  statusText?: string;
}
export interface VerifySectionData { id: string; title: string; lead?: string; items: VerifyItemData[] }
export interface VerifySheetData {
  title: string;
  mode: "ai" | "code-audit" | "referee" | "unknown";
  intro: string;
  sections: VerifySectionData[];
  /** What this sheet could not show, in plain words. */
  gaps: string[];
  loading: boolean;
  aboutHref: string;
  scriptCommand: string;
}

export interface JudgeVerifyInput {
  bet: Bet;
  detail: BetDetail;
  /** undefined = still loading; null = the indexer has no tx list for us. */
  txs: BetTx[] | null | undefined;
  facts: ChainFacts | null | undefined;
  release?: { resolverWasmHash: string; models: string[] } | null;
  ctx: VerifyCtx;
}

export const scriptCommand = (betId: number, net: VerifyCtx["network"]): string => `node ${SCRIPT_NAME} ${betId}${net === "mainnet" ? "" : " --network testnet"}`;
const nearView = (escrow: string, method: string, net: string, args = "{}") => `near contract call-function as-read-only ${escrow} ${method} json-args '${args}' network-config ${net} now`;

function parseRaw(raw: string | null | undefined): any {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function judgeVerify(input: JudgeVerifyInput): VerifySheetData {
  const { bet, detail, txs, facts, release, ctx } = input;
  const e = bet.envelope;
  const net = ctx.network;
  const loading = txs === undefined || facts === undefined;
  const gaps: string[] = [];
  const cmd = scriptCommand(e.bet_id, net);
  const base = { aboutHref: ABOUT_VERIFY_HREF, scriptCommand: cmd, loading };
  const txLink = (t: BetTx | undefined | null) => (t ? { href: explorerTx(net, t.hash), text: "Open on NearBlocks" } : null);
  const escrowLink = { href: explorerAccount(net, ctx.contractId), text: "The escrow's transactions on NearBlocks" };
  if (txs === null) gaps.push("This page couldn't load the bet's transaction list from Praetorial's indexer, so transaction hashes are missing below. Every transaction is still on the escrow's NearBlocks page.");
  if (facts === null) gaps.push("This page couldn't read the escrow's keys and settings from NEAR right now. Try again in a minute.");
  const ok = (txs ?? []).filter((t) => t.ok);

  // ---- a person decides: no AI, nothing signed by the resolver
  if (detail.judge.mode === "referee" && e.referee) {
    const ref = personRef(e.referee.account, ctx);
    const rule = ok.find((t) => t.kind === "referee-rule");
    return {
      ...base, title: "Verify who decided", mode: "referee", gaps,
      intro: "A person decides this bet, so no AI is used and there is no AI signature. Their ruling is a NEAR transaction they signed.",
      sections: [
        { id: "who", title: "Who decides", items: [{ id: "referee", label: "Referee", person: ref, value: ref.account, valueKind: "hash", link: { href: explorerAccount(net, ref.account), text: "Their account on NearBlocks" }, how: "This account is written into the bet's terms; only it can rule.", command: nearView(ctx.contractId, "get_bet", net, `{"bet_id":${e.bet_id}}`) }] },
        { id: "ruled", title: "Their ruling", items: [rule
          ? { id: "referee-rule", label: `Ruled ${rule.outcome}`, value: rule.hash, valueKind: "hash", link: txLink(rule), person: personRef(rule.actor, ctx), how: "The escrow only accepts referee_rule from the bet's referee and paid out on this transaction.", status: rule.actor === e.referee.account ? "ok" : "bad", statusText: rule.actor === e.referee.account ? "Signed by the referee" : "Not signed by the referee" }
          : { id: "referee-rule", label: "Ruling", value: null, how: txs === null ? "The transaction list isn't available right now; open the escrow's page to find it." : "No ruling yet.", link: txs === null ? escrowLink : null, status: txs === null ? "missing" : "info" }] },
      ],
    };
  }

  // ---- the AI judge
  const raw = parseRaw(bet.last_resolution_raw);
  const rawText = bet.last_resolution_raw ?? null;
  const resultJson = rawText ? storedResultJson(rawText) : null;
  const result = resultJson ? parseExact(resultJson) : null;
  const sig: string | null = raw?.signing?.signature_hex ?? null;
  const signer: string | null = raw?.signing?.pubkey_hex ?? null;
  const outcomeKey = facts?.outcomeKey ?? null;
  const pinnedHash = facts?.wasmHash ?? release?.resolverWasmHash ?? null;
  const wasmUrl = facts && pinnedHash ? `${facts.wasmBaseUrl}/${pinnedHash}.wasm` : null;
  const reqs = ok.filter((t) => t.kind === "request-result");
  const lastReq = reqs.filter((t) => t.program).at(-1) ?? reqs.at(-1);
  const rulings = ok.filter((t) => t.kind === "ruling");
  const accepted = result ? rulings.find((t) => t.run_no === Number(result.run_no)) : rulings.at(-1);

  // 1. what it was asked
  const asked: VerifyItemData[] = [];
  if (e.terms) {
    const h = sha256Hex(e.terms);
    asked.push({ id: "terms", label: "The bet's terms (exact text)", value: e.terms, valueKind: "block", how: "The terms hash below is the sha256 of exactly this text.", command: cmd });
    asked.push({ id: "terms-hash", label: "Terms hash", value: e.terms_hash, valueKind: "hash", how: "Stored in the escrow with the bet. The judge signs it into its ruling, so a ruling can't be moved to other terms.", command: nearView(ctx.contractId, "get_bet", net, `{"bet_id":${e.bet_id}}`), status: h === e.terms_hash ? "ok" : "bad", statusText: h === e.terms_hash ? "Matches the terms (checked in your browser)" : `Does NOT match: sha256 of the terms is ${h}` });
  } else {
    asked.push({ id: "terms-hash", label: "Terms hash", value: e.terms_hash, valueKind: "hash", how: "Only the fingerprint of this bet's terms is on chain. Whoever made the bet can share the terms; their sha256 must equal this.", status: "info" });
    gaps.push("This bet's terms are not stored on chain (only their hash), so the exact prompt can't be rebuilt here.");
  }
  const j = detail.judge;
  for (const p of j.prompts) asked.push({ id: `prompt-${p.elementId}`, label: `Instructions for question ${p.elementId}`, value: `${p.system}\n\n---\n\n${p.user}`, valueKind: "block", how: j.caveats[0] ?? "Rebuilt from the signed terms with the resolver's own text." });
  if (j.audit) asked.push({ id: "audit", label: "Audit instructions", value: `${j.audit.system}\n\n---\n\n${j.audit.user}`, valueKind: "block", how: j.caveats[1] ?? "The code reads the sources; the AI only audits its result." });
  const fetched: any[] = Array.isArray(raw?.judge?.sources) ? raw.judge.sources : [];
  if (fetched.length) {
    asked.push({ id: "inputs", label: "Pages the judge read (as recorded in its ruling)", value: JSON.stringify(fetched, null, 2), valueKind: "block", how: "Each page's sha256 is recorded at the time it was read; a copy of the page with the same sha256 is what the judge saw." });
  } else if (detail.sources.length) {
    asked.push({ id: "inputs", label: "Sources named in the terms", value: detail.sources.map((s) => `${s.publisher}${s.url ? ` ${s.url}` : ""}`).join("\n"), valueKind: "block", how: "The judge may only use these sources. Their page text is read when the result is requested and is not stored on chain." });
  }

  // 2. which program
  const program: VerifyItemData[] = [{
    id: "wasm-hash", label: "Resolver program fingerprint (sha256)", value: pinnedHash, valueKind: "hash",
    link: wasmUrl ? { href: wasmUrl, text: "Download the program (FastFS)" } : null,
    how: "Pinned in the escrow when it was deployed and can't change. The downloaded file's sha256 must equal it.",
    command: wasmUrl ? `curl -sL ${wasmUrl} | shasum -a 256` : nearView(ctx.contractId, "resolver_keys", net),
    status: facts ? (release && release.resolverWasmHash !== facts.wasmHash ? "bad" : "ok") : "missing",
    statusText: facts ? (release && release.resolverWasmHash !== facts.wasmHash ? "This app expects a different program than the escrow" : "Read from the escrow (resolver_keys)") : "Couldn't read the escrow right now",
  }];
  if (lastReq?.program) {
    const same = lastReq.program.wasm_hash === pinnedHash;
    program.push({ id: "ran", label: "Program OutLayer was asked to run for this bet", value: lastReq.program.wasm_hash, valueKind: "hash", link: txLink(lastReq), how: "In this transaction's logs, OutLayer's execution_requested event names the program by its fingerprint.", status: same ? "ok" : "bad", statusText: same ? "Same program" : "A different program" });
  }
  program.push({ id: "models", label: "AI models", value: j.models.length ? j.models.join(", ") : null, valueKind: "text", how: j.modelsSource === "ruling" ? "As recorded in this bet's ruling. They must be the escrow's first live pair (judge_chain)." : "The escrow's first pair; the ruling records which pair actually answered.", command: nearView(ctx.contractId, "judge_chain", net) });
  program.push({ id: "models-hash", label: "Models snapshot hash", value: e.models_snapshot_hash, valueKind: "hash", how: "Stored in the bet when it opened, so the model list it was opened with can't be swapped later." });

  // 3. where it ran
  const where: VerifyItemData[] = [
    { id: "tee", label: "OutLayer (sealed computer, TEE)", value: "OutLayer", valueKind: "text", link: lastReq ? { href: explorerTx(net, lastReq.hash), text: "OutLayer's log in the run transaction" } : null, how: "The escrow itself asks OutLayer to run the program, by fingerprint. That OutLayer runs it inside a TEE is OutLayer's promise: the escrow doesn't check it.", status: "info" },
    { id: "run-tx", label: "The run (request transaction)", value: lastReq?.hash ?? null, valueKind: "hash", link: lastReq ? txLink(lastReq) : txs === null ? escrowLink : null, person: lastReq ? personRef(lastReq.actor, ctx) : undefined, how: "Its logs show OutLayer's execution_requested (the program) and execution_completed events. The escrow stored the answer it got back.", status: lastReq ? "ok" : txs === undefined ? "info" : "missing", statusText: lastReq ? undefined : txs === undefined ? "Loading…" : txs === null ? "Transaction list unavailable" : "No run yet" },
    { id: "outcome-key", label: "The key that signs rulings (outcome key)", value: outcomeKey, valueKind: "hash", link: escrowLink, how: "Set in the escrow at deploy and can't change. We checked once, at deploy, that OutLayer gives this key only to this program; the escrow doesn't re-check that.", command: nearView(ctx.contractId, "resolver_keys", net), status: outcomeKey ? "ok" : "missing", statusText: outcomeKey ? "Read from the escrow (first value of resolver_keys)" : undefined },
  ];

  // 4. what it said
  const said: VerifyItemData[] = [];
  if (result && sig) {
    const valid = outcomeKey ? verifyRulingSig(outcomeKey, sig, String(raw?.contract ?? ctx.contractId), result) : null;
    said.push({ id: "result", label: `Signed result: ${result.outcome}`, value: resultJson, valueKind: "block", how: "Exactly what the judge signed: bet, terms hash, outcome, a hash of its answers, the check number.", command: cmd });
    said.push({ id: "signature", label: "Signature (ed25519)", value: sig, valueKind: "hash", how: "Valid only for this exact result and the outcome key above.", status: valid == null ? "info" : valid ? "ok" : "bad", statusText: valid == null ? "Checks once the escrow's key is loaded" : valid ? "Checks out (checked in your browser)" : "Does NOT check out against the escrow's key" });
    said.push({ id: "signing-key", label: "Key named in the ruling", value: signer, valueKind: "hash", how: "Must be the escrow's outcome key.", status: outcomeKey && signer ? (signer === outcomeKey ? "ok" : "bad") : "info", statusText: outcomeKey && signer ? (signer === outcomeKey ? "Same as the escrow's outcome key" : "Not the escrow's outcome key") : undefined });
    if (result.terms_hash !== e.terms_hash) said.push({ id: "result-terms", label: "Terms hash inside the ruling", value: String(result.terms_hash), valueKind: "hash", how: "Must equal the bet's terms hash.", status: "bad", statusText: "Not this bet's terms" });
  } else if (raw && !result) {
    said.push({ id: "error", label: "The judge returned no ruling", value: typeof raw.error === "string" ? raw.error : null, valueKind: "text", how: "An error output is stored but never applied; the bet can be judged again.", status: "info" });
  } else {
    said.push({ id: "none", label: "No ruling yet", value: null, how: "Once the result is requested, the judge's signed answer is stored with the bet.", status: "info" });
  }
  if (rawText) said.push({ id: "raw", label: "Full stored ruling (raw)", value: rawText, valueKind: "block", how: "The answer exactly as OutLayer delivered it to the escrow (each model's reply, quotes, timings)." });

  // 5. the escrow accepted it
  const acc: VerifyItemData[] = [];
  if (accepted) acc.push({ id: "submit", label: `Accepted: check ${accepted.run_no}, ${accepted.outcome}`, value: accepted.hash, valueKind: "hash", link: txLink(accepted), person: personRef(accepted.actor, ctx), how: "submit_outcome: the escrow checked the signature against its outcome key before it recorded the ruling. Anyone may send it.", status: "ok" });
  else if (result && sig) acc.push({ id: "submit", label: "Accepted by the escrow", value: null, link: escrowLink, how: txs === undefined ? "Loading the transaction list…" : txs === null ? "The transaction list isn't available right now; the escrow's page lists every submit_outcome." : "Not applied yet: anyone can apply a signed ruling (submit_outcome).", status: txs === undefined ? "info" : "missing" });
  for (const t of rulings.filter((x) => x !== accepted)) acc.push({ id: `submit-${t.run_no}`, label: `Earlier check ${t.run_no}: ${t.outcome}`, value: t.hash, valueKind: "hash", link: txLink(t), how: "An earlier accepted ruling (before a challenge or a retry).", status: "ok" });

  const sections: VerifySectionData[] = [
    { id: "asked", title: "What the judge was asked", items: asked },
    { id: "program", title: "Which program judged", items: program },
    { id: "where", title: "Where it ran", items: where },
    { id: "said", title: "What it said", items: said },
  ];
  if (acc.length) sections.push({ id: "accepted", title: "The escrow accepted it", items: acc });
  return {
    ...base, title: "Verify the AI judge", mode: j.mode === "code-audit" ? "code-audit" : j.mode === "ai" ? "ai" : "unknown", gaps,
    intro: "Everything that decided this bet, with a way to check each part yourself. Values are exact; copy them, or run the checker on the downloaded file.",
    sections,
  };
}

// ---------------------------------------------------------------- Activity receipts
export interface ActionReceiptTx {
  hash: string; href: string; when: When | null; method: string; ok: boolean; signer: PersonRef; actor: PersonRef;
  moved: { dir: "in" | "out"; who: PersonRef; amount: string }[];
}
export interface ActionReceiptData {
  entryId: string;
  title: string;
  state: "found" | "loading" | "missing" | "unavailable";
  txs: ActionReceiptTx[];
  note: string;
  escrowHref: string;
}
export interface ReceiptEntry extends ActivityEntry { receipt: ActionReceiptData }

const ENTRY_KINDS: Array<[RegExp, BetTxKind[]]> = [
  [/^made$/, ["create"]], [/^taken$/, ["take"]], [/^requested$/, ["request-result"]], [/^ruled$/, ["ruling", "referee-rule"]],
  [/^bond-\d+$/, ["challenge"]], [/^rejudged-\d+$/, ["ruling"]], [/^exhibit-\d+$/, ["evidence"]], [/^conceded$/, ["concede"]], [/^cancelled$/, ["cancel"]],
  [/^expired$/, ["expire"]], [/^voided$/, ["refund", "expire"]], [/^final$/, ["finalize"]], [/^paid$/, ["payout", "finalize", "refund"]],
];
const EXTRA_TEXT: Partial<Record<BetTxKind, (t: BetTx, who: string) => string>> = {
  "referee-change": (_t, w) => `${w} asked to change the referee.`,
  "request-result": (_t, w) => `${w} asked the AI for the result.`,
  ruling: (t) => (t.outcome?.startsWith("RETRY") ? `The AI couldn't decide yet and will try again (check ${t.run_no}).` : `The AI ruled ${t.outcome} (check ${t.run_no}).`),
  payout: () => "Payout sent.",
  refund: () => "Refund sent.",
  objection: (_t, w) => `${w} objected.`,
  amend: (_t, w) => `${w} asked to amend the terms.`,
  "extend-window": (_t, w) => `${w} extended the challenge window.`,
  prune: (_t, w) => `${w} asked to remove the stored terms.`,
  reclaim: (_t, w) => `${w} reclaimed their deposit.`,
  evidence: (_t, w) => `${w} added evidence.`,
  challenge: (_t, w) => `${w} challenged the ruling.`,
};

function receiptTx(t: BetTx, ctx: VerifyCtx): ActionReceiptTx {
  return {
    hash: t.hash, href: explorerTx(ctx.network, t.hash), when: whenNs(t.at_ns, ctx), method: t.method, ok: t.ok,
    signer: personRef(t.signer, ctx), actor: personRef(t.actor, ctx),
    moved: [
      ...t.moved_in.map((m) => ({ dir: "in" as const, who: personRef(m.account, ctx), amount: exactAmount(m.token, m.amount) })),
      ...t.moved_out.map((m) => ({ dir: "out" as const, who: personRef(m.account, ctx), amount: exactAmount(m.token, m.amount) })),
    ],
  };
}

/** Pick the txs proving one Activity entry (claims them so no tx is shown twice). */
function claim(entryId: string, txs: BetTx[], used: Set<string>): BetTx[] {
  const kinds = ENTRY_KINDS.find(([re]) => re.test(entryId))?.[1];
  if (!kinds) return [];
  // "paid" = every tx that moved money out, even one already shown (a finalize both ends the bet and pays it)
  if (entryId === "paid") { const p = txs.filter((t) => t.ok && kinds.includes(t.kind) && t.moved_out.length > 0); for (const t of p) used.add(t.hash); return p; }
  const free = txs.filter((t) => t.ok && kinds.includes(t.kind) && !used.has(t.hash));
  let pick: BetTx[];
  if (entryId.startsWith("bond-")) pick = free.filter((t) => t.round === Number(entryId.slice(5))).slice(0, 1);
  else if (entryId.startsWith("exhibit-")) pick = free.slice(0, 1);
  else if (entryId === "cancelled" || entryId === "expired" || entryId === "voided") {
    const main = free.filter((t) => t.kind !== "payout").slice(0, 1);
    pick = main;
  } else if (entryId === "requested") pick = free.slice(-1);
  else pick = free.slice(0, 1);
  for (const t of pick) used.add(t.hash);
  return pick;
}

/**
 * Every Activity entry with its on-chain proof, plus the actions the bet record can't show (referee change, each result request,
 * each later ruling, each payout), in time order. `txs` undefined = loading, null = the indexer's list isn't available.
 */
export function withReceipts(entries: ActivityEntry[], txs: BetTx[] | null | undefined, ctx: VerifyCtx): ReceiptEntry[] {
  const escrowHref = explorerAccount(ctx.network, ctx.contractId);
  const used = new Set<string>();
  const list = txs ?? [];
  const out: ReceiptEntry[] = entries.map((e) => {
    const picked = txs ? claim(e.id, list, used) : [];
    const refused = txs ? list.filter((t) => !t.ok && (ENTRY_KINDS.find(([re]) => re.test(e.id))?.[1] ?? []).includes(t.kind)).length : 0;
    const state: ActionReceiptData["state"] = txs === undefined ? "loading" : txs === null ? "unavailable" : picked.length ? "found" : "missing";
    const note = state === "loading" ? "Loading the transaction…"
      : state === "unavailable" ? "The transaction list isn't available right now. Every transaction is on the escrow's NearBlocks page."
      : state === "missing" ? "No transaction found for this yet. It can take a few minutes to be indexed."
      : refused ? `The escrow refused ${refused} other attempt${refused === 1 ? "" : "s"} at this (not shown).` : "";
    const at = e.at ?? (picked[0] ? nsToMs(picked[0].at_ns) : null);
    return { ...e, at, receipt: { entryId: e.id, title: e.text, state, txs: picked.map((t) => receiptTx(t, ctx)), note, escrowHref } };
  });
  if (txs) {
    for (const t of list) {
      if (!t.ok || used.has(t.hash)) continue;
      const text = EXTRA_TEXT[t.kind];
      if (!text) continue;
      if ((t.kind === "payout" || t.kind === "refund") && !t.moved_out.length) continue;
      const who = personRef(t.actor, ctx).label;
      const id = `tx-${t.kind}-${t.hash.slice(0, 8)}`;
      const sentence = text(t, who);
      used.add(t.hash);
      out.push({ id, at: nsToMs(t.at_ns), text: sentence, receipt: { entryId: id, title: sentence, state: "found", txs: [receiptTx(t, ctx)], note: "", escrowHref } });
    }
  }
  // time order; entries with no time keep their place after the previous timed one
  const keyed = out.map((e, i) => ({ e, i, t: e.at }));
  let last = -Infinity;
  for (const k of keyed) { if (k.t == null) k.t = last; else last = k.t; }
  const sorted = keyed.sort((a, b) => (a.t! - b.t!) || (a.i - b.i)).map((k) => k.e);
  // consecutive identical tx-only rows (the keeper retrying a request) read as one row listing every tx
  const grouped: ReceiptEntry[] = [];
  for (const e of sorted) {
    const prev = grouped.at(-1);
    const base = (x: ReceiptEntry) => x.receipt.title;
    if (prev && prev.id.startsWith("tx-") && e.id.startsWith("tx-") && base(prev) === base(e)) {
      prev.receipt = { ...prev.receipt, txs: [...prev.receipt.txs, ...e.receipt.txs] };
      prev.text = `${base(prev).replace(/\.$/, "")} (${prev.receipt.txs.length} times).`;
      continue;
    }
    grouped.push({ ...e });
  }
  return grouped;
}

// ---------------------------------------------------------------- the verification file (= scripts/verify-bet.mjs buildFile)
export interface VerificationFileInput {
  network: VerifyCtx["network"]; escrow: string; betId: number; betText: string; keys: string[];
  olc: { wasm_base_url: string } | null; codeHashB58: string | null; txs: BetTx[];
  models?: Record<string, unknown> | null; generatedAt?: string | null;
}
export function verificationFile(i: VerificationFileInput): Record<string, unknown> {
  const bet = parseExact(i.betText);
  const e = bet.envelope;
  const rulings: any[] = [];
  for (const t of i.txs ?? []) if (t.kind === "ruling" && t.ok && t.signed) rulings.push({ run_no: t.run_no, source: "submit_outcome", tx_hash: t.hash, result_json: t.signed.result_json, signature_hex: t.signed.signature_hex });
  if (typeof bet.last_resolution_raw === "string") {
    const m = storedResultJson(bet.last_resolution_raw);
    const raw = parseRaw(bet.last_resolution_raw);
    if (m && raw?.signing?.signature_hex && !rulings.some((r) => r.run_no === raw.result?.run_no)) {
      rulings.push({ run_no: raw.result.run_no, source: "stored", tx_hash: null, result_json: m, signature_hex: raw.signing.signature_hex, pubkey_hex: raw.signing.pubkey_hex ?? null });
    } else if (m && raw?.signing?.pubkey_hex) {
      const r = rulings.find((x) => x.run_no === raw.result?.run_no);
      if (r) r.pubkey_hex = raw.signing.pubkey_hex;
    }
  }
  return {
    format: VERIFY_FORMAT,
    network: i.network ?? null,
    generated_at: i.generatedAt ?? null,
    bet_id: i.betId,
    escrow: { account: i.escrow, code_hash_b58: i.codeHashB58 },
    terms: e.terms ?? null,
    terms_hash: e.terms_hash,
    referee: e.referee ?? null,
    resolver: { outcome_pubkey: i.keys[0], attest_pubkey: i.keys[1], wasm_hash: i.keys[2], wasm_url: i.olc ? `${i.olc.wasm_base_url}/${i.keys[2]}.wasm` : null },
    models: { models_snapshot_hash: e.models_snapshot_hash ?? null, ...(i.models ?? {}) },
    rulings: rulings.sort((a, b) => Number(a.run_no) - Number(b.run_no)),
    exhibits: bet.exhibits ?? [],
    transactions: i.txs ?? [],
    get_bet_text: i.betText,
  };
}

export const verificationFileName = (betId: number, net: VerifyCtx["network"]): string => `praetorial-bet-${betId}${net === "mainnet" ? "" : "-testnet"}-verification.json`;

/** When the bet's on-chain record changes in a way that adds transactions, the tx list is fetched again. */
export function verifyRefreshKey(bet: Bet | null): string | null {
  if (!bet) return null;
  const b: any = bet;
  return [bet.status, bet.outcome ?? "", bet.taker ?? "", (b.all_results ?? []).length, (bet.bonds ?? []).length, (bet.exhibits ?? []).length, b.runs_used ?? 0, b.envelope?.referee?.account ?? ""].join(":");
}
