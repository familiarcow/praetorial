// L1b18: first init used attest1's `public_key` instead of `attest_public_key` (no setter exists) -> delete the escrow account (funds back to operator) and redo with the same name.
import { account, mk } from "./lib.mjs"; import * as C from "./config.mjs";
const { recordTx } = mk("./results.json");
const esc = await account(C.ESCROW); const r = await esc.deleteAccount(C.OPERATOR);
recordTx("delete_escrow_wrong_attest_key", r.transaction.hash, { status: "Success" });
