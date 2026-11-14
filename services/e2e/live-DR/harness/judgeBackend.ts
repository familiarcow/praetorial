// FRZ2SEC1: a live run is only evidence if the resolver really called the judge. When no NEAR_AI_API_KEY reaches the wasm
// it silently falls back to the offline mock (judge_backend "offline-mock") and signs a VOID. This module refuses such runs.
// Independent of the resolver (no imports). Fails closed: anything that is not an explicit real backend is refused.
export interface JudgeBackend { backend: string | null; reason: string | null; real: boolean; httpStatuses: Array<number | null> }

const REAL = new Set(["near-ai"]);

/** `raw` is get_bet.last_resolution_raw (a JSON string) or the already-parsed object (e.g. raw_resolution). */
export function judgeBackendOf(raw: unknown): JudgeBackend {
  let o: any = raw;
  if (typeof raw === "string") { try { o = JSON.parse(raw); } catch { throw new Error("judgeBackend: last_resolution_raw is not JSON"); } }
  const j = o?.judge;
  if (!j || typeof j !== "object") throw new Error("judgeBackend: last_resolution_raw has no judge block");
  const backend = typeof j.judge_backend === "string" ? j.judge_backend : null;
  const reason = typeof j.judge_backend_reason === "string" && j.judge_backend_reason ? j.judge_backend_reason : null;
  const httpStatuses = Array.isArray(j.run_diagnostics) ? j.run_diagnostics.map((d: any) => (typeof d?.http_status === "number" ? d.http_status : null)) : [];
  return { backend, reason, real: backend !== null && REAL.has(backend) && !(reason && /NEAR_AI_API_KEY/.test(reason)), httpStatuses };
}

/** Throws unless the run used a real judge backend. Call from every live DR finish phase before reading the outcome as evidence. */
export function assertRealJudge(raw: unknown, label = "last_resolution_raw"): JudgeBackend {
  let r: JudgeBackend;
  try { r = judgeBackendOf(raw); } catch (e: any) { throw new Error(`${e.message} (${label})`); }
  if (r.backend === null) throw new Error(`judgeBackend: judge_backend missing in ${label}; refusing (fail closed)`);
  if (!r.real) throw new Error(`judgeBackend: ${label} used judge_backend '${r.backend}' not a real NEAR AI judge${r.reason ? `: ${r.reason}` : ""}. The OutLayer secret was not injected: bind it (TESTING.md, NEAR AI key lookup).`);
  return r;
}
