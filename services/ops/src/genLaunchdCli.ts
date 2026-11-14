import { runGenLaunchdCli } from "./genLaunchd.js";
process.exitCode = await runGenLaunchdCli(process.argv.slice(2));
