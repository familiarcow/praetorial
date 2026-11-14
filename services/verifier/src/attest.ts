// V1d / D-VER2a: NEAR AI public model attestation report, as used by B4's signer binding.
// Keyless: GET https://cloud-api.near.ai/v1/attestation/report?model=<m>&signing_address=<a> (no API key, no completion, no spend).
// Binding fields (read from a real report): model_attestations[].model = attested model;
// gateway_attestation.signing_address = the ed25519 key that signs NEAR AI responses ("signature_kind":"gateway").
// The Intel TDX quote / NVIDIA / SEV-SNP chain inside the report is NOT verified here (docs/VERIFY.md, B4 "Does NOT prove").

export const ATTESTATION_BASE = "https://cloud-api.near.ai";

export interface ParsedReport { models: string[]; signers: string[] }

/** Returns the attested models and signing addresses of a report, or a string describing why it is not a NEAR AI report. */
export function parseReport(raw: string): ParsedReport | string {
  let j: any;
  try { j = JSON.parse(raw); } catch { return "not valid JSON"; }
  const addr = j?.gateway_attestation?.signing_address;
  const ma = j?.model_attestations;
  if (typeof addr !== "string" || !addr) return "no gateway_attestation.signing_address";
  if (!Array.isArray(ma) || !ma.every((m: any) => typeof m?.model === "string")) return "no model_attestations[].model";
  return { models: ma.map((m: any) => m.model), signers: [addr.toLowerCase()] };
}

/** Read-only keyless GET of the public report. Returns the exact response body, or undefined on any failure (B4 then SKIPs). */
export async function fetchAttestation(model: string, signingAddress: string, fetchFn: typeof fetch = fetch): Promise<string | undefined> {
  const url = `${ATTESTATION_BASE}/v1/attestation/report?model=${encodeURIComponent(model)}&signing_address=${signingAddress}`;
  try {
    const r = await fetchFn(url, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return undefined;
    return await r.text();
  } catch { return undefined; }
}
