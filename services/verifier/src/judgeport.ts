// V1b / D-VER2: TypeScript port of the resolver's judge checks that verify-bet B4 re-applies offline.
// Twins: resolver/core/src/lib.rs (norm, quote_key, quote_in, quote_len_ok, extract_answer_json, verify_inner,
// registrable_domain, origin_groups, element_verdict_q, parse_sse_chat) and judge-proto/judge.py. Parity is asserted by
// the shared fixtures: resolver/core/tests/fixtures/quote_key.json (J4 quote key) and
// services/verifier/test/fixtures/b4_parity.json (origin/quorum rules; also run by judge.py and Rust core).
// Ported, not invented: any change here must change the Rust/Python twin and the fixtures in the same commit.

export const TRUNCATED_RAW = "\u0000praetorial:truncated finish_reason=length";
const ANSWERS = ["met", "not_met", "insufficient", "conflict"];
const MIN_QUOTE_CHARS = 12;
const MIN_LABELLED_QUOTE_CHARS = 6;

/** core `norm`: NFKC, curly quotes folded, Unicode Cf stripped, whitespace collapsed, lowercased. */
export function norm(s: string): string {
  let t = (s ?? "").normalize("NFKC");
  t = t.replace(/\u2019/g, "'").replace(/\u2018/g, "'").replace(/\u201c/g, '"').replace(/\u201d/g, '"');
  t = t.replace(/\p{Cf}/gu, "");
  return t.trim().replace(/\s+/gu, " ").toLowerCase();
}

const isAlnum = (ch: string) => /[\p{Alphabetic}\p{N}]/u.test(ch);
const isDigit = (ch: string | undefined) => ch !== undefined && ch >= "0" && ch <= "9" && ch.length === 1;

/** core `quote_key` (J4): numbers are delimited tokens kept intact; everything else keeps only alphanumerics. */
export function quoteKey(s: string): string {
  const t = norm(s).replace(/&amp;/g, "&").replace(/\u2212/g, "-").replace(/\[\d+\]|\[[a-z]\]/g, "");
  const c = Array.from(t);
  const n = c.length;
  const dg = (i: number) => i < n && isDigit(c[i]);
  let out = "";
  let i = 0;
  while (i < n) {
    const ch = c[i];
    const prevAlnum = i > 0 && isAlnum(c[i - 1]);
    let start = false;
    if ((ch === "+" || ch === "-") && !prevAlnum && (dg(i + 1) || (i + 2 < n && c[i + 1] === "." && dg(i + 2)))) start = true;
    else if (isDigit(ch)) start = true;
    else if (ch === "." && !prevAlnum && dg(i + 1)) start = true;
    if (start) {
      let j = i;
      if (c[j] === "+" || c[j] === "-") j++;
      if (j < n && c[j] === ".") j++;
      while (dg(j)) j++;
      while (j + 1 < n && (c[j] === "." || c[j] === "," || c[j] === ":") && dg(j + 1)) {
        j++;
        while (dg(j)) j++;
      }
      out += "\u0001" + c.slice(i, j).join("") + "\u0001";
      i = j;
    } else {
      if (isAlnum(ch)) out += ch;
      i++;
    }
  }
  return out;
}

export function quoteIn(quote: string, page: string): boolean {
  const k = quoteKey(quote);
  return k.length > 0 && quoteKey(page).includes(k);
}

export function quoteLenOk(qNorm: string): boolean {
  const n = Array.from(qNorm).length;
  return n >= MIN_QUOTE_CHARS || (n >= MIN_LABELLED_QUOTE_CHARS && /[0-9]/.test(qNorm) && /\p{Alphabetic}/u.test(qNorm));
}

/** core `extract_answer_json`: last top-level {...} after an optional <think> block. */
export function extractAnswerJson(raw: string): string | null {
  let body = raw.replace(/^\s+/u, "");
  if (body.startsWith("<think>")) {
    const rest = body.slice("<think>".length);
    const i = rest.indexOf("</think>");
    if (i < 0) return null;
    body = rest.slice(i + "</think>".length);
  }
  let depth = 0, start = 0, inStr = false, esc = false;
  let last: [number, number] | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (depth === 0) {
      if (c === "{") { depth = 1; start = i; inStr = false; esc = false; }
      continue;
    }
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) last = [start, i + 1]; }
  }
  return last ? body.slice(last[0], last[1]) : null;
}

