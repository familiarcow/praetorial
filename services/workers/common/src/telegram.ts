// MON4 ops alert/heartbeat delivery from a Worker: one Telegram Bot API POST via fetch.
// Never throws (alerting is a convenience, never load-bearing).
export interface AlertSink { send(text: string): Promise<void>; }

export function telegramSink(token: string | undefined, chatId: string | undefined, fetchImpl: (u: string, i: any) => Promise<{ ok: boolean; status: number }> = (u, i) => fetch(u, i)): AlertSink {
  if (!token || !chatId) return { async send(t) { console.log(`[ops-alert:no-telegram] ${t}`); } };
  return {
    async send(text) {
      try {
        const r = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }),
        });
        if (!r.ok) console.error(`telegram responded ${r.status}`);
      } catch (e: any) { console.error("telegram send failed", String(e?.message ?? e).replaceAll(token, "<token>")); }
    },
  };
}
