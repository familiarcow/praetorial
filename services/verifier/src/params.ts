// PA1b / D-PARAMS1: E2 params replay.
// The escrow's fee_bps and per-asset min_fee_per_side / min_per_side / max_per_side are guardian-adjustable for NEW bets
// (propose_params -> >=24h -> apply_params). This module replays the escrow's own event log on top of the new() values
// and requires the current views to equal the result, every apply to be >=24h after its proposal, and every value to
// respect the contract's hard caps. Pure functions: callers inject the views and the event log (recorded or live).

export interface ParamsAssetChange { asset_id: string; min_fee_per_side: string | null; min_per_side: string | null; max_per_side: string | null }
export interface ParamsEventData { fee_bps: number | null; assets: ParamsAssetChange[]; proposed_at_ns: string; effective_at_ns: string }
export interface ParamsEvent { kind: "proposed" | "applied" | "cancelled"; data: ParamsEventData; /** block ns of the receipt that logged it */ atNs: string; txHash?: string }
export interface ParamsReceipt { block_timestamp: string; ok: boolean; logs: string[]; tx_hash?: string }
export interface ParamsViews { protocol_fee_bps: number; asset_limit: Record<string, any | null>; pending_params: any | null }
export interface ParamsVerdict { status: "PASS" | "FAIL"; problems: string[]; summary: string }

/** Mirrors contracts/escrow/src/lib.rs (a test greps the Rust source so these cannot drift silently). */
export const PARAMS_DELAY_NS = 86_400_000_000_000n;
export const MAX_FEE_BPS = 200;
export const INITIAL_FEE_BPS = 100; // PROTOCOL_FEE_BPS_V1: new() always starts here

