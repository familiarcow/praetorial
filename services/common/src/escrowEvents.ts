// JC1x (D-JUDGECHAIN1a S3): NEP-297 event parser + governance replay (guardian + judge chain) shared by the verifier,
// indexer and monitor. Pure functions; no network.
export const EVENT_STANDARD = "praetorial-escrow";

export interface EscrowEvent { event: string; version: string; data: Record<string, any> }

/** Parses `EVENT_JSON:{standard,version,event,data:[{...}]}` log lines; ignores anything else (incl. other standards). */
export function parseEscrowEvents(lines: string[]): EscrowEvent[] {
  const out: EscrowEvent[] = [];
  for (const l of lines) {
    if (typeof l !== "string" || !l.startsWith("EVENT_JSON:")) continue;
    let j: any;
    try { j = JSON.parse(l.slice("EVENT_JSON:".length)); } catch { continue; }
    if (!j || j.standard !== EVENT_STANDARD || typeof j.event !== "string" || !Array.isArray(j.data) || j.data.length < 1) continue;
    out.push({ event: j.event, version: String(j.version), data: j.data[0] ?? {} });
  }
  return out;
}

export interface JudgePair { model_a: string; model_b: string }
export interface PendingAssetEv { token_id: string; reenable: boolean; limit: Record<string, string>; effective_at_ns: number | string }
export interface Governance {
  guardian: string; pendingGuardian: string | null; chain: JudgePair[]; pendingPair: JudgePair | null;
  /** AS1: token ids in the asset table (initial + applied; append-only). Empty when `initial.assets` was not supplied. */
  assets: string[]; disabledAssets: string[]; pendingAsset: PendingAssetEv | null; problems: string[];
}
/** AS1 (D-ASSET1): the contract's propose->apply delay for assets, in ns (24h). */
export const ASSET_DELAY_NS = 24n * 3600n * 1_000_000_000n;

const samePair = (a: JudgePair, b: JudgePair) => (a.model_a === b.model_a && a.model_b === b.model_b) || (a.model_a === b.model_b && a.model_b === b.model_a);

/** Replays guardian rotation and judge-chain events from the initial `new()` state; reports every inconsistency. */
export function replayGovernance(initial: { guardian: string; chain: JudgePair[]; assets?: string[] }, events: EscrowEvent[]): Governance {
  const g: Governance = { guardian: initial.guardian, pendingGuardian: null, chain: initial.chain.map((p) => ({ ...p })), pendingPair: null, assets: [...(initial.assets ?? [])], disabledAssets: [], pendingAsset: null, problems: [] };
  const knowAssets = initial.assets !== undefined;
  const bad = (m: string) => g.problems.push(m);
  for (const e of events) {
    const d = e.data;
    switch (e.event) {
      case "guardian_proposed":
        if (d.guardian !== g.guardian) bad(`guardian_proposed by ${d.guardian}, current guardian is ${g.guardian}`);
        g.pendingGuardian = d.proposed ?? null;
        break;
      case "guardian_rotated":
        if (!g.pendingGuardian) bad("guardian_rotated with no pending proposal");
        else if (d.guardian !== g.pendingGuardian) bad(`guardian_rotated to ${d.guardian}, pending was ${g.pendingGuardian}`);
        if (d.old_guardian !== g.guardian) bad(`guardian_rotated old_guardian ${d.old_guardian} != ${g.guardian}`);
        g.guardian = d.guardian; g.pendingGuardian = null;
        break;
      case "guardian_cancelled":
        if (!g.pendingGuardian) bad("guardian_cancelled with nothing pending");
        g.pendingGuardian = null;
        break;
      case "judge_pair_proposed":
        if (g.pendingPair) bad("judge_pair_proposed while another is pending");
        if (g.chain.length >= 12) bad("judge_pair_proposed on a full chain");
        g.pendingPair = { model_a: d.model_a, model_b: d.model_b };
        break;
      case "judge_pair_applied": {
        const p = { model_a: d.model_a, model_b: d.model_b };
        if (!g.pendingPair || !samePair(g.pendingPair, p)) bad("judge_pair_applied without a matching pending proposal");
        if (g.chain.some((q) => samePair(q, p))) bad("judge_pair_applied duplicates a chain pair");
        g.chain.push(p); g.pendingPair = null;
        if (g.chain.length > 12) bad("judge chain longer than 12");
        break;
      }
      case "judge_pair_cancelled":
        if (!g.pendingPair) bad("judge_pair_cancelled with nothing pending");
        g.pendingPair = null;
        break;
      case "asset_proposed": {
        if (g.pendingAsset) bad("asset_proposed while another is pending");
        const known = g.assets.includes(d.token_id);
        const disabled = g.disabledAssets.includes(d.token_id);
        if (knowAssets && known && !d.reenable) bad(`asset_proposed as a new asset: ${d.token_id} is already in the table (append-only)`);
        if (knowAssets && d.reenable && !disabled) bad(`asset_proposed re-enable of ${d.token_id}, which is ${known ? "not disabled" : "unknown"}`);
        try {
          if (BigInt(d.effective_at_ns) - BigInt(d.proposed_at_ns) !== ASSET_DELAY_NS) bad("asset_proposed delay is not 24h");
        } catch { bad("asset_proposed has no valid proposed_at_ns/effective_at_ns"); }
        g.pendingAsset = { token_id: d.token_id, reenable: !!d.reenable, limit: d.limit, effective_at_ns: d.effective_at_ns };
        break;
      }
      case "asset_applied": {
        const p = g.pendingAsset;
        if (!p || p.token_id !== d.token_id) bad("asset_applied without a matching pending proposal");
        if (d.reenable) {
          if (!g.disabledAssets.includes(d.token_id)) bad(`asset_applied re-enable of ${d.token_id}, which is not disabled`);
          g.disabledAssets = g.disabledAssets.filter((x) => x !== d.token_id);
        } else {
          if (g.assets.includes(d.token_id)) bad(`asset_applied duplicates table asset ${d.token_id}`);
          else g.assets.push(d.token_id);
        }
        g.pendingAsset = null;
        break;
      }
      case "asset_cancelled":
        if (!g.pendingAsset) bad("asset_cancelled with nothing pending");
        g.pendingAsset = null;
        break;
      case "asset_disabled":
        if (knowAssets && !g.assets.includes(d.token_id)) bad(`asset_disabled for unknown asset ${d.token_id}`);
        if (g.disabledAssets.includes(d.token_id)) bad(`asset_disabled for already-disabled ${d.token_id}`);
        else g.disabledAssets.push(d.token_id);
        break;
    }
  }
  return g;
}

