import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWindow, shouldRun } from './lib/calendar.mjs';
import { periodKey, validArchive, assertExpectedIssue } from './lib/issue-contract.mjs';
import { openIssueStore, readJson, ruleDigest } from './lib/issue-store.mjs';
import { digest } from './lib/issue-contract.mjs';
import { deliverCandidate } from './lib/publication.mjs';

export async function loadCurrentCandidate(root, kind, env = process.env, now = new Date()) {
  const window = buildWindow(kind, now), period = periodKey(kind, window);
  assertExpectedIssue(kind, window, env);
  const data = path.join(root, kind === 'daily' ? 'data' : 'data/' + kind);
  const archive = await readJson(path.join(data, period + '.json'));
  if ((!env.ISSUE_REVISION || Number(env.ISSUE_REVISION) <= (archive?.edition?.revision || 0)) && validArchive(archive,{kind,upper:window.upper,period})) return {schema_version:1,identity:archive.edition,payload:archive};
  const sources = (await readJson(path.join(root, 'config/sources.json'))).sources, tags = await readJson(path.join(root, 'config/tags.json'));
  const store = await openIssueStore(env.NEWS_STATE_DIR || path.join(root, 'state'), { kind, period, upper: window.upper, revision: env.ISSUE_REVISION || undefined, rules: digest([await ruleDigest(), sources, tags]), model: env.LLM_MODEL || 'gpt-6.1-sol' });
  const bundle = await store.get('ready');
  if (bundle) return bundle;
  throw new Error('No validated candidate or matching published issue');
}

async function main() {
  const kind = process.argv[2] || 'daily', now = new Date();
  if (!shouldRun(kind, now, { force: process.env.FORCE_RUN === '1' })) { console.log(JSON.stringify({ skipped: true, reason: 'Outside publishing calendar' })); return; }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bundle = await loadCurrentCandidate(root, kind);
  const result = await deliverCandidate(bundle, { root, now, force: process.env.FORCE_RUN === '1', host: process.env.PUBLICATION_URL || 'https://news-agent-mu.vercel.app', push: process.argv.includes('--push'), redeploy: process.argv.includes('--redeploy'), hook: process.env.VERCEL_DEPLOY_HOOK });
  console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error('DELIVERY:', error.message); process.exitCode = 1; });
