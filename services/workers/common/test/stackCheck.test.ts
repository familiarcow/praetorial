// STACK1 RED: the deployed-stack check core (scripts/check-deployed-stack.mjs wraps it). Unit tests on RECORDED /health responses (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateStack, buildWorkerSpecs, releaseEscrowId, runStackCheck, formatLine, STACK_WORKERS, type Probe, type WorkerSpec } from "../src/stackCheck.js";

const WORKERS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tomls = (): Record<string, string> => Object.fromEntries(STACK_WORKERS.map((n) => [n, fs.readFileSync(path.join(WORKERS, n, "wrangler.toml"), "utf8")]));
const RELEASE = JSON.parse(fs.readFileSync(path.resolve(WORKERS, "../../release/freeze-candidate-2.json"), "utf8"));
const ESC = "praetorial-frz3-2611100414.praetorial-dev-1101.testnet";
const NOW = Date.parse("2026-11-09T18:00:00.000Z");
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();

// Recorded healthy responses (shape = what each Worker's GET /health returns).
const good = (): Record<string, Probe> => ({
  indexer: { status: 200, body: { ok: true, service: "indexer", network: "testnet", escrow_contract_id: ESC, git_sha: "a1b2c3d", last_tick_at: iso(40_000), bets_cached: 26 } },
  keeper: { status: 200, body: { ok: true, service: "keeper", network: "testnet", escrow_contract_id: ESC, git_sha: "a1b2c3d", last_tick_at: iso(70_000) } },
  monitor: { status: 200, body: { ok: true, service: "monitor", network: "testnet", escrow_contract_id: ESC, git_sha: "a1b2c3d", last_tick_at: iso(65_000) } },
  notifier: { status: 200, body: { ok: true, service: "notifier", network: "testnet", escrow_contract_id: ESC, git_sha: "a1b2c3d" } },
  relayer: { status: 200, body: { ok: true, service: "relayer", network: "testnet", escrow_contract_id: ESC, git_sha: "a1b2c3d" } },
  registry: { status: 200, body: { ok: true, service: "registry", network: "testnet", registry_id: "registry.praetorial.testnet", git_sha: "a1b2c3d" } },
  sourcecheck: { status: 200, body: { ok: true, service: "sourcecheck", network: "testnet", escrow_contract_id: ESC, git_sha: "a1b2c3d" } },
  funding: { status: 200, body: { ok: true, service: "funding", network: "testnet", escrow_contract_id: ESC, git_sha: "a1b2c3d", keyConfigured: true } },
});
const specs = (): WorkerSpec[] => buildWorkerSpecs(tomls(), "testnet", "familiarcow").specs;
const run = (probes: Record<string, Probe>) => evaluateStack({ network: "testnet", expectedEscrow: ESC, specs: specs(), probes, nowMs: NOW });
const mutate = (service: string, f: (b: any) => void): Record<string, Probe> => { const p = good(); const b = structuredClone((p[service] as any).body); f(b); p[service] = { status: 200, body: b }; return p; };

test("STACK_WORKERS is the eight Workers (F1 adds funding)", () => {
  assert.deepEqual([...STACK_WORKERS].sort(), ["funding", "indexer", "keeper", "monitor", "notifier", "registry", "relayer", "sourcecheck"]);
});

test("releaseEscrowId: reads the testnet escrow account from the release record; mainnet has none in this record", () => {
  assert.equal(releaseEscrowId(RELEASE, "testnet"), ESC);
  assert.equal(releaseEscrowId(RELEASE, "mainnet"), null);
});

test("buildWorkerSpecs: public Workers get <name>.<subdomain>.workers.dev; private ones (workers_dev=false) go through the keeper; cron minutes from the keeper cron", () => {
  const { specs: s } = buildWorkerSpecs(tomls(), "testnet", "familiarcow");
  const by = Object.fromEntries(s.map((x) => [x.service, x]));
  assert.equal(by.indexer!.url, "https://praetorial-indexer-testnet.familiarcow.workers.dev/health");
  assert.equal(by.keeper!.url, "https://praetorial-keeper-testnet.familiarcow.workers.dev/health");
  assert.equal(by.monitor!.url, "https://praetorial-keeper-testnet.familiarcow.workers.dev/health/monitor");
  assert.equal(by.notifier!.url, "https://praetorial-keeper-testnet.familiarcow.workers.dev/health/notifier");
  assert.equal(by.registry!.url, "https://praetorial-registry-testnet.familiarcow.workers.dev/health");
  assert.equal(by.sourcecheck!.url, "https://praetorial-sourcecheck-testnet.familiarcow.workers.dev/health");
  assert.equal(by.relayer!.url, "https://praetorial-relayer-testnet.familiarcow.workers.dev/health");
  assert.equal(by.funding!.url, "https://praetorial-funding-testnet.familiarcow.workers.dev/health");
  assert.deepEqual(s.filter((x) => x.cronMinutes !== undefined).map((x) => [x.service, x.cronMinutes]).sort(), [["indexer", 1], ["keeper", 1], ["monitor", 1]]);
  assert.equal(by.registry!.expectedRegistryId, "registry.praetorial.testnet");
});

test("all eight healthy: eight PASS lines, no FAIL", () => {
  const lines = run(good());
  assert.equal(lines.length, 8);
  assert.ok(lines.every((l) => l.ok), JSON.stringify(lines.filter((l) => !l.ok)));
  assert.ok(lines.every((l) => /^PASS /.test(formatLine(l))));
});

