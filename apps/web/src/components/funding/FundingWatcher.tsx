// F4 (FUND4 SPEC §4.6-4.7, §7.4): mounted once by App for the signed-in account. Polls the user's open Add money deposits
// (fundingLive), shows each one as a compact tracker strip under the nav on every page (Account has its own card, so it passes
// `hidden`), and toasts when a deposit moves to a new state (lib/fundSheet.toastFor). Records come from this device AND the funding
// Worker's list, so a reload or a second device shows the same strip. Tapping a line reopens its full tracker.
import React, { useEffect } from "react";
import { TERMINAL_STATES } from "../../../lib/funding/types";
import { toastFor } from "../../../lib/fundSheet";
import { useToast } from "../../kit";
import { TrackerCompact } from "./Tracker";
import { onRecordChange, useFundingPoller, useFundingRecords } from "./fundingLive";

export function FundingWatcher({ account, hidden, onOpen }: { account: string; hidden?: boolean; onOpen: (id: string) => void }) {
  useFundingPoller(account);
  const toast = useToast();
  useEffect(() => onRecordChange((prev, next) => {
    if (next.account !== account) return;
    const t = toastFor(prev, next);
    if (t) toast({ text: t.text, tone: t.tone === "good" ? "success" : t.tone === "bad" ? "error" : "info", id: `fund-${next.id}` });
  }), [account, toast]);
  const open = useFundingRecords().filter((r) => r.account === account && r.kind === "fund" && !TERMINAL_STATES.includes(r.state));
  if (hidden || open.length === 0) return null;
  return (
    <aside className="fund-strip" data-testid="fund-strip" aria-label="Money on its way">
      {open.map((r) => <TrackerCompact key={r.id} record={r} onOpen={() => onOpen(r.id)} />)}
    </aside>
  );
}
