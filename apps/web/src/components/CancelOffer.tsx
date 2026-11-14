// FE8 (S9) + MODAL1c4: maker cancel as a confirm modal. cancel(bet_id) is maker-only while the bet is Open; the result is read back
// with get_bet (Cancelled = money back; anything else but Open = someone took it first). The modal says what is refunded and where
// before the confirm; the relay (method, args, deposit, REFGAS1 gas) is unchanged.
import React, { useState } from "react";
import { Button } from "../ui";
import { ResolutionShell, type Run } from "./ResolutionModals";
import { buildCancelArgs, getBet, type Bet } from "../../lib/escrowAdapter";
import { ESCROW_CONTRACT_ID } from "../../lib/config";
import { useMoneyStale } from "../../lib/moneyContext";
import { useRelayAction } from "../../lib/useRelayAction";
import { confirmCancel, confirmTiming } from "../../lib/openConfirm";
import { DECLINED_MESSAGE } from "../../lib/openRefusal";
import { cancelOfferTerms, adminFlowPhase, OFFER_ADMIN_STEPS, OFFER_ADMIN_DRAFT_KEY } from "../../lib/offerAdminFlows";

export interface CancelWallet {
  nearAddress: string;
  signRawHash: (address: string, hashHex: string) => Promise<string>;
}

export default function CancelOffer({ betId, bet, wallet, onDone }: { betId: number; bet: Bet; wallet: CancelWallet | null; onDone?: (o: { kind: string; message: string }) => void }) {
  const stale = useMoneyStale();
  const action = useRelayAction();
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<{ kind: string; message: string } | null>(null);
  const t = cancelOfferTerms(bet);

  async function run(): Promise<Run> {
    if (!wallet) return { kind: "refused", message: "Sign in first. Nothing was sent." };
    let declined = false;
    const r = await action.run({
      senderId: wallet.nearAddress,
      publicKeyHexEd25519: wallet.nearAddress,
      receiverId: ESCROW_CONTRACT_ID,
      methodName: "cancel",
      args: buildCancelArgs(betId),
      signRawHash: async (a, h) => { try { return await wallet.signRawHash(a, h); } catch (e) { declined = true; throw e; } },
    });
    if (declined) return { kind: "declined", message: DECLINED_MESSAGE };
    // Whatever the relayer said, the bet on the contract is the truth: read it back.
    const tm = confirmTiming();
    const outcome = await confirmCancel({ betId, deps: { getBet: (id) => getBet(id), sleep: (ms) => new Promise((x) => setTimeout(x, ms)) }, attempts: r.ok ? tm.attempts : Math.min(tm.attempts ?? 3, 3), delayMs: tm.delayMs });
    if (outcome.kind === "pending" && !r.ok) return { kind: "failed", message: "The cancel didn't go through. Your bet is still open." };
    return { ...outcome, txHash: r.txHash ?? null };
  }

  const hideButton = !!result?.kind.match(/^(cancelled|taken|expired)$/);
  return (
    <div data-testid="cancel-section">
      {!hideButton && (
        <Button data-testid="cancel-bet" onClick={() => setAsking(true)} disabled={!wallet || stale || asking}>
          Cancel and get your money back
        </Button>
      )}
      {asking && (
        <ResolutionShell
          kind="cancel" title="Cancel this bet" draftId={betId} steps={OFFER_ADMIN_STEPS} draftKey={OFFER_ADMIN_DRAFT_KEY("cancel", betId)} phaseOf={adminFlowPhase}
          termsTestId="cancel-confirm-box" confirmTestId="cancel-confirm" cancelTestId="cancel-keep" cancelLabel="Keep it open" resultTestId={() => "cancel-result"}
          confirmLabel="Cancel and refund" destructive disabled={!wallet || stale} action="cancel"
          terms={<><p style={{ margin: "0 0 6px", fontWeight: 600 }}>Cancel this bet and get your money back?</p><ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.5 }}>{t.lines.map((l) => <li key={l}>{l}</li>)}</ul></>}
          run={run}
          onClose={(last) => {
            setAsking(false);
            if (last) { setResult(last); onDone?.(last); }
          }}
        />
      )}
      {result && !asking && <div data-testid="cancel-result" data-kind={result.kind}>{result.message}</div>}
    </div>
  );
}
