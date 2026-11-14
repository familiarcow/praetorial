import { runTestAlertCli } from "./testAlert.js";
process.exitCode = await runTestAlertCli(process.argv.slice(2));
