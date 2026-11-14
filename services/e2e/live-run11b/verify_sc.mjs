// Verify a sourcecheck log signature locally (node only; checked_at kept as a string to avoid u64 precision loss).
import fs from "node:fs"; import crypto from "node:crypto";
const t = fs.readFileSync(process.argv[2], "utf8");
const o = JSON.parse(t.slice(t.indexOf("{", t.indexOf("Tx:"))));
const s = o.signing;
const ca = t.match(/"checked_at":\s*(\d+)/)[1];
const msg = Buffer.from(`praetorial:sourcecheck:v1:${o.spec_hash}:${ca}`);
const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(s.pubkey_hex, "hex")]);
const ok = crypto.verify(null, msg, crypto.createPublicKey({ key: der, format: "der", type: "spki" }), Buffer.from(s.signature_hex, "hex"));
console.log(ok ? "VERIFIED" : "BAD", s.pubkey_hex, ca);
process.exit(ok ? 0 : 1);
