// F1: the real bundle in workerd (miniflare), SQLite Durable Object on, every outbound fetch mocked (no real 1Click call).
// Proves end to end: User-Agent + Accept + X-API-Key reach 1Click; the ONECLICK_API_KEY never appears in any response body,
// response header or log line (including on upstream errors); the deployed config verifies quotes with 1Click's REAL manager key
// (a quote signed by anyone else is refused and nothing is stored).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { TOKENS, fakeOneClick, ACCOUNT, TRON_USDT, USDC } from "./helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEY = "eyJhbGciOiJIUzI1NiJ9.MINIFLARE-FAKE-ONECLICK-KEY.c2lnbmF0dXJlMDEyMzQ1Njc4OQ";
const ORIGIN = "https://praetorial-web-testnet.familiarcow.workers.dev";

test("workerd: headers to 1Click, key never leaks (bodies, headers, logs), real manager key enforced, DO store works", async () => {
  const script = (await build({ entryPoints: [path.join(HERE, "../src/index.ts")], bundle: true, format: "esm", platform: "browser", target: "es2022", write: false, logLevel: "silent" })).outputFiles[0]!.text;
  const toml = fs.readFileSync(path.join(HERE, "../wrangler.toml"), "utf8");
  const vars = Object.fromEntries([...toml.split(/^\[env\.mainnet\]/m)[0]!.split(/^\[vars\]/m)[1]!.matchAll(/^([A-Z_]+)\s*=\s*"([^"]*)"/gm)].map((m) => [m[1]!, m[2]!]));
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fake = fakeOneClick();
  let mode: "ok" | "down" = "ok";
  const outbound = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    seen.push({ url: req.url, headers: Object.fromEntries(req.headers) });
    if (url.hostname !== "1click.chaindefuser.com") throw new Error(`unexpected outbound ${url.hostname}`);
    if (mode === "down") return new Response(`upstream echo: x-api-key=${req.headers.get("x-api-key")}`, { status: 500 });
    if (url.pathname === "/v0/tokens") return Response.json(TOKENS);
    if (url.pathname === "/v0/quote") return Response.json(await fake.quote(await req.json() as any), { status: 201 });
    return Response.json({ message: "not found" }, { status: 404 });
  };
  const logs: string[] = [];
  const stdio = (stdout: NodeJS.ReadableStream, stderr: NodeJS.ReadableStream) => { stdout.on("data", (d: unknown) => logs.push(String(d))); stderr.on("data", (d: unknown) => logs.push(String(d))); };
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), "f1-do-"));
  const mf = new Miniflare({
    modules: true, script, compatibilityDate: "2026-01-01",
    durableObjects: { FUNDING_STORE: { className: "FundingStoreDO", useSQLite: true } }, durableObjectsPersist: persist,
    bindings: { ...vars, GIT_SHA: "0123456789ab", ONECLICK_API_KEY: KEY },
    outboundService: outbound as any,
    handleRuntimeStdio: stdio,
  });
  const responses: string[] = [];
  const go = async (p: string, init: RequestInit = {}) => {
    const r = await mf.dispatchFetch(`https://funding.test${p}`, { ...init, headers: { origin: ORIGIN, "cf-connecting-ip": "203.0.113.1", ...(init.headers as any) } } as any);
    const text = await r.text();
    responses.push(text, JSON.stringify([...r.headers]));
    return { status: r.status, text, json: text ? JSON.parse(text) : null };
  };
  try {
    assert.equal(vars.FUNDING_DRY_ONLY, "1", "testnet vars are dry-only");
    const h = await go("/health");
    assert.equal(h.json.service, "funding");
    assert.equal(h.json.keyConfigured, true);

    const t = await go("/tokens");
    assert.equal(t.status, 200, t.text);
    const dry = await go("/fund/quote", { method: "POST", body: JSON.stringify({ account: ACCOUNT, originAsset: TRON_USDT, betWith: USDC, amountIn: "50000000", dry: true }) });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.json.depositAddress, null);
    const real = await go("/fund/quote", { method: "POST", body: JSON.stringify({ account: ACCOUNT, originAsset: TRON_USDT, betWith: USDC, amountIn: "50000000", dry: false }) });
    assert.equal(real.status, 403, "testnet config refuses real quotes");

    for (const s of seen) {
      assert.equal(s.headers["user-agent"], "praetorial-funding/0123456789ab", s.url);
      assert.equal(s.headers["accept"], "application/json");
      assert.equal(s.headers["x-api-key"], KEY, "the key goes to 1Click, and only there");
    }
    mode = "down";
    const down = await go("/withdraw/quote", { method: "POST", body: JSON.stringify({ account: ACCOUNT, kind: "convert", originAsset: TRON_USDT, amountIn: "1000000", destinationAsset: USDC, dry: true }) });
    assert.equal(down.status, 503, down.text);
    const list = await go(`/fund/list?account=${ACCOUNT}`);
    assert.deepEqual(list.json, [], "the DO store answers through workerd");
  } finally { await mf.dispose(); }

  // mainnet vars: real quotes are allowed, and a quote NOT signed by 1Click's real manager key is refused with nothing stored
  const mvars = Object.fromEntries([...toml.split(/^\[env\.mainnet\.vars\]/m)[1]!.matchAll(/^([A-Z_]+)\s*=\s*"([^"]*)"/gm)].map((m) => [m[1]!, m[2]!]));
  mode = "ok";
  const mf2 = new Miniflare({
    modules: true, script, compatibilityDate: "2026-01-01",
    durableObjects: { FUNDING_STORE: { className: "FundingStoreDO", useSQLite: true } }, durableObjectsPersist: fs.mkdtempSync(path.join(os.tmpdir(), "f1-do2-")),
    bindings: { ...mvars, GIT_SHA: "0123456789ab", ONECLICK_API_KEY: KEY }, outboundService: outbound as any,
    handleRuntimeStdio: stdio,
  });
  try {
    const r = await mf2.dispatchFetch("https://funding.test/fund/quote", { method: "POST", headers: { origin: "https://praetorial.com", "cf-connecting-ip": "203.0.113.2" }, body: JSON.stringify({ account: ACCOUNT, originAsset: TRON_USDT, betWith: USDC, amountIn: "50000000", dry: false }) });
    const text = await r.text(); responses.push(text);
    assert.equal(r.status, 502, text);
    assert.equal(JSON.parse(text).code, "bad_signature");
    const l = await mf2.dispatchFetch(`https://funding.test/fund/list?account=${ACCOUNT}`, { headers: { "cf-connecting-ip": "203.0.113.2" } });
    assert.deepEqual(await l.json(), []);
  } finally { await mf2.dispose(); }

  await new Promise((r) => setTimeout(r, 50));
  const all = responses.join("\n") + logs.join("\n");
  assert.ok(logs.join("").includes('"svc":"funding"'), "the Worker's log lines were captured");
  assert.ok(!all.includes(KEY) && !all.includes("MINIFLARE-FAKE-ONECLICK-KEY"), "the 1Click key appears in no response and no log line");
});
