import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shouldRun, buildWindow } from './lib/calendar.mjs';
import { beijingDateStr } from './lib/dates.mjs';
import { validateIssue, periodKey } from './lib/issue-contract.mjs';
import { verifyOnline, recoveryDecision } from './lib/delivery.mjs';

export async function checkPublication({ kind = 'daily', now = new Date(), host = 'https://news-agent-mu.vercel.app', candidate = null, fetchImpl = fetch, runs = null } = {}) {
  if (!shouldRun(kind, now)) return { due: false, action: 'none', reason: 'Outside current publication calendar' };
  const window = buildWindow(kind, now), period = periodKey(kind, window);
  const deadline = kind === 'monthly' ? null : Date.parse(beijingDateStr(now.getTime()) + 'T09:00:00+08:00');
  let issue = candidate, receipt, error, candidateReady = false;
  try {
    if (!issue) {
      const prefix = kind === 'daily' ? '/data' : '/data/' + kind;
      const response = await fetchImpl(new URL(host).origin + prefix + '/latest.json', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Latest issue HTTP ' + response.status);
      issue = await response.json();
    }
    validateIssue(issue, { kind, upper: window.upper, period });
    candidateReady = !!candidate;
    receipt = await verifyOnline(issue, { host, fetchImpl, now: now.getTime() });
  } catch (e) { error = e.message; }
  return { due: true, kind, period, cutoff: window.upper, deadline, ...recoveryDecision({ online: !!receipt?.ok, candidateReady, runs, now: now.getTime(), deadline: deadline ?? Infinity }), execution_observed: runs !== null, deadline_compliance: deadline === null ? 'policy_pending' : now.getTime() < deadline ? 'not_due' : !receipt?.ok ? 'missed' : issue.generated_at > deadline ? 'late' : 'not_observed_before_deadline', ...(deadline === null ? { deadline_policy_pending: true } : {}), receipt, ...(error ? { error } : {}), external_schedule_enabled: false, notifications_enabled: false };
}

async function main() {
  const kind = process.argv[2] || 'daily', now = new Date();
  let runs = null;
  if (shouldRun(kind, now)) {
    try {
      const { stdout } = await promisify(execFile)('gh', ['run', 'list', '-R', process.env.GITHUB_REPOSITORY || 'Freza00/us-housing-daily', '--workflow', kind + '.yml', '--limit', '30', '--json', 'databaseId,status,conclusion,createdAt,headBranch,url'], { timeout: 15000 });
      const since = Date.parse(beijingDateStr(now.getTime()) + 'T00:00:00+08:00');
      runs = JSON.parse(stdout).filter(run => run.headBranch === 'main' && Date.parse(run.createdAt) >= since);
    } catch { /* The report distinguishes unknown execution state from no runs. */ }
  }
  const result = await checkPublication({ kind, now, runs, host: process.env.PUBLICATION_URL || 'https://news-agent-mu.vercel.app' });
  console.log(JSON.stringify(result, null, 2));
  if (result.due && result.state !== 'online_verified') process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error('CHECK:', error.message); process.exitCode = 1; });
