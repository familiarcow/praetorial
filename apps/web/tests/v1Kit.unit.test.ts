// V1 kit: VerifySheet, VerifyRow, ActionReceipt in every state (/kit fixtures, real testnet bet 49). Each renders; raw account ids
// appear only inside Verify (STATES.md V1-1: @username first, the id under it); every row says how to check it; every sheet links
// to About › How to verify a bet and offers the download.
import "./lib/assetStubs";
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const kit = await import("../src/kit");
const { verifyStates } = await import("../src/kit/Playground");
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const E = (C: any, props: any) => React.createElement(C, props);
const now = Date.UTC(2026, 10, 11, 12);
const v = verifyStates(now);

/** The text outside every data-raw-ids="allowed" subtree (same rule as tests/betDetail.unit.test.ts). */
function outsideAllowed(h: string): string {
  let out = h;
  for (;;) {
    const i = out.indexOf('data-raw-ids="allowed"');
    if (i < 0) return out.replace(/<[^>]+>/g, " ");
    const start = out.lastIndexOf("<", i);
    const tag = out.slice(start + 1).match(/^[a-z0-9]+/)![0];
    const re = new RegExp(`<${tag}\\b|</${tag}>`, "g");
    re.lastIndex = start + 1;
    let depth = 1, end = out.length;
    for (let x = re.exec(out); x; x = re.exec(out)) { depth += x[0].startsWith("</") ? -1 : 1; if (depth === 0) { end = x.index + x[0].length; break; } }
    out = out.slice(0, start) + out.slice(end);
  }
}
const RAW = /\.near\b|\.testnet\b|\b[0-9a-f]{64}\b/;

test("VerifySheet: every state renders inside a raw-ids-allowed region, with how-to-check lines, the About link and the download", () => {
  assert.deepEqual(v.sheets.map((s) => s.key), ["ai", "loading", "gaps", "mismatch", "no-ruling", "referee"]);
  for (const s of v.sheets) {
    const h = html(E(kit.VerifySheet, { inline: true, data: s.data, onClose: () => {}, onDownload: () => {} }));
    assert.match(h, /data-kit="VerifySheet"/, s.key);
    assert.match(h, /data-raw-ids="allowed"/, s.key);
    assert.match(h, /href="\/docs\/verification#verify"/, s.key); // DOCS1: was /about#verify (still redirects)
    assert.match(h, /Download verification file/, s.key);
    assert.ok((h.match(/How to check: /g) ?? []).length >= s.data.sections.flatMap((x) => x.items).length, s.key);
    assert.deepEqual(outsideAllowed(h).split(/\s+/).filter((w) => RAW.test(w)), [], `${s.key}: a raw id outside Verify`);
  }
  const ai = html(E(kit.VerifySheet, { inline: true, data: v.sheets[0].data, onClose: () => {} }));
  for (const id of ["asked", "program", "where", "said", "accepted"]) assert.match(ai, new RegExp(`data-testid="verify-section-${id}"`));
  assert.match(ai, /data-status="ok"/);
  assert.match(ai, /Open on NearBlocks/);
  assert.match(ai, /curl -sL https:\/\/test\.fastfs\.io\//);
  assert.match(html(E(kit.VerifySheet, { inline: true, data: v.sheets.find((s) => s.key === "gaps")!.data, onClose: () => {} })), /data-testid="verify-gaps"/);
  assert.match(html(E(kit.VerifySheet, { inline: true, data: v.sheets.find((s) => s.key === "mismatch")!.data, onClose: () => {} })), /data-status="bad"/);
  const ref = html(E(kit.VerifySheet, { inline: true, data: v.sheets.find((s) => s.key === "referee")!.data, onClose: () => {} }));
  assert.match(ref, /@rita/);
  assert.ok(ref.indexOf("@rita") < ref.indexOf("bd647fa4"), "@username first, the id under it");
});

test("VerifyRow: every kind and status; ActionReceipt: found / relayed / paid / repeated / refused / loading / missing / unavailable", () => {
  for (const r of v.rows) {
    const h = html(E(kit.VerifyRow, { item: r.item }));
    assert.match(h, /How to check: /, r.key);
    if (r.item.status) assert.match(h, new RegExp(`data-status="${r.item.status}"`), r.key);
    if (r.item.command) assert.match(h, /data-testid="verify-cmd-/, r.key);
  }
  for (const r of v.receipts) {
    const h = html(E(kit.ActionReceipt, { receipt: r.r }));
    assert.match(h, /data-raw-ids="allowed"/, r.key);
    assert.match(h, new RegExp(`data-state="${r.r.state}"`), r.key);
    if (r.r.state === "found") assert.match(h, /Open on NearBlocks/, r.key);
    if (r.r.state === "missing" || r.r.state === "unavailable") assert.match(h, /data-testid="receipt-escrow"/, r.key);
  }
  const relayed = html(E(kit.ActionReceipt, { receipt: v.receipts.find((x) => x.key === "relayed")!.r }));
  assert.match(relayed, /Done by/); assert.match(relayed, /Praetorial relayer \(pays the gas\)/); assert.match(relayed, /5\.005 USDC/);
  const paid = html(E(kit.ActionReceipt, { receipt: v.receipts.find((x) => x.key === "paid")!.r }));
  assert.match(paid, /44 USDC/); assert.match(paid, /paid out to/);
  assert.match(html(E(kit.ActionReceipt, { receipt: v.receipts.find((x) => x.key === "refused")!.r })), /The escrow refused this transaction/);
});

test("ActivityList: every row with a receipt gets a closed Verify toggle; the ruling card and Details › AI judge offer Verify", () => {
  const h = html(E(kit.ActivityList, { entries: v.entries, defaultOpen: true }));
  assert.equal((h.match(/<summary>Verify<\/summary>/g) ?? []).length, v.entries.length);
  assert.doesNotMatch(h, /<details class="k-vtoggle"[^>]*open/);
  assert.deepEqual(outsideAllowed(h).split(/\s+/).filter((w) => RAW.test(w)), []);
  const plain = html(E(kit.ActivityList, { entries: v.entries.map(({ receipt, ...e }) => e) }));
  assert.doesNotMatch(plain, /Verify/, "no receipt, no toggle");
  assert.match(html(E(kit.RulingCard, { ruling: { kind: "ai", outcome: "YES", evidence: [], finalAt: null } as any, onVerify: () => {} })), /data-testid="ruling-verify"/);
});
