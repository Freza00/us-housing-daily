import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldRun, buildWindow, canAttemptRecoverySchedule, recoverableRevision } from './lib/calendar.mjs';
import { beijingDateStr } from './lib/dates.mjs';
import { digest, periodKey, assertExpectedIssue, validArchive } from './lib/issue-contract.mjs';
import { readJson, ruleDigest, revisionSeed, loadWindowSnapshots } from './lib/issue-store.mjs';
import { restoreCheckpoint } from './lib/artifact-recovery.mjs';

async function main() {
  const kind = process.argv[2] || 'daily', now = new Date(), forceRun = process.env.FORCE_RUN === '1';
  const scheduled = shouldRun(kind, now, { force: forceRun });
  if (!scheduled && (forceRun || !canAttemptRecoverySchedule(kind, now))) { console.log(JSON.stringify({ skipped: true })); return; }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), window = buildWindow(kind, now);
  assertExpectedIssue(kind, window, process.env);
  const sources = (await readJson(path.join(root, 'config/sources.json'))).sources, tags = await readJson(path.join(root, 'config/tags.json'));
  const period = periodKey(kind, window), dataDir = process.env.NEWS_DATA_DIR || path.join(root, 'data'), stateDir = process.env.NEWS_STATE_DIR || path.join(root, 'state');
  const archive = await readJson(path.join(kind === 'daily' ? dataDir : path.join(dataDir, kind), period + '.json'));
  const validSaved = validArchive(archive, { kind, period, upper: window.upper });
  const recoverable = !forceRun && validSaved ? recoverableRevision({ kind, saved: archive, snapshots: await loadWindowSnapshots(stateDir, window), window, now }) : null;
  if (!scheduled && (!recoverable || (process.env.ISSUE_REVISION && Number(process.env.ISSUE_REVISION) !== recoverable))) { console.log(JSON.stringify({ skipped: true })); return; }
  const explicitRevision = process.env.ISSUE_REVISION || undefined;
  if (!explicitRevision && !forceRun && process.env.ISSUE_AUTO_REVISION && Number(process.env.ISSUE_AUTO_REVISION) !== recoverable) {
    console.log(JSON.stringify({ skipped: true, reason: 'Automatic revision is no longer eligible' }));
    return;
  }
  const autoRevision = !explicitRevision && !forceRun && recoverable ? recoverable : undefined;
  const requestedRevision = explicitRevision ?? autoRevision;
  const allowNewAutoR2 = autoRevision === 2 && ['weekly', 'monthly'].includes(kind);
  if (requestedRevision && Number(requestedRevision) === archive?.edition?.revision && validSaved) { console.log(JSON.stringify({ restored: false, revision: archive.edition.revision, reason: 'Requested revision is already published; verify delivery' })); return; }
  const result = await restoreCheckpoint({ root, stateDir, kind, period, upper: window.upper, rules: digest([await ruleDigest(), sources, tags]), model: process.env.LLM_MODEL || 'gpt-6.2-sol', repo: process.env.GITHUB_REPOSITORY || 'Freza00/us-housing-daily', force: forceRun && !requestedRevision, revision: requestedRevision, allowNewAutoR2, r1FinishedAt: archive?._diagnostics?.timings?.generation_finished_at ?? archive?.generated_at, publishedRevision: archive?.edition?.revision || 0, allocationSeed: revisionSeed(), since: Date.parse(beijingDateStr(window.upper) + 'T00:00:00+08:00') });
  if (result.revision && process.env.GITHUB_ENV) await fs.appendFile(process.env.GITHUB_ENV, 'ISSUE_REVISION=' + result.revision + '\n');
  if (result.budget_unknown?.length && process.env.GITHUB_ENV) await fs.appendFile(process.env.GITHUB_ENV, 'ISSUE_BUDGET_UNKNOWN=' + result.budget_unknown.join(',') + '\n');
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error('RESTORE:', error.message); process.exitCode = 1; });
