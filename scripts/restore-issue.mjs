import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldRun, buildWindow } from './lib/calendar.mjs';
import { beijingDateStr } from './lib/dates.mjs';
import { digest, periodKey, assertExpectedIssue, validArchive } from './lib/issue-contract.mjs';
import { readJson, ruleDigest, revisionSeed } from './lib/issue-store.mjs';
import { restoreCheckpoint } from './lib/artifact-recovery.mjs';

async function main() {
  const kind = process.argv[2] || 'daily', now = new Date();
  if (!shouldRun(kind, now, { force: process.env.FORCE_RUN === '1' })) { console.log(JSON.stringify({ skipped: true })); return; }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), window = buildWindow(kind, now);
  assertExpectedIssue(kind, window, process.env);
  const sources = (await readJson(path.join(root, 'config/sources.json'))).sources, tags = await readJson(path.join(root, 'config/tags.json'));
  const period = periodKey(kind,window), archive = await readJson(path.join(root,kind==='daily'?'data':'data/'+kind,period+'.json'));
  if (process.env.ISSUE_REVISION && Number(process.env.ISSUE_REVISION) === archive?.edition?.revision && validArchive(archive,{kind,period,upper:window.upper})) { console.log(JSON.stringify({restored:false,revision:archive.edition.revision,reason:'Requested revision is already published; verify delivery'})); return; }
  const result = await restoreCheckpoint({ root, kind, period, upper: window.upper, rules: digest([await ruleDigest(), sources, tags]), model: process.env.LLM_MODEL || 'gpt-6.1-sol', repo: process.env.GITHUB_REPOSITORY || 'Freza00/us-housing-daily', force: process.env.FORCE_RUN === '1' && !process.env.ISSUE_REVISION, revision: process.env.ISSUE_REVISION || undefined, publishedRevision: archive?.edition?.revision || 0, allocationSeed: revisionSeed(), since: Date.parse(beijingDateStr(window.upper) + 'T00:00:00+08:00') });
  if (result.revision && process.env.GITHUB_ENV) await fs.appendFile(process.env.GITHUB_ENV, 'ISSUE_REVISION=' + result.revision + '\n');
  if (result.budget_unknown?.length && process.env.GITHUB_ENV) await fs.appendFile(process.env.GITHUB_ENV, 'ISSUE_BUDGET_UNKNOWN=' + result.budget_unknown.join(',') + '\n');
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error('RESTORE:', error.message); process.exitCode = 1; });
