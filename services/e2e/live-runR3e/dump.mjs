import { account } from "./lib.mjs"; import * as C from "./config.mjs";
const k = await account(C.KEEPER);
const v=(m,a={})=>k.viewFunction({contractId:C.ESCROW,methodName:m,args:a});
const b = await v("get_bet",{bet_id:1}); console.log(JSON.stringify({...b, envelope:{...b.envelope, terms:"<..>"}}).slice(0,1500));
console.log(JSON.stringify(await v("keeper_credit_balance")));
const tx = await k.connection.provider.txStatus("23khKvNVWRQ7Q2zFakEXfAPftqbrSrooWZkg2f6pHrNq", C.KEEPER);
for (const ro of tx.receipts_outcome) { console.log(ro.outcome.executor_id, JSON.stringify(ro.outcome.logs).slice(0,500), ro.outcome.gas_burnt); }
