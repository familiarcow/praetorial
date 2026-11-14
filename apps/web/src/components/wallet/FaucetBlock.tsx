// F3 (FUND1b, testnet): free test NEAR from our testnet faucet, then Move to betting. Moved here unchanged from F3's interim
// AddMoneySheet.tsx when F4's Add money sheet (src/components/funding/FundSheet.tsx) replaced it.
import React from "react";
import { Button } from "../../ui";
import { COPY } from "../../../lib/funding/copy";

export function FaucetBlock({ busy, message, onGet, onRefresh }: { busy: boolean; message: string | null; onGet: () => void; onRefresh: () => void }) {
  return (
    <div data-testid="faucet-section" className="acct-faucet">
      <p>{COPY.common.testnetFund} One click puts some in your account.</p>
      <div className="k-actions">
        <Button data-testid="get-test-near" variant="primary" disabled={busy} onClick={onGet}>{busy ? "Getting test NEAR…" : COPY.common.testnetFundCta}</Button>
        <Button data-testid="faucet-refresh" onClick={onRefresh}>Refresh my balance</Button>
      </div>
      {message && <p data-testid="faucet-result" role="status">{message}</p>}
    </div>
  );
}
