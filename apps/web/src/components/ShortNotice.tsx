// FUND1b: the in-modal "short on money" notice. Plain sentence with the exact missing amount and one "Add money" action.
import React from "react";
import { Banner, Button } from "../ui";
import type { FundingShort } from "../../lib/fundingGate";

export function ShortNotice({ short, onAddMoney }: { short: FundingShort; onAddMoney: () => void }) {
  return (
    <Banner status="warning" data-testid="modal-short" role="alert">
      <span data-testid="modal-short-text">{short.sentence}</span>{" "}
      <Button data-testid="modal-add-money" variant="primary" onClick={onAddMoney}>Add money</Button>
    </Banner>
  );
}