/** JSON.parse that keeps u64 ns numbers (>2^53) as exact digit strings. */
export function parseBigJson(text: string): any {
  return JSON.parse(text.replace(/("[A-Za-z_0-9]+"\s*:\s*)(\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
}

const KINDS: Record<string, ParamsEvent["kind"]> = { params_proposed: "proposed", params_applied: "applied", params_cancelled: "cancelled" };

/** NEP-297 `EVENT_JSON:` lines of standard praetorial-escrow from SUCCESSFUL receipts, in block order. */
export function extractParamsEvents(receipts: ParamsReceipt[]): ParamsEvent[] {
  const out: { e: ParamsEvent; t: bigint; i: number }[] = [];
  for (const r of receipts) {
    if (!r.ok) continue;
    for (const l of r.logs ?? []) {
      if (!l.startsWith("EVENT_JSON:")) continue;
      let j: any;
      try { j = parseBigJson(l.slice("EVENT_JSON:".length)); } catch { continue; }
      if (j?.standard !== "praetorial-escrow" || !(j.event in KINDS)) continue;
      const d = j.data?.[0];
      if (!d) continue;
      out.push({ i: out.length, t: BigInt(r.block_timestamp), e: { kind: KINDS[j.event], data: { fee_bps: d.fee_bps ?? null, assets: d.assets ?? [], proposed_at_ns: String(d.proposed_at_ns), effective_at_ns: String(d.effective_at_ns) }, atNs: String(r.block_timestamp), txHash: r.tx_hash } });
    }
  }
  return out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.i - b.i)).map((x) => x.e);
}

interface Lim { minFee: bigint; min: bigint; max: bigint; cap: bigint }
const canon = (d: { fee_bps: number | null; assets: ParamsAssetChange[] }, p: string, e: string) =>
  JSON.stringify([d.fee_bps ?? null, [...d.assets].map((a) => [a.asset_id, a.min_fee_per_side ?? null, a.min_per_side ?? null, a.max_per_side ?? null]).sort(), String(p), String(e)]);

export function checkParams(i: { newArgs: Record<string, any>; views: ParamsViews; events: ParamsEvent[] }): ParamsVerdict {
  const problems: string[] = [];
  const limits = new Map<string, Lim>();
  const initialMinFee = new Map<string, bigint>();
  for (const [id, l] of (i.newArgs.asset_limits ?? []) as [string, any][]) {
    const minFee = BigInt(l.min_fee_per_side ?? 0);
    const cap = BigInt(l.min_fee_cap_per_side ?? 0);
    initialMinFee.set(id, minFee);
    limits.set(id, { minFee, min: BigInt(l.min_per_side), max: BigInt(l.max_per_side), cap: cap === 0n ? minFee : cap }); // cap 0 = pinned at the initial min fee
  }
  let fee = INITIAL_FEE_BPS;
  let pending: ParamsEventData | null = null;
  let applied = 0, cancelled = 0, proposed = 0;

  /** Hard-cap validation of a change against the CURRENT replayed config (as the contract does); returns the merged limits. */
  const merged = (d: ParamsEventData, ctx: string): Map<string, Lim> => {
    const p = (m: string) => problems.push(`${ctx}: ${m}`);
    if (d.fee_bps === null && d.assets.length === 0) p("empty params change");
    if (d.fee_bps !== null && d.fee_bps > MAX_FEE_BPS) p(`fee_bps ${d.fee_bps} exceeds the hard cap ${MAX_FEE_BPS}`);
    const next = new Map(limits);
    for (const a of d.assets) {
      const cur = limits.get(a.asset_id);
      if (!cur) { p(`unknown asset ${a.asset_id} (not in new() asset_limits)`); continue; }
      const n: Lim = { ...cur, minFee: a.min_fee_per_side !== null ? BigInt(a.min_fee_per_side) : cur.minFee, min: a.min_per_side !== null ? BigInt(a.min_per_side) : cur.min, max: a.max_per_side !== null ? BigInt(a.max_per_side) : cur.max };
      if (n.minFee <= 0n) p(`${a.asset_id} min_fee_per_side must be > 0`);
      if (n.minFee > cur.cap) p(`${a.asset_id} min_fee_per_side ${n.minFee} exceeds the per-asset cap ${cur.cap} pinned at new()`);
      if (n.min > n.max) p(`${a.asset_id} min_per_side ${n.min} > max_per_side ${n.max}`);
      if (n.minFee > n.min / 20n) p(`${a.asset_id} min_fee_per_side ${n.minFee} > min_per_side/20 (${n.min / 20n})`);
      next.set(a.asset_id, n);
    }
    return next; // replay continues after a violation so the view comparison below is still meaningful
  };
  const claim24h = (d: ParamsEventData, ctx: string) => {
    if (BigInt(d.effective_at_ns) - BigInt(d.proposed_at_ns) < PARAMS_DELAY_NS) problems.push(`${ctx}: effective_at_ns is < 24h after proposed_at_ns`);
  };

  for (const [n, e] of i.events.entries()) {
    const ctx = `event #${n + 1} params_${e.kind}${e.txHash ? ` (${e.txHash})` : ""}`;
    const d = e.data;
    if (e.kind === "proposed") {
      proposed++;
      if (pending) problems.push(`${ctx}: proposed while another change was still pending`);
      claim24h(d, ctx);
      merged(d, ctx);
      pending = d;
    } else if (!pending) {
      problems.push(`${ctx}: no pending proposal in the log`);
    } else {
      if (canon(d, d.proposed_at_ns, d.effective_at_ns) !== canon(pending, pending.proposed_at_ns, pending.effective_at_ns)) problems.push(`${ctx}: payload differs from the pending proposal`);
      if (e.kind === "applied") {
        claim24h(d, ctx);
        const t = BigInt(e.atNs);
        if (t < BigInt(pending.proposed_at_ns) + PARAMS_DELAY_NS) problems.push(`${ctx}: applied ${BigInt(pending.proposed_at_ns) + PARAMS_DELAY_NS - t} ns before the 24h delay elapsed (applied < 24h after proposal)`);
        if (t < BigInt(pending.effective_at_ns)) problems.push(`${ctx}: applied before effective_at_ns`);
        const next = merged(pending, ctx);
        if (pending.fee_bps !== null) fee = pending.fee_bps;
        for (const [k, v] of next) limits.set(k, v);
        applied++;
      } else cancelled++;
      pending = null;
    }
  }

  // current views vs replay
  const v = i.views;
  if (v.protocol_fee_bps > MAX_FEE_BPS) problems.push(`viewed protocol_fee_bps ${v.protocol_fee_bps} exceeds the hard cap ${MAX_FEE_BPS}`);
  if (v.protocol_fee_bps !== fee) problems.push(`protocol_fee_bps view ${v.protocol_fee_bps} != replay of new() + applied changes ${fee}`);
  for (const [id, want] of limits) {
    const got = v.asset_limit?.[id];
    if (got === null || got === undefined) { problems.push(`asset_limit view for ${id} missing`); continue; }
    const cmp = (field: string, w: bigint, g: unknown) => { if (String(g) !== w.toString()) problems.push(`${id} ${field} view ${g} != replay ${w}`); };
    cmp("min_fee_per_side", want.minFee, got.min_fee_per_side);
    cmp("min_per_side", want.min, got.min_per_side);
    cmp("max_per_side", want.max, got.max_per_side);
    const gc = BigInt(got.min_fee_cap_per_side ?? 0);
    cmp("min_fee_cap_per_side", want.cap, gc === 0n ? initialMinFee.get(id)! : gc);
    if (BigInt(got.min_fee_per_side) > want.cap) problems.push(`${id} viewed min_fee_per_side ${got.min_fee_per_side} exceeds the per-asset cap ${want.cap}`);
    if (BigInt(got.min_per_side) > BigInt(got.max_per_side)) problems.push(`${id} viewed min_per_side > max_per_side`);
    if (BigInt(got.min_fee_per_side) > BigInt(got.min_per_side) / 20n) problems.push(`${id} viewed min_fee_per_side > min_per_side/20`);
  }
  const vp = v.pending_params;
  if (!pending && vp !== null && vp !== undefined) problems.push("pending_params view is set but the log has no outstanding proposal");
  else if (pending && (vp === null || vp === undefined)) problems.push("log has an outstanding proposal but the pending_params view is empty");
  else if (pending && vp) {
    if (canon({ fee_bps: vp.change?.fee_bps ?? null, assets: vp.change?.assets ?? [] }, vp.proposed_at_ns, vp.effective_at_ns) !== canon(pending, pending.proposed_at_ns, pending.effective_at_ns)) problems.push("pending_params view differs from the outstanding proposal in the log");
    if (BigInt(vp.effective_at_ns) - BigInt(vp.proposed_at_ns) < PARAMS_DELAY_NS) problems.push("pending_params view: effective_at_ns is < 24h after proposed_at_ns");
  }

  const summary = `${proposed} proposed, ${applied} applied, ${cancelled} cancelled, ${pending ? "1 pending" : "none pending"}; current fee_bps ${v.protocol_fee_bps} and ${limits.size} asset limit(s) equal new() + applied changes in order, all >=24h after proposal, within hard caps`;
  return { status: problems.length ? "FAIL" : "PASS", problems, summary: problems.length ? problems.join("; ") : summary };
}
