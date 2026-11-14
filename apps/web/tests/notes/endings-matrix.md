# Endings matrix (WEBE2E1, D-WEBE2E1)

Inventory of mocked Playwright coverage per ending, BEFORE the journeys (step 1). A "journey" = ONE test walking the live bet page -> action/ruling screen -> payout screen with the mocked chain advancing between steps.

| ending | spec:test name (existing) | screens touched | money lines asserted | gap (at inventory time; CLOSED by the journeys below) |
|---|---|---|---|---|
| AI YES | ai-ruling.spec.ts: "ruling card shows the ruling..." / "YES ruling -> challenge ... -> finalize"; payout-refund.spec.ts: "You won: pot, fee with the $0.50 floor, net, Paid" | ruling card, finalize (separate tests); payout screen (separate test, fresh Settled bet) | payout only: pot $20.00 − fee $1.00 = $19.00, storage line | no journey: finalize never reaches the payout screen |
| AI NO | payout-refund.spec.ts: "You lost: ..." (human-referee world) | payout screen only | stake lost, who was paid | no journey; no AI-NO ruling-to-payout walk |
| AI VOID | ai-ruling.spec.ts: "VOID ruling: plain copy..."; payout-refund.spec.ts: "VOID by the AI: stake back, no fee" | ruling card; payout (separate) | refund $10.02, no fee | no journey |
| AI challenged, then finalized | ai-ruling.spec.ts: "YES ruling -> challenge ... -> finalize" (ends at finalized-line); browse-and-dispute.spec.ts round-1/2 views | ruling, challenge, finalize | bond $4 / $8 only | never reaches the payout screen |
| concede | live-bet.spec.ts: "concede: confirm text, one signature, ..." ; payout-refund.spec.ts: "You conceded ..." / "The other side conceded ..." | live bet page (concede-result); payout (separate) | fee/pot line on payout test only | no journey; concede -> pending -> Paid untested end to end |
| human referee rules YES | human-referee.spec.ts: "referee rules YES: ..."; payout-refund.spec.ts: "You won with a referee tip" | referee screen; payout (separate) | "$19" in confirm sentence; tip math in payout test | no journey (referee view -> bettor payout view) |
| human referee silent -> deadline refund | human-referee.spec.ts: "after the resolve deadline: window closed"; payout-refund.spec.ts: "Referee never ruled: both refunded by the deadline" | referee closed state; payout (separate) | refund $9.52 + tip | no journey |
| emergency shutdown -> emergency_refund | paused-shutdown.spec.ts: "shown for a non-finalized bet once shut down; click relays..."; payout-refund.spec.ts: "Emergency refund: ..." | emergency refund button; payout (separate) | refund $10.02, no fee (payout test) | no journey; button result never advances to the payout screen |

## After WEBE2E1 GREEN: one journey per ending (all in `endings-journeys.spec.ts`, pinned by `fixtures/endings.ts` + `endings-matrix.unit.test.ts`)

| ending | id | spec:test name | screens touched | money lines asserted | gap |
|---|---|---|---|---|---|
| AI YES | ai-yes | endings-journeys.spec.ts: "journey: AI rules YES -> finalize -> payout (maker wins)" | bet page (ruling card) -> finalize -> payout | pot $20.00 − fee $1.00 = $19.00; storage line; Paid | none |
| AI NO | ai-no | endings-journeys.spec.ts: "journey: AI rules NO -> finalize -> payout (maker lost)" | bet page (ruling card) -> finalize -> payout | stake lost $10.00; taker paid; Paid | none |
| AI VOID | ai-void | endings-journeys.spec.ts: "journey: AI VOID (unavailability) -> finalize -> refund payout, no fee" | bet page (VOID ruling) -> finalize -> payout | no fee; stake $10.00 + storage $0.02 = $10.02 refunded | none |
| AI challenged then finalized | ai-challenged | endings-journeys.spec.ts: "journey: AI ruling challenged (one round) -> re-ruled -> finalize -> payout" | bet page -> challenge (bond $4, 1 sig) -> re-ruled -> finalize -> payout | bond $4.00 amount in relayed call; final payout $19.00 | none |
| concede | concede | endings-journeys.spec.ts: "journey: concede -> payout in progress -> retry -> Paid" | bet page -> concede confirm -> payout (paying) -> retry -> paid | pot − fee = $19.00; pending lines $19.00 + fee/storage; drain_payouts | none |
| human referee rules YES | referee-yes | endings-journeys.spec.ts: "journey: human referee rules YES -> payout" | referee screen -> confirm -> bettor payout | confirm 'wins $19'; payout $19.00 with fee/storage lines | none |
| human referee silent | referee-silent | endings-journeys.spec.ts: "journey: human referee silent -> deadline refund payout" | referee closed state -> deadline payout | refund $10.02 each (stake + storage), no fee | none |
| emergency shutdown | emergency | endings-journeys.spec.ts: "journey: emergency shutdown -> emergency_refund -> refund payout" | bet page (shutdown) -> emergency refund -> payout | no fee; $10.02 refund | none |

Money values are computed in the spec from the mocked get_bet stakes + side_fee (fee bps 100, own floor 0.50, storage 0.02/side), the same formulas payoutScreen pins in payout-refund.spec.ts. No UI bugs surfaced.
