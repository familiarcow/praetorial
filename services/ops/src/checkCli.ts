import { runCheckCli } from "./check.js";
process.exitCode = await runCheckCli(process.argv.slice(2));
