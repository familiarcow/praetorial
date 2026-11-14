import { LogOnlyAlertChannel, MultiAlertChannel, TelegramAlertChannel, type AlertChannel } from "../../monitor/src/alertChannel.js";
import { TelegramChannel } from "../../notifier/src/telegram.js";
import type { Alert } from "../../monitor/src/alerts.js";
import { loadEnvFile, parseFlags, realIo, type CliIo } from "./envFile.js";

export interface TestAlertOpts {
  env: Record<string, string>;
  now?: Date;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
  sleepImpl?: (ms: number) => Promise<void>;
  dryRun?: boolean;
}
export interface ChannelResult { name: "log" | "telegram"; status: "sent" | "failed" | "would-fire" }
export interface TestAlertResult { text: string; channels: ChannelResult[]; ok: boolean }

/** Sends ONE test alert through the monitor's MultiAlertChannel (log + Telegram when both vars are set). */
export async function sendTestAlert(o: TestAlertOpts): Promise<TestAlertResult> {
  const network = (o.env.NEAR_NETWORK_ID ?? "").trim() || "unknown";
  const text = `praetorial ops test ${(o.now ?? new Date()).toISOString()} ${network}`;
  const token = (o.env.ALERT_TELEGRAM_BOT_TOKEN ?? "").trim();
  const chat = (o.env.ALERT_TELEGRAM_CHAT_ID ?? "").trim();
  const telegram = token !== "" && chat !== "";
  if (o.dryRun) {
    const channels: ChannelResult[] = [{ name: "log", status: "would-fire" }];
    if (telegram) channels.push({ name: "telegram", status: "would-fire" });
    return { text, channels, ok: true };
  }
  const log = o.log ?? ((m: string) => console.log(m));
  let tgOk = true;
  const channels: AlertChannel[] = [new LogOnlyAlertChannel(log)];
  if (telegram) {
    const tg = new TelegramChannel({ fetchImpl: o.fetchImpl ?? fetch, botToken: token, sleepImpl: o.sleepImpl, log: () => {} });
    const orig = tg.send.bind(tg);
    tg.send = async (c: string, t: string) => { const r = await orig(c, t); if (!r) tgOk = false; return r; };
    channels.push(new TelegramAlertChannel(tg, chat));
  }
  const alert: Alert = { key: "ops-test", kind: "service_heartbeat_missing", severity: "info", message: text, detail: "ops:test-alert (not a real alert)" };
  await new MultiAlertChannel(channels).send(alert);
  const res: ChannelResult[] = [{ name: "log", status: "sent" }];
  if (telegram) res.push({ name: "telegram", status: tgOk ? "sent" : "failed" });
  return { text, channels: res, ok: tgOk };
}

export async function runTestAlertCli(argv: string[], io: CliIo = realIo, deps: { fetchImpl?: typeof fetch; now?: Date; sleepImpl?: (ms: number) => Promise<void> } = {}): Promise<number> {
  const flags = parseFlags(argv, ["env-file"], ["dry-run"]);
  if (!flags || typeof flags["env-file"] !== "string") { io.stderr("usage: ops:test-alert --env-file <path> [--dry-run]"); return 2; }
  let env: Record<string, string>;
  try { env = loadEnvFile(flags["env-file"]); } catch { io.stderr("cannot read env file"); return 1; }
  const r = await sendTestAlert({ env, now: deps.now, fetchImpl: deps.fetchImpl, sleepImpl: deps.sleepImpl, dryRun: flags["dry-run"] === true, log: (m) => io.stdout(m) });
  io.stdout(`${flags["dry-run"] === true ? "dry-run: " : ""}${r.text}`);
  for (const c of r.channels) io.stdout(`channel ${c.name}: ${c.status}`);
  return r.ok ? 0 : 1;
}