export interface SrcRec {
  id: string; url?: string; final_url?: string; publisher?: string; origin?: string;
  party_controlled?: boolean; curated?: boolean; sha256?: string;
}

function jsonLaneCheck(text: string, field: string, value: unknown): boolean {
  let cur: any;
  try { cur = JSON.parse(text.trim()); } catch { return false; }
  for (const part of field.split(".")) {
    if (/^\d+$/.test(part) && Array.isArray(cur) && Number(part) < cur.length) cur = cur[Number(part)];
    else if (cur && typeof cur === "object" && !Array.isArray(cur) && part in cur) cur = cur[part];
    else return false;
  }
  const show = (v: unknown) => (typeof v === "string" ? v.trim() : JSON.stringify(v));
  return show(cur) === show(value);
}

export interface VerifyOut { result: string; ids: string | null; reason?: string; quoteChecked: boolean; quotes: number }

/**
 * core `verify` (verify_inner). `textOf(id)` returns the exact reader text of a source, or undefined when it was not
 * supplied; then the quote-in-source test cannot run and the answer is only schema/cited-source checked
 * (quoteChecked=false) -- the caller must report that as NOT verified.
 */
export function verifyAnswer(raw: string, srcs: SrcRec[], textOf: (id: string) => string | undefined): VerifyOut {
  const no = (result: string, reason: string, quoteChecked = true): VerifyOut => ({ result, ids: null, reason, quoteChecked, quotes: 0 });
  if (raw === TRUNCATED_RAW) return no("invalid", "truncated (finish_reason length)");
  if (raw.trim() === "") return no("empty", "no response (transport failure)");
  const m = extractAnswerJson(raw);
  if (m === null) return no("invalid", "unparseable output");
  let o: any;
  try { o = JSON.parse(m); } catch { return no("invalid", "unparseable output"); }
  const a = o?.answer;
  if (typeof a !== "string" || !ANSWERS.includes(a)) return no("invalid", `answer not in schema: ${JSON.stringify(a)}`);
  if (a !== "met" && a !== "not_met") return { result: a, ids: null, quoteChecked: true, quotes: 0 };
  const sid = typeof o.source_id === "string" ? o.source_id : undefined;
  const quoteRaw: string = typeof o.quote === "string" ? o.quote : "";
  const qNorm = norm(quoteRaw);
  const src = sid !== undefined ? srcs.find((s) => s.id === sid) : undefined;
  if (!src) return no("invalid", `cited unknown source ${sid}`);
  let checked = true;
  let quotes = 0;
  const text = textOf(src.id);
  if (qNorm === "" && typeof o.field === "string" && "value" in o) {
    if (text === undefined) return { result: a, ids: sid!, quoteChecked: false, quotes: 0 };
    return jsonLaneCheck(text, o.field, o.value) ? { result: a, ids: sid!, quoteChecked: true, quotes: 1 } : no("invalid", "field/value not found in JSON source");
  }
  if (!quoteLenOk(qNorm)) return no("invalid", "quote too short");
  if (text === undefined) checked = false;
  else if (!quoteIn(quoteRaw, text)) return no("invalid", "quote not found verbatim in source");
  else quotes++;
  const ids = [sid!];
  if (Array.isArray(o.also)) {
    for (const c of o.also) {
      const csid = c && typeof c === "object" && typeof c.source_id === "string" ? c.source_id : undefined;
      const cq: string = c && typeof c === "object" && typeof c.quote === "string" ? c.quote : "";
      const csrc = csid !== undefined ? srcs.find((s) => s.id === csid) : undefined;
      if (!csrc || !quoteLenOk(norm(cq))) return no("invalid", "corroborating quote not found verbatim in its source");
      const ct = textOf(csrc.id);
      if (ct === undefined) checked = false;
      else if (!quoteIn(cq, ct)) return no("invalid", "corroborating quote not found verbatim in its source");
      else quotes++;
      ids.push(csid!);
    }
  }
  return { result: a, ids: ids.join(","), quoteChecked: checked, quotes };
}

