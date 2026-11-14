// KEEPSUBMIT1W: "Apply the judge's ruling". Fallback for when the keeper is down: the contract stored the signed judge result but nothing applied it.
// Permissionless submit_outcome(result, signature_hex), gas-only (no deposit) so it goes through the relayer; the contract verifies the signature.
import React, { useState } from "react";
import { Button } from "../ui";
import { useLoginFirst } from "../kit/Gate";
import { getBet, type Bet } from "../../lib/escrowAdapter";
import { ESCROW_CONTRACT_ID } from "../../lib/config";
import { planJudgeRuling } from "../../lib/judgeRuling";
import { phaseOf, resolvingState } from "../../lib/betLifecycle";
import { chainClock } from "../../lib/chainClock";
import { useRelayAction } from "../../lib/useRelayAction";
import { contractRefusalMessage } from "../../lib/relayGas";
import { confirmTiming } from "../../lib/openConfirm";
import { DECLINED_MESSAGE } from "../../lib/openRefusal";
import { useMoneyStale } from "../../lib/moneyContext";

export interface ApplyWallet { nearAddress: string; signRawHash: (address: string, hashHex: string) => Promise<string> }

const chainNowMs = (): number => chainClock.nowMs() ?? Date.now();
const RESOLVING = ["judging", "stuck"];

export default function ApplyRuling({ betId, bet, wallet, onBet }: { betId: number; bet: Bet; wallet: ApplyWallet | null; onBet: (b: Bet) => void }) {
  const stale = useMoneyStale();
  const loginFirst = useLoginFirst(); // GUEST1: a guest gets "Log in to bet", never a relayer call
  const action = useRelayAction();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const plan = planJudgeRuling(ESCROW_CONTRACT_ID, betId, bet);
  // LIFE1 (SM1 LIFE-9b): only when submit_outcome would accept it NOW (a RETRY past its next_check_ns or a stale observation always panics).
  if (!plan.ok || resolvingState(ESCROW_CONTRACT_ID, betId, bet, chainNowMs()).kind !== "ready") return null;

  async function apply() {
    if (!wallet || !plan.ok || busy) return;
    setBusy(true); setMsg(null);
    let declined = false;
    try {
      const r = await action.run({
        senderId: wallet.nearAddress,
        publicKeyHexEd25519: wallet.nearAddress,
        receiverId: ESCROW_CONTRACT_ID,
        methodName: "submit_outcome",
        args: plan.args as unknown as Record<string, unknown>,
        signRawHash: async (a, h) => { try { return await wallet.signRawHash(a, h); } catch (e) { declined = true; throw e; } },
      });
      if (declined) { setMsg(DECLINED_MESSAGE); return; }
      if (!r.ok) { setMsg(contractRefusalMessage(r) ?? "The ruling didn't go through. Nothing changed. Try again in a moment."); return; }
      const t = confirmTiming();
      for (let i = 0; i < (t.attempts ?? 8); i++) {
        const b = await getBet(betId).catch(() => null);
        // SM2 B1-7: stop once the bet has left Resolving (judging, or stuck on an unusable stored result) or a new run started.
        if (b && (!RESOLVING.includes(phaseOf(b, chainNowMs() * 1e6, ESCROW_CONTRACT_ID)) || b.pending_run_no !== bet.pending_run_no)) { onBet(b); return; }
        await new Promise((x) => setTimeout(x, t.delayMs ?? 2000));
      }
      setMsg("We sent it but can't see the ruling applied yet. Check again in a moment.");
    } finally { setBusy(false); }
  }

  return (
    <section data-testid="apply-ruling-section" className="k-card k-action k-stack b1-action" data-kind="primary">
      <p className="k-action__text">The AI judge has ruled, but the ruling hasn't been applied yet.</p>
      <p className="k-action__hint">This normally happens on its own. Anyone can apply it; the contract checks the AI judge's signature.</p>
      <div className="k-actions k-actions--stack">
        <Button data-testid="apply-ruling" variant="primary" onClick={loginFirst ?? apply} disabled={!loginFirst && (!wallet || stale || busy)}>Apply the AI judge's ruling</Button>
      </div>
      {msg && <p data-testid="apply-ruling-result" role="alert">{msg}</p>}
    </section>
  );
}
