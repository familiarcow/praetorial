# DR9 tx hashes (recovered from the public fastnear tx index + the run logs)
The first versions of the live scripts clobbered their own tx log (stale-save bug, fixed in lib.mjs: save() now merges the on-disk txs), so results JSON files miss some hashes. This table is authoritative; every hash is on testnet (https://testnet.nearblocks.io/txns/<hash>).

## Drill 1 (frz3 = praetorial-frz3-2611100414.praetorial-dev-1101.testnet, bet 44 created for the drill; bets 33/35/42 untouched)
| step | tx |
|---|---|
| mint maker X / taker X / maker P (mock USDC) | Gm8MbyQAssnoNx7C4wqYV93WyLRJW61yi7Us93HqF6JS / 5REmuGKCdwEi8XhrueiZWbPYMnfqRK2gpfeHBmj6XdZt / GH82SQwBHB1petgaBKshbiQNvuHUTdD1MktS4JYRLMvu |
| open bet 44 | 9pAReoDYneR9234VDH8iNE1eJwUnVsyF2kCnkPNLNyjT |
| take bet 44 (Taken) | 7RmQWhQyu7WHkDC6nyfY4wbagZnvjUSmS17BGgjbRnb2 |
| pause_new_offers (guardian arbiter1) | BPL13JHThjQYpSJxEv7ZSsAxKWEnvGNQhqjw9waf4s3P |
| open while paused (refused, silent full refund) | 4kXGH1q35VdUPuj2jCrQi9pMz59RbXuKW7uf3KWe5oAV |
| concede bet 44 while paused (Settled) | B3UgG4aa6WaBTpTPBX4GmvEYVUrRojzaPXtjCgHxwytt |
| unpause_new_offers | GY2ZbMcXPPMRoodMVK5ueBiXomYN4f6XG1r4ERykHpvh |

## Drills 3+4 (throwaway praetorial-drill9-2611102218.praetorial-dev-1101.testnet)
| step | tx |
|---|---|
| create escrow account | 93yiP8SuconQy9PxLqmudHsPbkgLVW5tb6ZNchnUYm2X |
| deploy freeze-candidate-2 wasm caf134a4 | Fw9ow5y3E6fvAsaTMF9EaVihuw5WA5gS4ZWnHsA4EajC |
| new() | Ci58KbPpt68pgd1mVHQyvPVhaaeWY7jw31my8E4jNn8m |
| mint m2 / t2 / m3 | 65NQgZUXmBT7yqw3XSGfMDdH5pTjGSnu3tUhucPgEMid / 2UEnsV1PRvRBL28p8BXSuXXMEMxUq7yTqscVPzgNhqe8 / 5nWvmay4YLECML6nJLTNuggLZ2azaRCqUHUzraaVbkoG |
| open B (m2) / take B (t2) / open C (m3) | 4XSPCyGpvdySmjAEJpmq1MdBHGBNQ2LvbEQUtB5QEge6 / FFVjLiaxPuo6aUg6YuRSVAAqmwZ5dY6WSaDevea7ojaV / A8BvSmBUUVR8E3PjUCoqhjCWcjyWbgZWjev9PemqPsCD |
| emergency_refund before shutdown (refused) | ARRzCm9iEJofxDJbVSoE5qKuayRqV9hPLsGjZKVnQA8L |
| emergency_shutdown (guardian, immediate) | CnEg1hPXuKCX7ajzSD7CQ2V5V9BY4iK7ETxrKqNCSVt2 |
| unpause after shutdown (refused) / second shutdown (refused) | EoyJpLQFbDKiVLfX71r1YGaWw91scqycNbxkgtMTJCJ / 4HLa5xSM7awQsLUayxN9ExdidYcAwBVSkYG5ZahZ1ANf |
| emergency_refund bet 1 / bet 2 | 9eFCzZfAkG1gKBiuYDGiZhstWitgkuZuFtBurKtoQXpW / EgGwuTRAp3m3trF4GddSsN7kC3VzhqyfYKiBijVot8kL |
| drill 3: retry_payout line 1 / drain_payouts bet 1 / drain_payouts bet 2 | 6pcNsR5sQgKdqzgqeRR2eBk4BnTQGBkq7yBgT8DNR7YY / BDMLYRCUA6LUmuQy37ZicqEWp3ESGMs6GLHDffC7wgor / AZSshobHCZ3kCHYYyZh4TQRxW9vLnMSCiykbjDrF6tUj |
| reclaim D-E2E1a: state-wipe deploy / wipe call / DeleteAccount | 43RQHB5teDAaCEcd4T4ju46mgdkNR18BMV5nkED25KUR / ELzX9bVqNUwiqif3vHgfpn6im26DuxE6y1pusw9AvxVP / BxpXfqJpHt9SAKwzV8u5wy8TVxcszNV5MsL34371wY8x |
| delete guardian / m2 / t2 / m3 | D86cvaRqnLvY3TnDw6wbkQ7NAWL3juCkUAG23c63pDGC / 13uiAuU7ZFAgm1uQiemm4tzcWUdwELs6QZ3wF5PvFtg4 / 5zHwpEQ15aYqXADxnPe8BnZLV4sCZMpZEyx2R92M6wi / GW2TTv2kiqHLJfMj5Qk3syWmkTWWVvLyTfQCtVQdbK3b |
