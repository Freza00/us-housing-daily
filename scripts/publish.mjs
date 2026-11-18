import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWindow, shouldRun, canAttemptRecoverySchedule, recoverableRevision } from './lib/calendar.mjs';
import { periodKey, validArchive, assertExpectedIssue } from './lib/issue-contract.mjs';
import { openIssueStore, readJson, ruleDigest, loadWindowSnapshots } from './lib/issue-store.mjs';
import { digest } from './lib/issue-contract.mjs';
import { deliverCandidate } from './lib/publication.mjs';

export async function loadCurrentCandidate(root, kind, env = process.env, now = new Date()) {
  const window = buildWindow(kind, now), period = periodKey(kind, window);
  assertExpectedIssue(kind, window, env);
  const dataRoot = env.NEWS_DATA_DIR || path.join(root, 'data'), data = path.join(dataRoot, kind === 'daily' ? '' : kind);
  const archive = await readJson(path.join(data, period + '.json'));
  if ((!env.ISSUE_REVISION || Number(env.ISSUE_REVISION) <= (archive?.edition?.revision || 0)) && validArchive(archive, { kind, upper: window.upper, period })) return { schema_version: 1, identity: archive.edition, payload: archive };
  const sources = (await readJson(path.join(root, 'config/sources.json'))).sources, tags = await readJson(path.join(root, 'config/tags.json'));
  const store = await openIssueStore(env.NEWS_STATE_DIR || path.join(root, 'state'), { kind, period, upper: window.upper, revision: env.ISSUE_REVISION || undefined, rules: digest([await ruleDigest(), sources, tags]), model: env.LLM_MODEL || 'gpt-6.2-sol' });
  const bundle = await store.get('ready');
  if (bundle) return bundle;
  throw new Error('No validated candidate or matching published issue');
}

async function main() {
  const kind = process.argv[2] || 'daily', now = new Date(), force = process.env.FORCE_RUN === '1';
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let allow = shouldRun(kind, now, { force });
  if (!allow && !force && canAttemptRecoverySchedule(kind, now)) {
    const window = buildWindow(kind, now), period = periodKey(kind, window);
    const dataRoot = process.env.NEWS_DATA_DIR || path.join(root, 'data'), stateDir = process.env.NEWS_STATE_DIR || path.join(root, 'state');
    const archive = await readJson(path.join(kind === 'daily' ? dataRoot : path.join(dataRoot, kind), period + '.json'));
    if (validArchive(archive, { kind, upper: window.upper, period })) {
      allow = recoverableRevision({ kind, saved: archive, snapshots: await loadWindowSnapshots(stateDir, window), window, now }) === 2;
    }
  }
  if (!allow) { console.log(JSON.stringify({ skipped: true, reason: 'Outside publishing calendar' })); return; }
  const bundle = await loadCurrentCandidate(root, kind);
  const result = await deliverCandidate(bundle, { root, now, force, host: process.env.PUBLICATION_URL || 'https://news-agent-mu.vercel.app', push: process.argv.includes('--push'), redeploy: process.argv.includes('--redeploy'), hook: process.env.VERCEL_DEPLOY_HOOK });
  console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error('DELIVERY:', error.message); process.exitCode = 1; });
