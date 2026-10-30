import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateIssue, digest, periodKey } from './issue-contract.mjs';
import { readJson, readDerivedJson, writeJson } from './issue-store.mjs';
import { materializeIssue } from './pipeline.mjs';
import { shouldRun, buildWindow } from './calendar.mjs';
import { waitForDelivery, triggerRedeploy } from './delivery.mjs';

const exec = promisify(execFile);
export function gitEnvironment(token, env = process.env) {
  const result = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_TRACE_REDACT: '1' };
  if (token) {
    const index = Number(env.GIT_CONFIG_COUNT || 0);
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid inherited Git environment');
    result.GIT_CONFIG_COUNT = String(index + 1);
    result['GIT_CONFIG_KEY_' + index] = 'http.https://github.com/.extraheader';
    result['GIT_CONFIG_VALUE_' + index] = 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + token).toString('base64');
  }
  return result;
}
export const gitCommand = async (cwd, args) => (await exec('git', args, { cwd, maxBuffer: 8e6, env: gitEnvironment(process.env.GH_TOKEN || process.env.GITHUB_TOKEN) })).stdout.trim();

export function publicationFiles(issue) {
  const kind = issue.kind, label = periodKey(kind, issue.window), prefix = kind === 'daily' ? 'data' : 'data/' + kind;
  return [prefix + '/' + label + '.json', prefix + '/latest.json', prefix + '/dates.json',
    'state/collection-checkpoint.json', 'state/inputs/' + kind + '-' + label + '.json',
    ...(kind === 'daily' ? ['public/index.html', 'state/seen.json', 'state/publication-watermark.json', 'state/snapshots/' + label + '.json'] : [])];
}

async function projectionMatches(root, issue) {
  const files = publicationFiles(issue), archive = await readJson(path.join(root, files[0])), latest = await readDerivedJson(path.join(root, files[1]));
  if (!archive || !latest || digest(archive) !== digest(issue) || digest(latest) !== digest(issue)) return false;
  const dates = await readDerivedJson(path.join(root, files[2]));
  if (!Array.isArray(dates) || !dates.includes(periodKey(issue.kind, issue.window))) return false;
  if (issue.kind === 'daily') {
    const html = await fs.readFile(path.join(root, 'public/index.html'), 'utf8').catch(e => e.code === 'ENOENT' ? '' : Promise.reject(e));
    const match = html.match(/<script id="initial-data" type="application\/json">([\s\S]*?)<\/script>/);
    try { if (!match || digest(JSON.parse(match[1])) !== digest(issue)) return false; } catch { return false; }
  }
  return true;
}

export async function pushCandidate(bundle, { root, now = new Date(), force = false, git = gitCommand, retries = 1, onBeforePush } = {}) {
  const issue = validateIssue(bundle.payload), kind = issue.kind, label = periodKey(kind, issue.window);
  if (!shouldRun(kind, now, { force })) throw new Error('Publishing is outside the current calendar guard');
  const currentWindow = buildWindow(kind, now);
  if (currentWindow.upper !== issue.window.upper || periodKey(kind, currentWindow) !== label) throw new Error('Candidate no longer matches current publication period');
  const sourceRemote = await git(root, ['remote', 'get-url', 'origin']);
  await fs.mkdir(path.join(root, '.tmp'), { recursive: true });
  for (let attempt = 0; attempt <= retries; attempt++) {
    const temp = await fs.mkdtemp(path.join(root, '.tmp', 'publish-')), checkout = path.join(temp, 'checkout');
    let commit;
    try {
      await git(root, ['clone', '--no-hardlinks', '--no-checkout', root, checkout]);
      await git(checkout, ['remote', 'set-url', 'origin', sourceRemote]);
      await git(checkout, ['fetch', 'origin', 'main']);
      await git(checkout, ['switch', '--detach', 'origin/main']);
      const archiveFile = publicationFiles(issue)[0];
      const remoteIssue = await readJson(path.join(checkout, archiveFile));
      const archiveMatches = remoteIssue && digest(remoteIssue) === digest(issue);
      if (archiveMatches && await projectionMatches(checkout, issue)) return { commit: await git(checkout, ['rev-parse', 'HEAD']), already_pushed: true };
      if (!archiveMatches && (!bundle.base || (remoteIssue ? digest(remoteIssue) : null) !== bundle.base.archive_sha256)) throw new Error('Published issue changed while candidate was prepared');
      if (!archiveMatches && bundle.base.producer_commit) {
        const changed = await git(checkout, ['diff', '--name-only', bundle.base.producer_commit + '..HEAD', '--', 'scripts/lib', 'config']);
        if (changed) throw new Error('Generation rules changed since candidate was prepared');
      }
      const outDir = path.join(checkout, kind === 'daily' ? 'data' : 'data/' + kind);
      await materializeIssue(bundle, { root: checkout, dataDir: path.join(checkout, 'data'), outDir, stateDir: path.join(checkout, 'state'), now });
      const files = [];
      for (const file of publicationFiles(issue)) { try { await fs.access(path.join(checkout, file)); files.push(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
      await git(checkout, ['add', '--', ...files]);
      await git(checkout, ['diff', '--cached', '--check']);
      if (!await git(checkout, ['diff', '--cached', '--name-only'])) return { commit: await git(checkout, ['rev-parse', 'HEAD']), already_pushed: true };
      await git(checkout, ['-c', 'user.name=Freza00', '-c', 'user.email=Freza00@users.noreply.github.com', 'commit', '-m', `chore: 发布 ${kind} ${label} 修订 ${issue.edition?.revision || 0} 并保存采集状态`]);
      commit = await git(checkout, ['rev-parse', 'HEAD']);
      await onBeforePush?.({ checkout, attempt, commit });
      try { await git(checkout, ['push', 'origin', 'HEAD:main']); return { commit, already_pushed: false }; }
      catch (error) {
        await git(checkout, ['fetch', 'origin', 'main']);
        try { await git(checkout, ['merge-base', '--is-ancestor', commit, 'origin/main']); return { commit, already_pushed: true, response_lost: true }; } catch {}
        if (attempt === retries) throw new Error('Candidate push failed; frozen bundle retained for delivery-only recovery', { cause: error });
      }
    } finally {
      // This directory is created by this invocation and contains only a disposable clone.
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
}

export async function deliverCandidate(bundle, { root, push = false, host, now = new Date(), redeploy = false, hook, ...options } = {}) {
  const issue = validateIssue(bundle.payload);
  const pushed = push ? await pushCandidate(bundle, { root, now, ...options }) : { commit: null, verified_only: true };
  let receipt = await waitForDelivery(issue, { host, commit: pushed.commit, ...options });
  let recovery;
  if (!receipt.ok && redeploy) {
    recovery = await triggerRedeploy({ hook, fetchImpl: options.fetchImpl });
    if (recovery.requested) receipt = await waitForDelivery(issue, { host, commit: pushed.commit, ...options });
  }
  const name = issue.kind + '-' + periodKey(issue.kind, issue.window) + '-r' + (issue.edition?.revision || 0) + '.json';
  await writeJson(path.join(root, 'state/delivery-receipts', name), { ...receipt, pushed, ...(recovery ? { recovery } : {}) });
  return { ...receipt, pushed, ...(recovery ? { recovery } : {}) };
}