// ---------------------------------------------------------------- JC1y: receipt-aware governance plumbing
/** Governance-relevant NEP-297 events the escrow emits, with the family each belongs to (mirrors contracts/escrow/src/lib.rs). */
export const GOVERNANCE_EVENT_KIND: Record<string, string> = {
  judge_pair_proposed: "judge_chain", judge_pair_applied: "judge_chain", judge_pair_cancelled: "judge_chain",
  guardian_proposed: "guardian", guardian_rotated: "guardian", guardian_cancelled: "guardian",
  asset_proposed: "asset", asset_applied: "asset", asset_cancelled: "asset", asset_disabled: "asset",
  terms_amend_proposed: "amendment", terms_amended: "amendment", referee_amend_proposed: "amendment", referee_amended: "amendment",
  outcome_retry: "model_observation", outcome_submitted: "model_observation",
};

/** D-JCD1 #5: only a receipt whose outcome status is Success* may contribute logs (a Failure outcome's logs are discarded; unknown status is not trusted). */
export function receiptSucceeded(rc: any): boolean {
  const s = rc?.execution_outcome?.outcome?.status;
  return !!s && typeof s === "object" && ("SuccessValue" in s || "SuccessReceiptId" in s);
}

/** Raw log lines of the successful receipts addressed to `escrow`, in block order (stable). */
export function successfulEscrowLogs(escrow: string, hist: { hash: string; rc: any }[]): string[] {
  return orderedReceipts(escrow, hist).flatMap((h) => (h.rc.execution_outcome?.outcome?.logs ?? []) as string[]);
}

function orderedReceipts(escrow: string, hist: { hash: string; rc: any }[]): { hash: string; rc: any }[] {
  return hist
    .map((h, i) => ({ h, i, t: BigInt(h.rc.execution_outcome?.block_timestamp ?? 0) }))
    .filter((x) => x.h.rc.receipt?.receiver_id === escrow && receiptSucceeded(x.h.rc))
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.i - b.i))
    .map((x) => x.h);
}

export interface IndexedGovernanceEvent { contract_id: string; kind: string; event: string; tx_hash: string; block_timestamp: string; data: Record<string, any> }

/** Governance events from a contract's tx history, SUCCESSFUL receipts only, in block order. */
export function indexGovernanceEvents(escrow: string, hist: { hash: string; rc: any }[]): IndexedGovernanceEvent[] {
  const out: IndexedGovernanceEvent[] = [];
  for (const { hash, rc } of orderedReceipts(escrow, hist)) {
    for (const ev of parseEscrowEvents((rc.execution_outcome?.outcome?.logs ?? []) as string[])) {
      const kind = GOVERNANCE_EVENT_KIND[ev.event];
      if (!kind) continue;
      out.push({ contract_id: escrow, kind, event: ev.event, tx_hash: hash, block_timestamp: String(rc.execution_outcome?.block_timestamp ?? "0"), data: ev.data });
    }
  }
  return out;
}
