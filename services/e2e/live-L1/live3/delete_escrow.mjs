// L1b11: wrong attest pubkey was passed to new() (outcome key used instead of attest_public_key); delete the escrow account (funds -> operator) and recreate under the same name.
import { account, mk } from "./lib.mjs"; import * as C from "./config.mjs";
const { recordTx } = mk("./results.json");
const esc = await account(C.ESCROW); const r = await esc.deleteAccount(C.OPERATOR);
recordTx("delete_escrow_account_wrong_attest_key", r.transaction.hash, { status: "Success" });
