import { account } from "./lib.mjs";
for (const id of process.argv.slice(2)) console.log(id, (await (await account("praetorial-dev-1101.testnet")).connection.provider.query({request_type:"view_account",finality:"final",account_id:id})).code_hash);
