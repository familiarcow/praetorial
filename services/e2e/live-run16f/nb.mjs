import { account } from "./lib.mjs"; import * as C from "./config.mjs";
const a = await account(C.KEEPER);
const b = await a.viewFunction({ contractId: C.ESCROW, methodName: "get_bet", args: { bet_id: 1 } });
const sp = BigInt(b.envelope.settlement_period); const pa = BigInt(b.proposed_at);
const nb = new Date(Number((pa + sp) / 1000000n));
const bal = {}; for (const [k, id] of Object.entries({ dev: C.OPERATOR, escrow: C.ESCROW, keeper: C.KEEPER, attest1: "attest1.praetorial-dev-1101.testnet" })) bal[k] = Number((BigInt((await a.connection.provider.query({request_type:"view_account",finality:"final",account_id:id})).amount)) / 10n**18n) / 1e6;
console.log(JSON.stringify({ proposed_at: new Date(Number(pa/1000000n)).toISOString(), not_before_utc: nb.toISOString(), not_before_et: nb.toLocaleString("en-US",{timeZone:"America/New_York"}), keeper_credit: await a.viewFunction({contractId:C.ESCROW,methodName:"keeper_credit_balance",args:{}}), bal }));
