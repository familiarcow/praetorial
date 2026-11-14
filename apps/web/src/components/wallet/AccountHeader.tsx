// F3 (familiarcow UX-37 "rename Wallet to Account" + UIR1 #8 "fold Settings into the Account card" + FUND 11 "≈ $X"): the header card.
// @username large (the user's identity everywhere, lib/appState identityOf), the record and first bet, the grey "≈ $X" (only $
// figure, hidden when any price is missing), Add money / Cash out, a collapsed "Account details" (the ONLY place the raw account
// id is shown on this screen, with Copy), Change username (was Settings) and Log out.
// The username comes from the app state (SM2 gap F3-1): this file never asks the registry who the user is.
import React, { useEffect, useState } from "react";
import { Button } from "../../ui";
import { Disclosure, KeyValue, Notice } from "../../kit";
import { useAppState } from "../../kit/Gate";
import { identityOf } from "../../../lib/appState";
import { COPY } from "../../../lib/funding/copy";
import { recordText, type BetsState } from "../../../lib/walletCards";
import { refereeListed } from "../../../lib/accountBalances";
import { REGISTRY_DOWN_MESSAGE } from "../../../lib/username";
import { exactTime } from "../../../lib/dates";
import UsernameStep from "../UsernameStep";

const monthYear = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { month: "short", year: "numeric" });

export function AccountHeader({ account, registryUrl, signRawHash, totalUsd, bets, actions, onLogout }: {
  account: string; registryUrl: string; signRawHash: (a: string, h: string) => Promise<string>;
  /** "143.20" or null (hidden). */
  totalUsd: string | null;
  bets: BetsState;
  /** Add money / Cash out buttons (the page owns their sheets). */
  actions: React.ReactNode;
  onLogout?: () => void;
}) {
  const { ctx, fixes } = useAppState();
  const username = ctx.account === "has" ? ctx.username ?? null : null;
  const me = identityOf({ account, username, me: account, selfAsName: true });
  const [renaming, setRenaming] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [listed, setListed] = useState<boolean | null | "loading">("loading");
  useEffect(() => {
    let live = true;
    setListed("loading");
    refereeListed(registryUrl, username, account).then((v) => live && setListed(v));
    return () => { live = false; };
  }, [registryUrl, username, account]);

  const copyId = async () => {
    try { await navigator.clipboard.writeText(account); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
  };
  const since = bets !== "loading" && bets !== "error" ? bets.memberSince : null;

  return (
    <section className="acct-head k-card" data-testid="wallet-account">
      <div className="acct-head__who">
        {ctx.account === "has" && username && <h1 className="acct-head__name" data-testid="wallet-username">{me.label}</h1>}
        {ctx.account === "checking" && <h1 className="acct-head__name k-muted">…</h1>}
        {(ctx.account === "not-required" || ctx.account === "not-checked") && <h1 className="acct-head__name">{COPY.account.title}</h1>}
        {ctx.account === "none" && (
          <>
            <h1 className="acct-head__name">{COPY.account.title}</h1>
            <Button variant="primary" data-testid="wallet-pick-username" onClick={fixes.pickUsername}>Pick a username</Button>
          </>
        )}
        {ctx.account === "unknown" && (
          <>
            <h1 className="acct-head__name">{COPY.account.title}</h1>
            <Notice tone="warn" title={REGISTRY_DOWN_MESSAGE} data-testid="wallet-registry-down" action={<Button data-testid="wallet-registry-retry" onClick={fixes.retry}>Try again</Button>} />
          </>
        )}
        {totalUsd !== null && <p className="acct-head__usd k-muted" data-testid="account-total-usd">{COPY.account.totalApprox(totalUsd)}</p>}
        {bets !== "error" && (
          <p className="k-small k-muted" data-testid="account-record">
            {bets === "loading" ? "…" : recordText(bets.record)}
            {since !== null && <> · <span data-testid="account-since" title={exactTime(since).utc}>Member since {monthYear(since)}</span></>}
          </p>
        )}
      </div>
      <div className="acct-head__actions">{actions}</div>
      {saved && <p data-testid="settings-saved" role="status">Username changed to @{saved}.</p>}
      <Disclosure title={COPY.account.accountDetails} summary="Account ID, username, referee search" data-testid="account-details">
        <KeyValue variant="stacked" rows={[
          { id: "account-id", label: "Account ID", value: (
            <span className="acct-id">
              <code data-testid="wallet-account-id" title={account}>{account}</code>
              <Button size="sm" data-testid="account-id-copy" onClick={copyId}>{copied ? "Copied" : "Copy account ID"}</Button>
            </span>
          ) },
          ...(username ? [{ id: "username", label: "Username", value: (
            <span className="acct-id"><span data-testid="settings-username">@{username}</span>
              <Button size="sm" data-testid="settings-change-username" onClick={() => setRenaming(true)}>Change username</Button></span>
          ) }] : []),
          ...(username && registryUrl ? [{ id: "referee", label: "Shown in referee search", value: (
            <span data-testid="account-referee-listed" data-listed={String(listed)}>
              {listed === "loading" ? "…" : listed === null ? "Can't check right now" : listed ? "Yes" : "No"}
              <span className="k-small k-muted"> · change it with Change username</span>
            </span>
          ) }] : []),
        ]} />
        <p className="k-small k-muted">Your account ID is only for adding money and cashing out. {username ? `People see you as @${username}.` : "People see you by your username once you pick one."}</p>
      </Disclosure>
      {onLogout && <div className="acct-head__logout"><Button variant="ghost" size="sm" data-testid="logout" onClick={onLogout}>Log out</Button></div>}
      {renaming && username && (
        <UsernameStep key={username} registryUrl={registryUrl} account={account} signRawHash={signRawHash} settings={{ current: username }}
          onClose={() => setRenaming(false)}
          onDone={(claimed, name) => { if (claimed && name) { setSaved(name); fixes.usernameChanged(name); setRenaming(false); } }} />
      )}
    </section>
  );
}
