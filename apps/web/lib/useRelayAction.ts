// Shared "build -> sign via Privy -> relay" pipeline for every button
// that moves chain state (open/take/challenge/cancel).
// D-PRIVY1: signing happens in the browser via signRawHash over the
// NEP-461-prefixed hash of the DelegateAction; this hook never sees or
// holds a private key, only the hash to sign and the signature back.
import { useEffect, useState } from "react";
import { prepareDelegate, encodeSignedDelegate } from "./delegate";
import { relaySignedDelegate, relayStatus, RelayResult } from "./relayerClient";
import { actionKey, browserStore, checkInflight, guardedRelay, type ResolveDeps } from "./inflightSend";
import { gasForMethod } from "./relayGas";
import { needsUserSignedTx } from "./directTx";

/** RELAYDEP1 / D-RELAYDEP1: the relayer is the outer signer and would pay any deposit inside the delegate. */
export function assertRelayable(methodName: string, depositYocto: string | undefined): void {
  if (needsUserSignedTx(methodName, BigInt(depositYocto ?? "0"))) throw new Error(`${methodName} carries a deposit, so it must be a user-signed transaction, never relayed`);
}
import { viewAccessKeyNonceOrNull, viewBlockHeight } from "./rpc";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** SEC1/MON-2: how an earlier attempt of the same action is looked up before anything new is signed. */
const resolveDeps: ResolveDeps = {
  status: (by) => relayStatus(by),
  chainNonce: (a, pk) => viewAccessKeyNonceOrNull(a, pk),
  height: () => viewBlockHeight(),
};
import { nonceOrActivate, requestActivation, ActivationError } from "./accountActivation";

export type RelayStatus = "idle" | "building" | "signing" | "relaying" | "done" | "error";

export interface RelayActionParams {
  senderId: string;
  publicKeyHexEd25519: string; // == senderId for a NEAR implicit account (Privy's nearWallet.address)
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gasTgas?: number;
  depositYocto?: string;
  signRawHash: (address: string, hashHex: string) => Promise<string>;
}

export function useRelayAction() {
  const [status, setStatus] = useState<RelayStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  // SEC1/MON-5: closing or reloading the tab while a send is on its way loses nothing (it is stored), but warn anyway.
  useEffect(() => {
    if (status !== "relaying" && status !== "signing") return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [status]);

  /** SEC1/MON-2: what became of an earlier, unresolved attempt of exactly this action (null = none, or it never ran). */
  async function check(p: Pick<RelayActionParams, "senderId" | "receiverId" | "methodName" | "args" | "depositYocto">): Promise<RelayResult | null> {
    try { return await checkInflight(actionKey(p), { store: browserStore(), ...resolveDeps }); } catch { return null; }
  }

  async function run(p: RelayActionParams): Promise<RelayResult> {
    setStatus("building");
    setError(null);
    setTxHash(null);
    try {
      assertRelayable(p.methodName, p.depositYocto);
      // SEC1/MON-2: an earlier attempt of this same action whose outcome was unknown is resolved first; a new delegate is
      // signed only once it is known not to have executed.
      const result = await guardedRelay(actionKey(p), { senderId: p.senderId, publicKeyHex: p.publicKeyHexEd25519 }, {
        store: browserStore(), ...resolveDeps, sleep,
        onRelaying: () => setStatus("relaying"),
        relay: relaySignedDelegate,
        signNew: async () => {
          const [nonce, blockHeight] = await Promise.all([
            // FUND2: a deposit-only user's implicit account may not exist yet; the relayer creates it (their balance gates it).
            nonceOrActivate({ read: () => viewAccessKeyNonceOrNull(p.senderId, p.publicKeyHexEd25519), activate: () => requestActivation(p.senderId), sleep }),
            viewBlockHeight(),
          ]);
          const maxBlockHeight = blockHeight + 200n; // short window, relayer also enforces its own ceiling
          const { delegateAction, hashHex } = prepareDelegate({
            senderId: p.senderId,
            receiverId: p.receiverId,
            methodName: p.methodName,
            args: p.args,
            gasTgas: p.gasTgas ?? gasForMethod(p.methodName), // REFGAS1: table in lib/relayGas.ts
            depositYocto: p.depositYocto ?? "0",
            publicKeyHexEd25519: p.publicKeyHexEd25519,
            nonce: nonce + 1n,
            maxBlockHeight,
          });
          setStatus("signing");
          const signatureHex = await p.signRawHash(p.senderId, hashHex);
          return { signedDelegateB64: encodeSignedDelegate(delegateAction, signatureHex), nonce: nonce + 1n, maxBlockHeight };
        },
      });
      if (result.ok) {
        setStatus("done");
        setTxHash(result.txHash ?? null);
      } else {
        setStatus("error");
        setError(result.error ?? "relay failed");
      }
      return result;
    } catch (err: any) {
      setStatus("error");
      const msg = err instanceof ActivationError ? `${err.message} Details: ${err.detail}` : String(err?.message ?? err);
      setError(msg);
      return { ok: false, error: msg };
    }
  }

  return { run, check, status, error, txHash };
}