test("FAIL: unreachable Worker (network error) and non-200", () => {
  const p = good(); p.relayer = { error: "fetch failed" }; p.sourcecheck = { status: 503, body: "upstream down" };
  const l = run(p);
  assert.match(formatLine(l.find((x) => x.service === "relayer")!), /^FAIL .*relayer.*unreachable/);
  assert.match(formatLine(l.find((x) => x.service === "sourcecheck")!), /^FAIL .*sourcecheck.*HTTP 503/);
  assert.equal(l.filter((x) => !x.ok).length, 2);
});

test("FAIL: escrow id differs from the release record (any escrow Worker)", () => {
  for (const svc of ["indexer", "keeper", "monitor", "notifier", "relayer", "sourcecheck"]) {
    const l = run(mutate(svc, (b) => { b.escrow_contract_id = "old-escrow.testnet"; }));
    const bad = l.filter((x) => !x.ok); assert.equal(bad.length, 1, svc);
    assert.match(formatLine(bad[0]!), /escrow/); assert.match(formatLine(bad[0]!), /old-escrow\.testnet/);
  }
  assert.ok(!run(mutate("keeper", (b) => { delete b.escrow_contract_id; })).every((x) => x.ok), "missing escrow id is a FAIL");
});

test("FAIL: registry_id differs from its wrangler REGISTRY_ID", () => {
  const l = run(mutate("registry", (b) => { b.registry_id = "registry.other.testnet"; }));
  assert.match(formatLine(l.find((x) => !x.ok)!), /registry_id/);
});

test("FAIL: wrong network", () => {
  const l = run(mutate("indexer", (b) => { b.network = "mainnet"; }));
  assert.match(formatLine(l.find((x) => !x.ok)!), /network.*mainnet/);
});

test("FAIL: git_sha unknown / empty / missing", () => {
  for (const v of ["unknown", "", undefined]) {
    const l = run(mutate("registry", (b) => { if (v === undefined) delete b.git_sha; else b.git_sha = v; }));
    const bad = l.filter((x) => !x.ok); assert.equal(bad.length, 1, String(v));
    assert.match(formatLine(bad[0]!), /git_sha/);
  }
});

test("FAIL: service name in the body differs from the Worker asked", () => {
  assert.ok(!run(mutate("monitor", (b) => { b.service = "notifier"; })).every((x) => x.ok));
});

test("cron Workers: last_tick_at older than 3x the cron interval FAILs; exactly 3x passes; null/missing/garbage FAILs", () => {
  const at = (svc: string, ago: number | null | "missing" | "garbage") => run(mutate(svc, (b) => { if (ago === "missing") delete b.last_tick_at; else b.last_tick_at = ago === null ? null : ago === "garbage" ? "not-a-date" : iso(ago); }));
  for (const svc of ["keeper", "monitor", "indexer"]) {
    assert.ok(at(svc, 180_000).every((x) => x.ok), `${svc} at exactly 3x (3 min) passes`);
    const stale = at(svc, 181_000).filter((x) => !x.ok); assert.equal(stale.length, 1, svc);
    assert.match(formatLine(stale[0]!), /last_tick_at.*older than 3x/);
    for (const v of [null, "missing", "garbage"] as const) assert.equal(at(svc, v).filter((x) => !x.ok).length, 1, `${svc} ${v}`);
  }
  // a timestamp far in the future (clock skew beyond tolerance) is not "fresh" either
  assert.ok(at("keeper", -3_600_000).some((x) => !x.ok));
});

test("non-cron Workers are not tick-checked (notifier/relayer/registry/sourcecheck carry no last_tick_at)", () => {
  assert.ok(run(good()).filter((x) => ["notifier", "relayer", "registry", "sourcecheck"].includes(x.service)).every((x) => x.ok));
});

test("mainnet: a release record without a mainnet escrow id fails every escrow Worker (never silently passes)", () => {
  const l = evaluateStack({ network: "mainnet", expectedEscrow: null, specs: specs(), probes: good(), nowMs: NOW });
  assert.ok(l.filter((x) => !x.ok).length >= 6);
});

test("runStackCheck: fetches every URL with an injected fetch, unreachable = FAIL, overall exit code 1", async () => {
  const bodies = good(); const seen: string[] = [];
  const byUrl = new Map(specs().map((s) => [s.url, s.service]));
  const fetchImpl = async (url: string): Promise<Response> => {
    seen.push(url);
    const svc = byUrl.get(url)!;
    if (svc === "relayer") throw new Error("connect ECONNREFUSED");
    const p = bodies[svc] as { status: number; body: unknown };
    return new Response(JSON.stringify(p.body), { status: p.status, headers: { "content-type": "application/json" } });
  };
  const r = await runStackCheck({ network: "testnet", expectedEscrow: ESC, specs: specs(), fetchImpl: fetchImpl as any, nowMs: NOW });
  assert.equal(seen.length, 8);
  assert.equal(r.exitCode, 1);
  assert.equal(r.lines.length, 8);
  assert.match(r.lines.find((l) => /relayer/.test(l))!, /^FAIL /);
  const ok = await runStackCheck({ network: "testnet", expectedEscrow: ESC, specs: specs(), fetchImpl: (async (u: string) => new Response(JSON.stringify((bodies[byUrl.get(u)!] as any).body))) as any, nowMs: NOW });
  assert.equal(ok.exitCode, 0);
});
