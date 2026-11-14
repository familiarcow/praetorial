// helper: print NEAR balances (read-only) for the accounts named in argv
import { connect, keyStores, NODE } from "./lib.mjs";
const near = await connect({ networkId: "testnet", nodeUrl: NODE, keyStore: new keyStores.InMemoryKeyStore() });
for (const id of process.argv.slice(2)) { try { const s = await (await near.account(id)).state(); console.log(id, (Number(BigInt(s.amount) / 10n ** 20n) / 1e4).toFixed(3)); } catch (e) { console.log(id, "ERR", String(e.message).slice(0, 60)); } }
