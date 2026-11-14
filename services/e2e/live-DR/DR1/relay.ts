// DR1 relay: submit_outcome is permissionless ("anyone submits the resolver's signed outcome"); nothing in production relays the
// resolver output stored in bet.last_resolution_raw (the keeper only has a test-key resolver stand-in). Pure arg builder, unit tested.
export function submitArgsFromRaw(raw: string, contract: string, betId: number): { result: Record<string, unknown>; signature_hex: string } {
  const o = JSON.parse(raw);
  if (!o?.result || !o?.signing?.signature_hex) throw new Error("no signed result in the stored output (unsigned error output)");
  if (o.contract !== contract) throw new Error(`contract mismatch: ${o.contract}`);
  if (Number(o.result.bet_id) !== betId) throw new Error(`bet mismatch: ${o.result.bet_id}`);
  return { result: { ...o.result, checked_until: String(o.result.checked_until) }, signature_hex: o.signing.signature_hex };
}
