// Shared single-cron dispatcher (D-HOST3): the Cloudflare account allows 5 cron triggers in
// total, so every scheduled job (keeper now; relayer, monitor+notifier, indexer later) hangs
// off ONE `* * * * *` trigger. Each job declares how often it runs (in minutes); the
// dispatcher runs the ones due at this tick, isolating failures so one job cannot starve
// another, then rethrows the first error so the invocation is still reported as failed.
export interface Job<E> { name: string; everyMinutes: number; run(env: E, nowMs: number): Promise<void>; }

export function dueJobs<E>(jobs: Job<E>[], nowMs: number): Job<E>[] {
  const minuteOfEpoch = Math.floor(nowMs / 60_000);
  return jobs.filter((j) => j.everyMinutes <= 1 || minuteOfEpoch % j.everyMinutes === 0);
}

export async function runDispatcher<E>(jobs: Job<E>[], env: E, nowMs: number): Promise<string[]> {
  const ran: string[] = [];
  let firstError: unknown;
  for (const j of dueJobs(jobs, nowMs)) {
    ran.push(j.name);
    try { await j.run(env, nowMs); } catch (e) { firstError ??= e; console.error(`job ${j.name} failed`, e); }
  }
  if (firstError !== undefined) throw firstError;
  return ran;
}

/** Service-binding poke (CF1e3): ALWAYS drain the response body. Returning with it unread made the runtime cancel the callee's outer
 *  fetch event ("canceled", cpu 0) when scheduled() ended, dropping the tick's JSON result (errors/alerts); on failure the callee's
 *  error text is now part of the thrown message. */
export async function pokeService(svc: { fetch(url: string, init?: any): Promise<Response> }, url: string, label: string): Promise<void> {
  const r = await svc.fetch(url, { method: "POST" });
  const text = await r.text().catch(() => "");
  if (!r.ok) {
    let detail = ""; try { detail = String((JSON.parse(text) as any)?.error ?? ""); } catch { /* non-JSON body */ }
    throw new Error(`${label} failed: HTTP ${r.status}${detail ? `: ${detail}` : ""}`);
  }
}
