import { validateIssue, digest } from './issue-contract.mjs';

export function issueRoutes(issue) {
  const prefix = issue.kind === 'daily' ? '/data' : '/data/' + issue.kind;
  const period = issue.kind === 'daily' ? issue.date : issue.kind === 'weekly' ? issue.period_start : issue.period_label;
  return { latest: prefix + '/latest.json', archive: prefix + '/' + encodeURIComponent(period) + '.json', dates: prefix + '/dates.json', period };
}

export async function verifyOnline(issue, { host, fetchImpl = fetch, commit = null, now = Date.now() } = {}) {
  validateIssue(issue);
  const origin = new URL(host).origin, routes = issueRoutes(issue), expected = digest(issue);
  const paths = [routes.latest, routes.archive, routes.dates, ...(issue.kind === 'daily' ? ['/'] : [])];
  const results = await Promise.allSettled(paths.map(async route => {
    const response = await fetchImpl(origin + route, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (response.status !== 200) throw new Error('HTTP ' + response.status);
    const text = await response.text();
    if (route === routes.dates) {
      const dates = JSON.parse(text); if (!Array.isArray(dates) || !dates.includes(routes.period)) throw new Error('Issue absent from date index');
    } else {
      const match = route === '/' && text.match(/<script id="initial-data" type="application\/json">([\s\S]*?)<\/script>/);
      const value = JSON.parse(route === '/' ? match?.[1] || 'null' : text);
      if (digest(value) !== expected) throw new Error('Production issue differs from candidate');
    }
    return { route, ok: true };
  }));
  const files = results.map((row, i) => row.status === 'fulfilled' ? row.value : { route: paths[i], ok: false, error: row.reason.message });
  return { schema_version: 1, ok: files.every(x => x.ok), host: origin, identity: issue.edition || { kind: issue.kind || 'daily', period_key: routes.period, cutoff_upper: issue.window.upper, revision: 0 }, payload_sha256: expected, commit, checked_at: now, files };
}

export async function waitForDelivery(issue, { timeoutMs = 120000, intervalMs = 5000, clock = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), ...options } = {}) {
  const deadline = clock() + timeoutMs;
  let receipt;
  do {
    receipt = await verifyOnline(issue, options);
    if (receipt.ok || clock() + intervalMs > deadline) return receipt;
    await sleep(intervalMs);
  } while (clock() <= deadline);
  return receipt;
}

export function recoveryDecision({ online, candidateReady = false, runs = null, now = Date.now(), deadline, generationBudgetMs = 25 * 60000 }) {
  if (online) return { state: 'online_verified', action: 'none', missed_deadline: false };
  const active = runs?.find(run => ['queued', 'in_progress', 'waiting', 'pending'].includes(run.status));
  const missed = now >= deadline;
  if (active) return { state: active.status === 'in_progress' ? 'running' : 'queued', action: 'observe', missed_deadline: missed };
  if (candidateReady) return { state: 'ready_not_online', action: 'publish', missed_deadline: missed };
  if (runs === null) return { state: 'execution_unknown', action: 'check_execution_state', missed_deadline: missed };
  if (runs.some(run => run.conclusion === 'success')) return { state: 'run_succeeded_not_online', action: 'restore_and_verify', missed_deadline: missed };
  if (now + generationBudgetMs > deadline) return { state: 'not_online', action: 'bounded_late_recovery', missed_deadline: missed };
  return { state: runs.length ? 'generation_failed' : 'not_started', action: 'resume', missed_deadline: missed };
}

export async function triggerRedeploy({ hook, fetchImpl = fetch } = {}) {
  if (!hook) return { available: false, reason: 'Redeploy credentials not configured' };
  const url = new URL(hook);
  if (url.protocol !== 'https:' || url.hostname !== 'api.vercel.com' || !url.pathname.startsWith('/v1/integrations/deploy/')) throw new Error('Invalid Vercel deploy hook');
  const response = await fetchImpl(url.toString(), { method: 'POST', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Vercel redeploy request failed: HTTP ' + response.status);
  const body = await response.json();
  return { available: true, requested: true, job_id: body.job?.id || null };
}
