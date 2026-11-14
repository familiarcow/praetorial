# FE10d findings (inconclusive; no code change merged)

Item: intermittent 150 s test timeouts in the mocked Playwright suite when two full runs share the machine.

Reproduced (cold `.vite` cache in both trees, two full mocked runs started together, each on its own free port, separate node_modules/.vite):
- both trees hung (2.5 m = 150 s test timeout) at the SAME spec position: fe3b.spec.ts:132, fe4b.spec.ts:77, fe4b.spec.ts:106 (tests ~48-50), not on the first test.
- the same specs pass in 4 s alone on a cold cache; a full mocked run alone on a cold cache passes (151 passed, 3.9 m) with no "new dependencies optimized / reloading" line in vite output.

Ruled out (evidence):
- free-port race: ports differed (52522/52523), PW_CI=1 + strictPort, each webServer log shows its own vite "ready".
- shared dep cache: the two trees have separate apps/web/node_modules/.vite.
- cold dep re-optimisation/reload: vite log shows none on a cold full solo run.
- readiness check: playwright's check returns 200 for index.html in ~0.4 s (before any dep is bundled) but nothing observed breaks because of it.

Not yet explained: why the same specs hang in both concurrent runs. A third playwright run (another track, ~/praetorial) was also live at that time, so load was 3 suites on 12 cores.
Next hypothesis: those specs rely on a page.route'd localhost:8788/8790 or ticker request that, under load, falls through to a real network call that never resolves; run with `DEBUG=pw:api` + a `page.on("requestfailed"/"console")` dump on a hung run to see the pending request. Also capture `__e2e` state in the page at timeout.

## FE10e root cause + fix
- Probe (request log over fe3b+fe4b): every mocked test fires REAL requests nobody mocked: `GET auth.privy.io/api/v1/apps/<id>` (the Privy app-config fetch that gates `usePrivy().ready`, hence `window.__e2e.ready`), `auth.privy.io/.../analytics_events`, `.../embedded-wallets`, `explorer-api.walletconnect.com/v3/wallets` (x2), `csp-report.browser-intake-datadoghq.com`; plus `1click.chaindefuser.com/v0/tokens` in app-shell/username-addmoney/addmoney-handoff-settings. fe3b/fe4b wait on `__e2e.ready`, so a slow/stalled real auth.privy.io (rate-limit or latency when 2-3 suites share one IP) hangs them to 150 s.
- Mechanism proof: with `auth.privy.io/**` routed to never answer, `page.goto("/new")` + `waitForFunction(__e2e.ready)` does not return within 120 s (shell timeout) in a solo run.
- The hang itself was NOT reproduced again on the concurrent runs after FE10d (3 concurrent full runs incl. an unguarded main run were green), so the link to the original hangs is by mechanism, not by capture.
- Fix: tests/e2eGuard.ts (every mocked spec imports test/expect from it): context-level lowest-priority catch-all. localhost passes; Privy app config served from the recorded fixtures/privyAppConfig.json; other Privy/WalletConnect/Datadog chatter gets an inert stub; anything else is aborted and FAILS the test naming the URL. No-op under PW_LIVE. Policy unit-tested in e2eGuardPolicy.unit.test.ts; e2e-guard.spec.ts proves block+fail and local Privy ready.

## FE10f: "balance read failure" RPC escape (root cause + fix)
- Reproduced: `username-addmoney.spec.ts -g "balance read failure" --repeat-each=40` solo: 3/40 failed (guard teardown: 4x `POST https://test.rpc.fastnear.com/` in `violations`).
- Root cause (not the guard): the spec swapped its RPC mock with `page.unroute(RPC)` then `mockRpc(...)`. AddMoney fires `load()` (balance) and `movableHoldings()` (several sequential RPC reads) in parallel; the balance failure renders the error while the holdings reads are still in flight, so their next requests land in the unroute gap, fall to the e2eGuard catch-all, get aborted and are recorded -> the test fails naming the RPC URL. The guard behaved correctly. Same gap exists for any `unroute` + `route` pair (also the "no bet in progress" test, same file).
- Deterministic proof: e2e-guard.spec.ts "documents the gap" (unroute then fetch -> guard violation; the app's own background POSTs also land there).
- Fix: tests/swappableRoute.ts (one registration delegating to a replaceable handler, never unrouted); `mockRpc` returns `setBalance()`; both swaps in username-addmoney.spec.ts use it. After: balance-read-failure x60 solo 60/60 green; whole file x8 at --workers=4 (120 tests) 120/120 green.
- Not changed (out of named scope, same unroute+route pattern): addmoney-handoff-settings.spec.ts:131, deposit-address.spec.ts:123.

## FE10g: remaining swap gaps
- `grep page.unroute` over tests/: addmoney-handoff-settings.spec.ts:131, deposit-address.spec.ts:123, human-referee.spec.ts:139 (`unrouteAll` inside a loop, then `setup()` again = a mid-test swap, not teardown). e2e-guard.spec.ts holds the only intentional `unroute` (documents the gap).
- Before (solo, --repeat-each=40): handoff "balance read fails" 0/40 failed; deposit-address "API error ... Retry" 0/40 failed; human-referee "bettors see the waiting view" 0/40 failed. The gap did not trigger in 40 runs for any of them (their in-flight requests are fewer/faster than FE10f's parallel holdings reads), so they are converted on the proven gap (e2e-guard "documents the gap"), not on observed failure.
- Fix: handoff mockRpc registers via swappableRoute and exposes `swap(h)`; deposit-address flips `api.mode` (read per request) instead of unroute+mockApi; human-referee sets up once with a mutable world (`w.me`), no unrouteAll.
- After: all three 40/40 green solo. No `page.unroute`/`unrouteAll` remains in a spec except the intentional one in e2e-guard.spec.ts.
