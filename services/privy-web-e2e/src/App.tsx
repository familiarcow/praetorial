import React, { useEffect, useRef, useState } from "react";
import { usePrivy, useLoginWithEmail, useLinkWithPasskey } from "@privy-io/react-auth";
import { useCreateWallet, useSignRawHash } from "@privy-io/react-auth/extended-chains";

// This whole file is the Option-1 round trip's browser half: real
// Privy client SDK, real user session, real signRawHash. Nothing here
// ever touches an app secret. Playwright drives the login form like a
// real user (fill email, fill OTP, click); the raw-hash signing step
// has no sensible form UI, so it's exposed programmatically on
// window.__e2e, backed by the exact same live signRawHash hook.
declare global {
  interface Window {
    __e2e?: {
      ready: boolean;
      authenticated: boolean;
      nearAddress: string | null;
      status: string;
      signRawHash: (address: string, hashHex: string) => Promise<string>;
    };
  }
}

export default function App() {
  const { ready, authenticated, user, logout } = usePrivy();
  const { sendCode, loginWithCode } = useLoginWithEmail();
  const { createWallet } = useCreateWallet();
  const { signRawHash } = useSignRawHash();
  const { linkWithPasskey } = useLinkWithPasskey();

  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [nearAddress, setNearAddress] = useState<string | null>(null);
  const [status, setStatus] = useState("init");
  const [passkeyResult, setPasskeyResult] = useState("");
  const creating = useRef(false);

  useEffect(() => {
    if (!authenticated || !user) {
      setNearAddress(null);
      return;
    }
    const nearWallet = (user.linkedAccounts || []).find(
      (a: any) => a.type === "wallet" && a.chainType === "near",
    ) as any;
    if (nearWallet) {
      setNearAddress(nearWallet.address);
      setStatus("wallet-ready");
      return;
    }
    if (!creating.current) {
      creating.current = true;
      setStatus("creating-wallet");
      createWallet({ chainType: "near" as any })
        .then((w: any) => {
          setNearAddress(w.address);
          setStatus("wallet-ready");
        })
        .catch((err: any) => setStatus("wallet-error: " + String(err?.message ?? err)))
        .finally(() => {
          creating.current = false;
        });
    }
  }, [authenticated, user, createWallet]);

  window.__e2e = {
    ready,
    authenticated,
    nearAddress,
    status,
    signRawHash: async (address: string, hashHex: string) => {
      const hash = (hashHex.startsWith("0x") ? hashHex : "0x" + hashHex) as `0x${string}`;
      const { signature } = await signRawHash({ address, chainType: "near", hash });
      return signature;
    },
  };

  return (
    <div>
      <h1>Praetorial Privy NEAR E2E</h1>
      <div data-testid="status">{status}</div>
      <div data-testid="authenticated">{String(authenticated)}</div>
      <div data-testid="near-address">{nearAddress ?? ""}</div>

      {!authenticated && (
        <div data-testid="login-form">
          <input
            data-testid="email-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            placeholder="email"
          />
          <button data-testid="send-code" disabled={!ready} onClick={() => sendCode({ email })}>
            Send Code
          </button>
          <input
            data-testid="otp-input"
            value={otp}
            onChange={(e) => setOtp(e.currentTarget.value)}
            placeholder="otp"
          />
          <button data-testid="submit-code" onClick={() => loginWithCode({ code: otp })}>
            Login
          </button>
        </div>
      )}

      {authenticated && (
        <div data-testid="logged-in">
          <button data-testid="logout" onClick={() => logout()}>
            Log out
          </button>
          <button
            data-testid="link-passkey"
            onClick={() =>
              linkWithPasskey({ name: "Praetorial recovery passkey" })
                .then(() => setPasskeyResult("ok"))
                .catch((err: any) => setPasskeyResult("error: " + String(err?.message ?? err)))
            }
          >
            Link recovery passkey
          </button>
          <div data-testid="passkey-result">{passkeyResult}</div>
        </div>
      )}
    </div>
  );
}
