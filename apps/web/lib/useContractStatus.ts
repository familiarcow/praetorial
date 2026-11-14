// Shared "is the contract taking new offers / has it been shut down"
// poll, backing the global paused/shutdown banner (App.tsx) and the
// per-bet Emergency refund gate (BetPage.tsx). Both views read the same
// two escrow views (lib/escrowAdapter.ts's isPaused/isShutdown) so the
// banner and the refund button never disagree about contract state.
import { useEffect, useState } from "react";
import { isPaused, isShutdown } from "./escrowAdapter";

export interface ContractStatus {
  paused: boolean;
  shutdown: boolean;
}

const INITIAL: ContractStatus = { paused: false, shutdown: false };

export function useContractStatus(pollMs = 15_000): ContractStatus {
  const [status, setStatus] = useState<ContractStatus>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const [paused, shutdown] = await Promise.all([isPaused(), isShutdown()]);
        if (!cancelled) setStatus({ paused, shutdown });
      } catch {
        // Transient RPC errors shouldn't flip the banner off; keep the
        // last-known status and try again on the next poll tick.
      }
    }
    poll();
    const interval = setInterval(poll, pollMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pollMs]);

  return status;
}