// ---------------------------------------------------------------- origins (D-ORIGIN1 / D-EXH1)
export function sourceOrigin(s: SrcRec): string {
  if (typeof s.origin === "string" && s.origin !== "") return s.origin.trim().toLowerCase();
  return (s.publisher ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
}

export function registrableDomain(url: string): string | null {
  const rest = url.split("://")[1];
  if (rest === undefined) return null;
  let auth = rest.split(/[/?#]/)[0];
  auth = auth.split("@").pop()!;
  let host = auth.startsWith("[") ? auth.split("]")[0].replace(/^\[/, "") : auth.split(":")[0];
  host = host.replace(/\.+$/, "").toLowerCase();
  if (host === "") return null;
  if (/^[0-9.]+$/.test(host) || host.includes(":")) return host;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const SLD = ["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go", "gob", "nom", "ltd", "plc"];
  const n = labels.length;
  const take = labels[n - 1].length === 2 && SLD.includes(labels[n - 2]) ? 3 : 2;
  return labels.slice(n - Math.min(take, n)).join(".");
}

export function originGroups(sources: SrcRec[]): number[] {
  const ids = new Map<string, number>();
  const parent: number[] = [];
  const find = (x: number): number => { let r = x; while (parent[r] !== r) r = parent[r]; let c = x; while (parent[c] !== r) { const nx = parent[c]; parent[c] = r; c = nx; } return r; };
  const node = (k: string): number => { let v = ids.get(k); if (v === undefined) { parent.push(parent.length); v = parent.length - 1; ids.set(k, v); } return v; };
  const first: number[] = [];
  for (const s of sources) {
    const url = s.final_url && s.final_url !== "" ? s.final_url : s.url;
    const label = `o:${sourceOrigin(s)}`;
    const d = url !== undefined ? registrableDomain(url) : null;
    let main: number;
    if (d !== null) {
      main = node(`d:${d}`);
      const l = node(label);
      parent[find(main)] = find(l);
    } else main = node(label);
    first.push(main);
  }
  const roots: number[] = [];
  return first.map((nd) => { const r = find(nd); let i = roots.indexOf(r); if (i < 0) { roots.push(r); i = roots.length - 1; } return i; });
}

/** core `element_verdict_q`: quorum=true is D-ORIGIN1 (custom sources) / D-EXH1 (exhibits); false is the curated-lane rule. */
export function elementVerdictQ(resultsIn: [string, string | null][], sources: SrcRec[], quorum: boolean): string {
  const results = resultsIn.filter((r) => r[0] !== "empty");
  if (results.length === 0) return "unresolved";
  if (results.some((r) => r[0] === "invalid")) return "unresolved";
  const mapped = results.map((r) => [r[0] === "not_met" ? "not_proven" : r[0], r[1]] as [string, string | null]);
  const groups = quorum ? originGroups(sources) : [];
  const cited = (r: [string, string | null]): Set<number> => {
    const out = new Set<number>();
    for (const id of (r[1] ?? "").split(",")) { const i = sources.findIndex((s) => s.id === id); if (i >= 0) out.add(groups[i]); }
    return out;
  };
  const union = (rs: [string, string | null][]) => new Set(rs.flatMap((r) => [...cited(r)]));
  const answers = new Set(mapped.map((r) => r[0]));
  if (answers.size > 1) {
    if (quorum && answers.has("met") && answers.has("not_proven")) {
      const m = union(mapped.filter((r) => r[0] === "met"));
      const nn = union(mapped.filter((r) => r[0] === "not_proven"));
      const same = m.size === nn.size && [...m].every((x) => nn.has(x));
      if (m.size > 0 && nn.size > 0 && !same) return "conflict";
    }
    return "unresolved";
  }
  const a = mapped[0][0];
  if (a === "met" || a === "not_proven") {
    const used = new Set(mapped.flatMap((r) => (r[1] ?? "").split(",")));
    if (a === "met" && !sources.some((s) => used.has(s.id) && !(s.party_controlled === true))) return "unresolved";
    if (quorum && union(mapped).size < 2) return "insufficient";
  }
  return a;
}

/** core `parse_sse_chat` content assembly (only what B4 needs: concatenated delta.content). */
export function sseContent(text: string): string {
  let content = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const d = line.slice(5).trim();
    if (d === "[DONE]") continue;
    let j: any;
    try { j = JSON.parse(d); } catch { continue; }
    if (Array.isArray(j?.choices)) for (const c of j.choices) if (typeof c?.delta?.content === "string") content += c.delta.content;
  }
  return content;
}
