# CLOSE1: close-out audit (main `056395e9`, Fri 11-13 01:15–01:50 ET)

Read-only. Re-based on main `49890774` (MISS1 merged; it adds tests, evidence and DR9 harness scripts only, so no row changes). GET/RPC-view checks only; no deploys, pushes, transactions or paid calls. Full working tables (every row, with
file:line and test names) and the raw live evidence are in the team's working notes, which are not part of the public repository.
This public copy cites the team's private planning notes only by decision id (D-…) or as "launch plan".

**Verdict.** The code is built: 124 features audited, and about 95 are built, tested and live. The rest are listed in §1.
The workers match main. **The mainnet web app does not**: it is a build from before Thu 11-12, so SECREV1's web fixes, LFIX1's bond
guards, the TPL1–3 bet forms and the whole in-app Docs section the README sends judges to are **not live**. **No mainnet bet
has ever been made.** Eight MUST items stand between this and a credible submission (Sat 11-14 12:00 ET); six of them need familiarcow.

## 0. Live state

| Check | Result | Evidence |
|---|---|---|
| Worker `/health` git_sha | funding, indexer, relayer, sourcecheck = **`056395e9` (main)** (redeployed 01:15–01:20 ET). keeper, registry = `04075e21`; since then only a comment changed in `services/common/src/challengeBond.ts`, so **all workers are current** | `evidence/health.txt` (2 probes) |
| Web bundle service URLs | OK: `npm run build:mainnet` on main, then `node scripts/compare-live-bundle.mjs` → 8/8 live URLs in dist, exit 0. A redeploy drops nothing (1Click URL is in both) | `evidence/compare-live-bundle.txt` |
| Web bundle content | **STALE**: live entry `index-Cxt3Yv_k.js` ≠ main `index-CN8Zjvqr.js`. Live assigns `window.__e2e.signRawHash` (SR-3), has no `/docs` route | `evidence/live-web.txt` |
| Web security headers | **none** on live `/` (SR-4) | `curl -sI` |
| Mainnet bets | **none ever**: indexer `bets_cached: 0`; escrow `bet_count` 0, `get_bet` 0–3 null; nearblocks history = create, deploy+`new`, 2× `request_execution`, `DELETE_KEY`, keeper top-up | RPC view; nearblocks API |
| Escrow integrity | 0 access keys, code hash `EfCgMFhe…` = reproducible build, judge program `8791413f…` pinned, 4 judge pairs, fee 100 bps | RPC view (claims #16–20) |
| `praetorial.near` keys | temp full-access key `ed25519:6eWbyxb8…` **still present** | RPC `view_access_key_list` |

## 1. Built?  (rows not fully built + tested + live; MUST first)

| # | Feature (source) | Built | Tested | Live | Class |
|---|---|---|---|---|---|
| 1 | Everything web-side since 11-12: Docs `/docs/*` + Hackathon cards (README, DOCS1/2), `/guide/custom-bet` + AI bet (TPL3), coin selector / outperform / weather cities (TPL1), sports game picker (TPL2), CON-1/CON-5 bond guards + LIFE-5/6/7/8/11 (LFIX1), SR-3/4/5/8/10/12 + SR-1 client half (SECREV1) | yes (`components/docs/*`, `GamePicker.tsx`, `betLifecycle.ts:81`, `testHooks.ts:27`, `public/_headers`) | yes (`docs1.spec.ts`, `tpl1.spec.ts`, `game-picker.spec.ts`, `lfix1.unit`, `testHooks.unit` "SECREV1 SR-3", `securityHeaders.unit`) | **no**: web not redeployed | **MUST** (web deploy) |
| 2 | First mainnet bet + smoke M1–M8, incl. F5 ~$1 cash-out live test (launch plan, DOCS2, F5) | n/a | **not run** | no | **MUST** |
| 3 | Hackathon facts: team, repo URL, demo, `hackathon-submission` tag (README:163,169; `docsFacts.ts:101-103`) | **no**: `TODO(familiarcow)` placeholders; no tag | placeholders pinned by `docs1.unit` | no | **MUST** (familiarcow) |
| 4 | Cross-asset bets (each side a different token) (decision log D-PRICE1/6, D-UI1; Docs IntentsPage:46, HackathonPage:51) | partial: escrow yes; web create is same-asset only (`CreateOffer.tsx:170`, `openEnvelope.ts:93 taker_options: []`) | escrow only | escrow only | **MUST**: fix the Docs wording (claims #15); building it is POST |
| 5 | NEP-413 ownership proof on non-dry `/withdraw/quote`/`intent` (SR-1/6/14) | no (`funding/src/core.ts:227`) | no | no | FAMILIARCOW (DoS only; no money moves since SR-1 server fix is live) |
| 6 | SR-C3 keeper waits for game end on `game_winner` | no (`keeper/src/liveness.ts:44`) | no | no | FAMILIARCOW (until then: demo only same/next-day games) |
| 7 | SR-C1 alert when paid runs are burnt early | no (`monitor/src/stuckResolving.ts`) | no | no | POST (disclosure is MUST, §2 #6) |
| 8 | Script-restricting CSP (SR-4 rest); SR-8 nosniff misses `/_proxy/sports` and `/_proxy/kraken` (`worker/index.ts:44,47` return before header code); indexer `/tick` public on its own URL (SR-12); SR-7 fails open on RPC error; SR-2 varied-sheet drain | partial | partial | partial | POST (SR-2: FAMILIARCOW, §2) |
| 9 | Sponsored open-offer cap of 3 per person (decision log D5) | **dead code**: `services/common/src/offerCap.ts` imported only by its test | unit only | no | POST (relayer daily budget 1.4 NEAR bounds the cost) |
| 10 | Governance-proposal Telegram alerts (D-JUDGECHAIN1 pt 9, D-ASSET1) | dead code: `monitor/src/governanceEvents.ts` | unit only | no | POST |
| 11 | Monitor alert on NEAR AI 401/403 (D-DR9a); refund-rate metric (D-VOIDRATE1); exceededCpu paging (manual script) | no / no / partial | no | no | POST |
| 12 | Dispute panels 3→5 models, deferential appeal (D-DISPUTE1); judge reads dispute exhibits (D-AUDIT2); source snapshots in long bets on the Workers keeper (D-RESOLVE1c) | partial: escrow rounds + doubling bond yes; panels off in real-http (`main.rs:4192`), exhibits dropped, archive job node-only | escrow yes | partial | POST (check Docs don't promise panels) |
| 13 | Keeper key scoped to function calls (D-AUDIT5); treasury fee swaps (D-ECON2) | partial (mainnet keeper on full-access key, `release/mainnet-night/GAPS.md` W3); treasury dry-run only | partial | no | FAMILIARCOW / POST |
| 14 | Verifier shutdown-drill mode, DR8 root cause, D-RTE2 tiered retraction, settlement default 48h/72h (web caps at 24h), multi-escrow listing in web | no / partial | — | — | POST |
| 15 | M15 mainnet dispute test (LFIX1) | procedure only | not run (takes ≈2 days) | — | POST |

Everything else (~95 rows: escrow rules, judge, keeper, relayer, funding/1Click, registry, indexer, monitor core, verify tools,
login, create/take/concede/referee flows) is **built, tested and live**. See `work/built.md` for the evidence on each row.

## 2. Open items  (deduped from 48; MUST first)

| # | Item | Class | Evidence | Next action |
|---|---|---|---|---|
| 1 | **Redeploy mainnet web** (closes §1 #1, claims #1–3, #11, #12) | **MUST** | live entry `index-Cxt3Yv_k.js`; `compare-live-bundle` OK so safe to ship | After #2, #4, #6 copy lands: build:mainnet + guard + `check:live:mainnet` (familiarcow GO) |
| 2 | `TODO(familiarcow)` placeholders: team, repo URL, demo (`docsFacts.ts:101-103`, `README.md:169`) | **MUST** / familiarcow | `git grep "TODO(familiarcow)"` | familiarcow gives values; agent updates + `docs1.unit` |
| 3 | Publish the public repo (option A keep history / B squash, org) | **MUST** / familiarcow | no remote (publish steps in the team's working notes) | familiarcow decides A/B + org |
| 4 | "Source code is not public yet" (`apps/web/lib/about.ts:142`, pinned by `v1About.unit.test.ts:29`) | **MUST** (after #3) | live and main | Swap for the repo link once #3 is done |
| 5 | **No mainnet bet**: run smoke M1–M8 (Add money, Cash out = F5 $1 test, cancel, BTC close, touch, concede, views); verify-bet on bet 1; fill Docs "mainnet evidence" | **MUST** / familiarcow | `bet_count` 0 | familiarcow runs with real funds (agents can't transact) |
| 6 | **Disclose SR-C1/SR-C2/SR-C4** (paid runs can be burnt → VOID refund; challenger bond risk on hash-only bets; custom-source errors VOID at once) on Trust page + README; fix overstated copy (§3 #4–#10) | **MUST** | no such wording in `components/docs` or README | Agent: copy-only change from SECREV1 "Trust model as built" + §3 fix wording |
| 7 | Demo video, X post, single submission; keep both web deploys up ≥ 11-18 | **MUST** / familiarcow | not started | familiarcow, after #5 |
| 8 | Privy: confirm mainnet origin allowed, turn **test login off** before sharing the link | **MUST** / familiarcow | not checkable from here | familiarcow, Privy dashboard |
| 9 | Delete temp full-access key `6eWbyxb8…` on `praetorial.near` | FAMILIARCOW | RPC `view_access_key_list` | `release/mainnet-night/RUNBOOK.md` step 15a |
| 10 | Confirm NEAR AI key spend cap; create Telegram alerts bot token + chat id (monitor can't alert anyone) | FAMILIARCOW | `release/mainnet-night/GAPS.md` B2, W1 | familiarcow; then wire the secret |
| 11 | Stake cap: none (10^34). Keep it, or the guardian proposes one (24 h delay, so after the deadline) | FAMILIARCOW | `lib/assets.ts:54` | Decide |
| 12 | Decide SR-1/6/14 ownership proof, SR-2 sourcecheck caps (≈0.31 NEAR/run with varied sheets), SR-C3 keeper rule, LIFE-10 early paid request | FAMILIARCOW | secrev1 REPORT Open 1–3; lfix1 §3 | Decide; until then, watch the attest balance and demo only near-term games |
| 13 | Top up keeper (0.4998 NEAR) and escrow headroom (≈1.08 NEAR) before demo traffic | FAMILIARCOW | nearblocks | Optional |
| 14 | SECREV1 Med/Low still open: SR-4 CSP, SR-7 per-IP, SR-8 gap on sports/kraken, SR-9, SR-11, SR-12 own-URL, SR-13, SR-C4/C5/C7/C8, SR-D1 `npm audit` | POST | secrev1 REPORT table | SECREV2 after submission |
| 15 | SR-C1/C2 contract fix; contract residuals CON-2/3, `in_flight` timeout, SR-C6 | POST | contract frozen | Next escrow version |
| 16 | SM1 leftovers (SVC-3, LIFE-5 tails, CON-6..10 etc.); smoke M9–M22 incl. M15 | POST | lfix1 §2-3 | After 11-14 |
| 17 | Verifier gaps (E4 for strangers, OutLayer attestation, evidence bundle); `secret_bind` PENDING in release record; `registry.praetorial.near` doesn't exist | POST | docs1/docs2 FOLLOWUPS | Before publishing if cheap |
| 18 | Keeper treats `send_tx` TIMEOUT as failure; test infra (`chaos/harness.mjs:75` machine-wide pkill, clock-dependent `climate-day-deadline.spec.ts`) | POST | keeplive, tfix1, lfix1 | Owners |
| 19 | Product follow-ups (game funding closes 00:00 UTC, payout card bond, NEP-145 storage, taker username picker…); open-questions still-open set | POST | `work/open.md` #30, #32 | Re-triage |
| 20 | DONE (15 items): SECREV1 worker fixes live (SR-1 server, SR-2 cache, SR-6, SR-7); LIFE-1 keeper; funding URL guard (DEPLOYFIX); LICENSE; fresh-clone 15/15 (PUB1); release txs; VERIFY.md record; pending product decisions #1–#10 | DONE | `/health` 056395e9; commits in `work/open.md` #34–48 | — |

## 3. Claims check  (false / overstated; 21 others verified TRUE, see `work/claims.md` #15–35)

| # | Claim | Where | Verdict | Fix wording |
|---|---|---|---|---|
| 1 | "Live: …/docs" and the `/docs`, `/docs/trust`, `/docs/hackathon` list | README.md:151-153 | **FALSE live** (no Docs route in live bundle) | Deploy web (§2 #1). Otherwise: "On main; live after the next web deploy." |
| 2 | Hackathon page cards, case studies, "Checked on 12 November" | `HackathonPage.tsx`, `mainnetEvidence.ts` | true on main, **not live** | Deploy web |
| 3 | "The `hackathon-submission` tag marks the submitted commit." | README.md:163 | **FALSE today** | Create the tag at submission; until then "will mark" |
| 4 | "`check-deployed-stack --network mainnet` = 8/8 PASS" | README.md:32 | **OVERSTATED** (as written: 7/8 FAIL) | "`check-deployed-stack --network mainnet --release release/mainnet-night/release-mainnet.json` = 8/8 PASS" |
| 5 | "each side can use a different token" / "or the same value in another token" | IntentsPage.tsx:46; HackathonPage.tsx:51,150 | **OVERSTATED** (escrow supports it; the app creates same-token bets only) | "The escrow supports a different token per side; the app currently creates bets where both sides use the same token." |
| 6 | "Nobody can run the judge again and again…" / "then pays the winner" / "the winner gets both stakes" | VerificationPage.tsx:19; README.md:12-13; about.ts:115 | **OVERSTATED** (SR-C1 High, SR-C3) | Add: "…unless no ruling can be made in time (for example someone uses up the 3 paid runs early); then both sides are refunded." |
| 7 | "the money goes back to each side, never to the wrong one" | VerificationPage.tsx:29 | **OVERSTATED** (SR-C2: challenger bond on hash-only bets; live CON-1/5) | "Stakes go back to each side, never to the wrong one. A challenge bond can be lost: see Trust › Known limits." |
| 8 | "the judge tries again for up to 7 days" (missing data) | WhatPage.tsx:60; VerificationPage.tsx:16; about.ts:116; TrustPage.tsx:37 | **OVERSTATED** (SR-C4: custom-source error → VOID at once) | "For built-in bet types the judge retries for up to 7 days. For custom bets, a source that can't be read ends the bet as a refund (VOID)." |
| 9 | "A page one bettor controls can't make the result alone." | TrustPage.tsx:36 | **OVERSTATED** (SR-C4/C8) | "…can't make the result YES or NO, but it can force a refund (VOID)." |
| 10 | Bond "returned if the challenge wins" | about.ts:114 (live /about) | **OVERSTATED live** (no LFIX1 guards live) | Deploy web; add "The app only offers a challenge when a re-judge can still run." |
| 11 | Website "cannot move money without your signature" | TrustPage.tsx:50-57 | true on main, **false live** (SR-3, SR-4) | Deploy web |
| 12 | E4 can be re-run "live" | docs/VERIFY.md:140-141 | **OVERSTATED for mainnet** (escrow has 0 keys) | "On mainnet, E4 is checked by reading the 4 recorded report-pubkey txs; a live re-run is testnet-only." |
| 13 | "No attack paid a wrong party" | docs/REDTEAM-RT1b.md:6 | **SUPERSEDED** | Add: "Superseded in part by SECREV1 SR-C1/SR-C2 (High)." |
| 14 | "two AI models from different companies" | README.md:11 | **OVERSTATED** (contract requires distinct models; the 4 mainnet pairs happen to be cross-company) | "Two different models (the current pairs are from different companies)." |
| 15 | 7-day refund "no fee is charged" | README.md:13 | **OVERSTATED** (on VOID of a keep-terms bet the terms-storage charge goes to the fee account, `contracts/escrow/src/lib.rs:3496`) | "No protocol fee; the small terms-storage charge is not refunded." |

Rows 1–2, 10 and 11 are fixed by the web redeploy alone. Rows 3–9 and 12–15 need copy changes on main first
(§2 #6), which have to land before that redeploy.
