// F3 (FUND4 SPEC §3.1, STATES.md M5 "empty"): 0 everywhere and nothing in flight -> one hero with Add money. ACCT2 (familiarcow 11-13):
// the page lists every bet token at 0 under this hero (WalletPage), so the old one-line token list is gone.
// Testnet variant: test NEAR is free (the faucet), there is nothing to deposit.
import React from "react";
import { Button } from "../../ui";
import { EmptyState } from "../../kit";
import { COPY } from "../../../lib/funding/copy";

export function EmptyWallet({ testnet, addMoneyAllowed, onAddMoney, faucet }: {
  testnet: boolean; addMoneyAllowed: boolean; onAddMoney: () => void; faucet: React.ReactNode;
}) {
  return (
    <EmptyState data-testid="account-empty" title={COPY.account.emptyTitle}
      body={testnet ? "This is a test network: test NEAR is free, and you can bet with it." : COPY.account.emptyBody}
      action={testnet ? faucet : <Button variant="primary" disabled={!addMoneyAllowed} data-testid="empty-add-money" onClick={onAddMoney}>{COPY.account.addMoney}</Button>} />
  );
}
