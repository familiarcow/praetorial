// FE6 (S6, D-UX21): source preflight step -- plain-English failures, freshness timer, human-mode skip, typed client errors/timeout.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  plainSourceReason, plainPreflightFailure, preflightApplies, attestationTimeLeftMs, formatTimeLeft, checkedAtLabel, PREFLIGHT_STEPS,
} from "../lib/sourcePreflight";
import { requestSourceCheck, SourceCheckFailedError, SOURCECHECK_FRESHNESS_NS } from "../lib/sourceCheckClient";

test("plainSourceReason maps every resolver blocked-fetch reason to plain English with no codes", () => {
  const cases: Array<[string, RegExp]> = [
    ["HTTP 403 (non-2xx)", /won't let us in|blocks automated/i],
    ["HTTP 429 (non-2xx)", /too many requests|slow down/i],
    ["HTTP 404 (non-2xx)", /page (isn't|is not) there|not found/i],
    ["HTTP 503 (non-2xx)", /down|trouble/i],
    ["login wall", /log ?in|sign in/i],
    ["captcha / bot challenge page", /check that you're human|bot/i],
    ["empty or whitespace-only body", /empty/i],
    ["invalid or truncated JSON body", /can't read|unreadable/i],
    ["wrong content-type for JSON source: text/html", /isn't the kind of data|wrong kind/i],
  ];
  for (const [raw, re] of cases) {
    const t = plainSourceReason(raw);
    assert.match(t, re, `${raw} -> ${t}`);
    assert.doesNotMatch(t, /HTTP|non-2xx|content-type|JSON|\b40\d\b|\b50\d\b/, `no jargon: ${t}`);
  }
});
test("plainSourceReason: an unknown reason gets a generic plain sentence, never the raw text", () => {
  const t = plainSourceReason("zzz weird internal thing");
  assert.doesNotMatch(t, /zzz/);
  assert.ok(t.length > 10);
});
test("plainPreflightFailure: unreachable lists each source with its own reason, plus the S6 closing advice", () => {
  const f = plainPreflightFailure("unreachable", [{ id: "nws", reason: "HTTP 403 (non-2xx)" }, { id: "espn", reason: "login wall" }]);
  assert.match(f.headline, /^The AI can't settle this as written: /);
  assert.match(f.headline, /Change the page or the wording, or pick a person to decide\.$/);
  assert.equal(f.lines.length, 2);
  assert.equal(f.lines[0].source, "nws");
  assert.match(f.lines[1].reason, /log ?in|sign in/i);
});
test("plainPreflightFailure: timeout / rate limit use the settled S6 sentences", () => {
  assert.equal(plainPreflightFailure("timeout", []).headline, "The check is taking too long. Retry.");
  assert.equal(plainPreflightFailure("rate_limit", []).headline, "Too many checks. Try again in a minute.");
  assert.equal(plainPreflightFailure("service", []).headline, "Checking sources is unavailable. You can still make a bet with a person as referee.");
});
test("preflightApplies is false in human mode (a named referee) and true for the AI", () => {
  assert.equal(preflightApplies(null), true);
  assert.equal(preflightApplies("alice.near"), false);
});
test("attestationTimeLeftMs counts down from the contract's freshness window and floors at 0", () => {
  const nowMs = 1_800_000_000_000;
  const checkedNs = BigInt(nowMs - 10 * 60_000) * 1_000_000n;
  assert.equal(attestationTimeLeftMs(checkedNs, nowMs), Number(SOURCECHECK_FRESHNESS_NS / 1_000_000n) - 10 * 60_000);
  assert.equal(attestationTimeLeftMs(BigInt(nowMs - 2 * 3_600_000) * 1_000_000n, nowMs), 0);
  assert.equal(attestationTimeLeftMs(BigInt(nowMs + 5000) * 1_000_000n, nowMs), 0); // future checked_at is never usable
});
test("formatTimeLeft / checkedAtLabel", () => {
  assert.equal(formatTimeLeft(50 * 60_000 + 5_000), "50:05");
  assert.equal(formatTimeLeft(0), "0:00");
  assert.equal(checkedAtLabel(BigInt(Date.UTC(2026, 10, 8, 14, 5)) * 1_000_000n), "14:05 UTC");
});
test("progress list has the three settled S6 steps", () => {
  assert.deepEqual(PREFLIGHT_STEPS, ["Reaching the sources", "Reading the pages", "Checking the answer can be found"]);
});

function mockFetch(impl: (url: string, init: any) => Promise<Response>) { (globalThis as any).fetch = impl; }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("requestSourceCheck: unreachable sources -> typed error with kind and per-source reasons", async () => {
  mockFetch(async () => json(200, { ok: false, spec_hash: "h", checked_at: "1", unreachable: [{ id: "nws", reason: "HTTP 403 (non-2xx)" }] }));
  await assert.rejects(requestSourceCheck("h", "t", "http://x/sc"), (e: any) =>
    e instanceof SourceCheckFailedError && e.kind === "unreachable" && e.sources.length === 1 && e.sources[0].id === "nws");
});
test("requestSourceCheck: HTTP 429 -> rate_limit", async () => {
  mockFetch(async () => json(429, { ok: false }));
  await assert.rejects(requestSourceCheck("h", "t", "http://x/sc"), (e: any) => e instanceof SourceCheckFailedError && e.kind === "rate_limit");
});
test("requestSourceCheck: network failure -> service", async () => {
  mockFetch(async () => { throw new TypeError("failed to fetch"); });
  await assert.rejects(requestSourceCheck("h", "t", "http://x/sc"), (e: any) => e.kind === "service");
});
test("requestSourceCheck: a request that never answers times out -> timeout", async () => {
  mockFetch((_u, init) => new Promise((_res, rej) => { init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))); }));
  const t0 = Date.now();
  await assert.rejects(requestSourceCheck("h", "t", "http://x/sc", 50), (e: any) => e instanceof SourceCheckFailedError && e.kind === "timeout");
  assert.ok(Date.now() - t0 < 2000);
});
test("requestSourceCheck: stale -> stale kind", async () => {
  mockFetch(async () => json(200, { ok: true, spec_hash: "h", checked_at: "1", unreachable: [], signing: { signature_hex: "aa" } }));
  await assert.rejects(requestSourceCheck("h", "t", "http://x/sc"), (e: any) => e.kind === "stale");
});

// WEBRL1 (D-SRCRL1 pt 4): the Worker's 429 carries {scope: ip|global, reason} + a retry-after header (seconds).
const r429 = (body: unknown, retryAfter?: string) => new Response(JSON.stringify(body), { status: 429, headers: { "content-type": "application/json", ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }) } });
async function rateErr(res: Response): Promise<SourceCheckFailedError> {
  mockFetch(async () => res);
  try { await requestSourceCheck("h", "t", "http://x/sc"); } catch (e: any) { return e; }
  throw new Error("expected a rejection");
}
test("WEBRL1: 429 scope ip + retry-after 1800 -> rate-limited, minutes = 30, plain headline", async () => {
  const e = await rateErr(r429({ ok: false, scope: "ip", reason: "rate limit" }, "1800"));
  assert.equal(e.kind, "rate_limit");
  const f = plainPreflightFailure(e.kind, e.sources, e.rateLimit);
  assert.equal(f.state, "rate-limited");
  assert.equal(f.minutes, 30);
  assert.equal(f.headline, "Too many checks right now. Try again in 30 minutes.");
  assert.equal(f.retry, true);
});
test("WEBRL1: retry-after rounds up to whole minutes; 1 minute is singular", async () => {
  const a = plainPreflightFailure("rate_limit", [], (await rateErr(r429({ ok: false, scope: "ip" }, "61"))).rateLimit);
  assert.equal(a.minutes, 2);
  const b = plainPreflightFailure("rate_limit", [], (await rateErr(r429({ ok: false, scope: "ip" }, "30"))).rateLimit);
  assert.equal(b.minutes, 1);
  assert.equal(b.headline, "Too many checks right now. Try again in 1 minute.");
});
test("WEBRL1: scope global says try again tomorrow, whatever retry-after is", async () => {
  const e = await rateErr(r429({ ok: false, scope: "global" }, "40000"));
  const f = plainPreflightFailure(e.kind, e.sources, e.rateLimit);
  assert.equal(f.state, "rate-limited");
  assert.equal(f.headline, "Too many checks right now. Try again tomorrow.");
});
test("WEBRL1: missing / garbage / non-positive retry-after never shows a number and never throws", async () => {
  for (const h of [undefined, "", "soon", "NaN", "-5", "0", "Wed, 21 Oct 2026 07:28:00 GMT"]) {
    const e = await rateErr(r429({ ok: false, scope: "ip" }, h));
    assert.equal(e.kind, "rate_limit", String(h));
    const f = plainPreflightFailure(e.kind, e.sources, e.rateLimit);
    assert.equal(f.state, "rate-limited", String(h));
    assert.equal(f.minutes, undefined, String(h));
    assert.match(f.headline, /^Too many checks/, String(h));
    assert.doesNotMatch(f.headline, /\d|NaN|undefined|taking too long/, String(h));
  }
});
test("WEBRL1: a 429 with a non-JSON body still maps to rate_limit; unknown scope is treated as ip", async () => {
  const e = await rateErr(new Response("<html>slow down</html>", { status: 429, headers: { "retry-after": "600" } }));
  assert.equal(e.kind, "rate_limit");
  assert.equal(plainPreflightFailure(e.kind, e.sources, e.rateLimit).minutes, 10);
});
test("WEBRL1: timeout behaviour is unchanged", () => {
  const f = plainPreflightFailure("timeout", []);
  assert.equal(f.headline, "The check is taking too long. Retry.");
  assert.equal(f.state, undefined);
});

// LIVE2 / SRCREF1: the Worker's own refusal reason (e.g. its 422 lint text) must reach the user, never a generic error.
const LINT_REASON = "term sheet failed lint: need >= 2 independent, non-party-controlled origins (publisher strings that share an origin count once)";
test("SRCREF1 requestSourceCheck: a 422 lint refusal -> kind 'rejected' carrying the Worker's exact reason", async () => {
  mockFetch(async () => new Response(JSON.stringify({ ok: false, reason: LINT_REASON, problems: ["x"], unreachable: [] }), { status: 422, headers: { "content-type": "application/json" } }));
  await assert.rejects(requestSourceCheck("h", "t", "http://x/sc"), (e: any) =>
    e instanceof SourceCheckFailedError && e.kind === "rejected" && e.workerReason === LINT_REASON && e.message.includes(LINT_REASON));
});
test("SRCREF1 requestSourceCheck: a 5xx with a reason keeps that reason too", async () => {
  mockFetch(async () => new Response(JSON.stringify({ ok: false, reason: "OutLayer sourcecheck failed: boom", unreachable: [] }), { status: 502, headers: { "content-type": "application/json" } }));
  await assert.rejects(requestSourceCheck("h", "t", "http://x/sc"), (e: any) => e instanceof SourceCheckFailedError && e.workerReason === "OutLayer sourcecheck failed: boom");
});
test("SRCREF1 plainPreflightFailure: 'rejected' shows the Worker's reason as detail, no retry", () => {
  const f = plainPreflightFailure("rejected", [], undefined, LINT_REASON);
  assert.equal(f.detail, LINT_REASON);
  assert.equal(f.retry, false);
  assert.match(f.headline, /can't open/i);
  assert.equal(plainPreflightFailure("bad_response", [], undefined, "OutLayer sourcecheck failed: boom").detail, "OutLayer sourcecheck failed: boom");
});
