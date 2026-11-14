import { Worker } from "near-workspaces";
const worker = await Worker.init();
console.log("sandbox up, root:", worker.rootAccount.accountId);
await worker.tearDown();
console.log("teardown ok");
