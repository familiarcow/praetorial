// Builds the exact `TransferMsg::Open` JSON the escrow contract's
// mt_on_transfer expects today: { kind:"Open", envelope, attestation }.
// The legacy `arbiter` field is gone from the contract Envelope (D-REF1),
// maker_asset/taker_asset are required, and the sourcecheck attestation
// (D-FETCH2) is mandatory. `checked_at` is a u64 ns timestamp and is emitted
// as a JSON number with full precision (JSON.stringify would round a JS
// number), so a bigint/decimal-string is accepted and spliced in verbatim.
export interface OpenAttestation {
  checked_at: bigint | number | string;
  signature_hex: string;
}

// D-HORIZON1a: mirrors the escrow contract's MAX_HORIZON_NS (open-time rule).
export const MAX_HORIZON_NS = 1_461n * 86_400n * 1_000_000_000n;
export const HORIZON_ERROR = "Bets can last at most 4 years (D-HORIZON1a)";

export function buildOpenMsg(
  envelope: Record<string, unknown>,
  attestation: OpenAttestation,
  nowNs: bigint = BigInt(Date.now()) * 1_000_000n,
): string {
  if (!attestation || attestation.checked_at === undefined || attestation.signature_hex === undefined) {
    throw new Error("buildOpenMsg: attestation {checked_at, signature_hex} is required");
  }
  if (!/^[0-9a-f]{128}$/i.test(attestation.signature_hex)) {
    throw new Error("buildOpenMsg: attestation signature_hex must be 128 hex chars");
  }
  const checkedAt = String(attestation.checked_at);
  if (!/^\d+$/.test(checkedAt)) throw new Error("buildOpenMsg: attestation checked_at must be a u64 integer");
  for (const f of ["maker_asset", "taker_asset"]) {
    if (typeof envelope[f] !== "string" || !envelope[f]) throw new Error(`buildOpenMsg: envelope.${f} is required`);
  }
  if (envelope.resolve_deadline !== undefined && /^\d+$/.test(String(envelope.resolve_deadline))) {
    if (BigInt(String(envelope.resolve_deadline)) > nowNs + MAX_HORIZON_NS) {
      throw new Error(`buildOpenMsg: ${HORIZON_ERROR}`);
    }
  }
  const { arbiter: _legacy, ...clean } = envelope as Record<string, unknown>;
  return (
    `{"kind":"Open","envelope":${JSON.stringify(clean)},` +
    `"attestation":{"checked_at":${checkedAt},"signature_hex":${JSON.stringify(attestation.signature_hex)}}}`
  );
}
