// JC1x (D-JUDGECHAIN1a S3): turn the escrow's NEP-297 governance events into operator alerts.
import { parseEscrowEvents } from "../../common/src/escrowEvents.js";

export interface GovernanceAlert { severity: "info" | "warning" | "critical"; event: string; message: string }

const TABLE: Record<string, (d: any) => Omit<GovernanceAlert, "event">> = {
  guardian_proposed: (d) => ({ severity: "warning", message: `guardian rotation proposed: ${d.guardian} -> ${d.proposed}; the old guardian stays until ${d.proposed} calls accept_guardian` }),
  guardian_rotated: (d) => ({ severity: "critical", message: `guardian rotated: ${d.old_guardian} -> ${d.guardian}` }),
  guardian_cancelled: (d) => ({ severity: "info", message: `guardian rotation to ${d.cancelled} cancelled` }),
  judge_pair_proposed: (d) => ({ severity: "warning", message: `judge pair proposed: ${d.model_a} + ${d.model_b}; applies after the 7-day delay` }),
  judge_pair_applied: (d) => ({ severity: "warning", message: `judge pair appended: ${d.model_a} + ${d.model_b}` }),
  judge_pair_cancelled: () => ({ severity: "info", message: "pending judge pair cancelled" }),
  asset_proposed: (d) => ({ severity: "warning", message: `asset ${d.reenable ? "re-enable" : "addition"} proposed: ${d.token_id}; applies after the 24h delay` }),
  asset_applied: (d) => ({ severity: "warning", message: `asset ${d.reenable ? "re-enabled" : "added"}: ${d.token_id}` }),
  asset_cancelled: (d) => ({ severity: "info", message: `pending asset proposal cancelled: ${d.token_id}` }),
  asset_disabled: (d) => ({ severity: "critical", message: `asset ${d.token_id} DISABLED for new bets` }),
  offers_paused: () => ({ severity: "warning", message: "new offers paused" }),
  offers_unpaused: () => ({ severity: "info", message: "new offers unpaused" }),
  emergency_shutdown: () => ({ severity: "critical", message: "EMERGENCY SHUTDOWN triggered" }),
};

export function governanceAlerts(logs: string[]): GovernanceAlert[] {
  const out: GovernanceAlert[] = [];
  for (const e of parseEscrowEvents(logs)) {
    const f = TABLE[e.event];
    if (f) out.push({ event: e.event, ...f(e.data) });
  }
  return out;
}
