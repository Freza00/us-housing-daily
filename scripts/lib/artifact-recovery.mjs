import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digest } from './issue-contract.mjs';
import { readJson, writeJson } from './issue-store.mjs';

const exec = promisify(execFile);
const phases = new Set(['prepared', 'editor', 'cards', 'metadata', 'ready']);
export function trustedArtifactRun(run, { repo, kind, branch = 'main' }) {
  return run?.repository?.full_name === repo && run?.head_repository?.full_name === repo && run.head_branch === branch && ['schedule', 'repository_dispatch', 'workflow_dispatch'].includes(run.event) && run.path === `.github/workflows/${kind}.yml`;
}

export async function installCheckpoint(files, { stateDir, kind, period, upper, rules, model }) {
  if (Object.keys(files).some(name => !/^(?:manifest|prepared|editor|cards|metadata|ready)\.json$/.test(name))) throw new Error('Unexpected checkpoint path');
  const manifest = files['manifest.json'];
  const id = manifest?.identity;
  if (manifest?.schema_version !== 1 || id?.kind !== kind || id?.period_key !== period || id?.cutoff_upper !== upper || !Number.isSafeInteger(id?.revision) || id.revision < 1 || manifest.rules !== rules || manifest.model !== model) throw new Error('Checkpoint identity or rule version mismatch');
  if (!manifest.phases?.prepared || !manifest.attempts || typeof manifest.attempts !== 'object') throw new Error('Incomplete checkpoint manifest');
  for (const [phase, entry] of Object.entries(manifest.phases)) {
    if (!phases.has(phase) || !(phase + '.json' in files) || !/^[a-f0-9]{64}$/.test(entry.sha256 || '') || digest(files[phase + '.json']) !== entry.sha256) throw new Error('Checkpoint checksum mismatch: ' + phase);
  }
  const target = path.join(stateDir, 'issues', kind, period, 'r' + id.revision);
  const current = await readJson(path.join(target, 'manifest.json'));
  if (current) {
    if (digest(current.identity) !== digest(id) || current.rules !== rules || current.model !== model) throw new Error('Local checkpoint is incompatible');
    current.budget_unknown = [...new Set([...(current.budget_unknown || []),...(manifest.budget_unknown || [])])];
    await writeJson(path.join(target,'manifest.json'),current);
    return { restored: false, reason: 'Local checkpoint retained', revision: id.revision, budget_unknown: current.budget_unknown };
  }
  for (const phase of Object.keys(manifest.phases)) await writeJson(path.join(target, phase + '.json'), files[phase + '.json']);
  await writeJson(path.join(target, 'manifest.json'), manifest);
  return { restored: true, revision: id.revision, phases: Object.keys(manifest.phases) };
}

export function startedModelStages(jobs) {
  const labels = new Set();
  for (const job of jobs) for (const step of job.steps || []) {
    if ((step.status === 'in_progress' || (step.status === 'completed' && step.started_at && step.conclusion !== 'skipped')) && ['Select frozen issue','Write and validate frozen issue'].includes(step.name)) labels.add(step.name === 'Select frozen issue' ? 'editor' : 'writer');
  }
  return [...labels];
}

export async function restoreCheckpoint({ root, stateDir = path.join(root, 'state'), kind, period, upper, rules, model, repo, gh, unzip, force = false, revision, publishedRevision = 0, allocationSeed = 0, since } = {}) {
  gh ||= async args => (await exec('gh', args, { encoding: 'buffer', maxBuffer: 40e6 })).stdout;
  unzip ||= async args => (await exec('unzip', args, { encoding: 'utf8', maxBuffer: 40e6 })).stdout;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '')) throw new Error('Invalid artifact repository');
  const pages = JSON.parse(String(await gh(['api', `repos/${repo}/actions/artifacts?per_page=100`, '--paginate', '--slurp'])));
  const prefix = `news-issue-${kind}-${period}-r`, runCache = new Map();
  const getRun = async id => { if (!runCache.has(id)) runCache.set(id, JSON.parse(String(await gh(['api', `repos/${repo}/actions/runs/${id}`])))); return runCache.get(id); };
  const jobs = async (id, attempt) => {
    const endpoint = attempt ? `repos/${repo}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100` : `repos/${repo}/actions/runs/${id}/jobs?filter=all&per_page=100`;
    const result = JSON.parse(String(await gh(['api', endpoint, '--paginate', '--slurp'])));
    return (Array.isArray(result) ? result : [result]).flatMap(page => page.jobs || []);
  };
  const unknownAfter = async artifact => {
    if (!since) return [];
    const unknown = new Set(), boundary = artifact ? Date.parse(artifact.created_at || '') : 0;
    const query = new URLSearchParams({ branch: 'main', created: '>=' + new Date(since).toISOString(), per_page: '100' });
    const runs = JSON.parse(String(await gh(['api', `repos/${repo}/actions/workflows/${kind}.yml/runs?${query}`, '--paginate','--slurp'])));
    for (const run of (Array.isArray(runs)?runs:[runs]).flatMap(page=>page.workflow_runs||[])) {
      if (!trustedArtifactRun(await getRun(run.id),{repo,kind})) continue;
      for (const job of await jobs(run.id)) {
        const after = (job.steps || []).filter(step => !artifact || !Number.isFinite(boundary) || Date.parse(step.started_at || '') > boundary);
        for (const label of startedModelStages([{steps:after}])) unknown.add(label);
      }
      if (unknown.size===2) break;
    }
    return [...unknown];
  };
  const trusted = [];
  for (const row of pages.flatMap(page => page.artifacts || []).filter(row => row.name.startsWith(prefix))) {
    const match = row.name.slice(prefix.length).match(/^([1-9]\d*)-(\d+)-(\d+)-(prepared|editor|writer)$/);
    if (!match || !Number.isSafeInteger(Number(match[1])) || String(row.workflow_run?.id) !== match[2]) continue;
    const run = await getRun(row.workflow_run.id);
    if (trustedArtifactRun(run, { repo, kind })) trusted.push({ ...row, revision: Number(match[1]), attempt: Number(match[3]), phase: match[4] });
  }
  const localDirs = await fs.readdir(path.join(stateDir,'issues',kind,period)).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e));
  const localMax = Math.max(0,...localDirs.filter(name => /^r[1-9]\d*$/.test(name)).map(name => Number(name.slice(1))));
  const highest = Math.max(publishedRevision,localMax,0,...trusted.map(row => row.revision));
  if (!Number.isSafeInteger(allocationSeed) || allocationSeed < 0) throw new Error('Invalid workflow revision allocation seed');
  if (force) return { restored: false, revision: Math.max(highest,allocationSeed) + 1, reason: 'Explicit force creates a new frozen revision' };
  const target = revision === undefined ? highest : Number(revision);
  if (revision !== undefined && (!Number.isSafeInteger(target) || target < 1)) throw new Error('Invalid requested recovery revision');
  const artifacts = trusted.filter(row => row.revision === target).sort((a,b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || b.id-a.id);
  const artifact = artifacts[0];
  if (artifact && !artifact.expired) {
    await fs.mkdir(path.join(root, '.tmp'), { recursive: true });
    const temp = await fs.mkdtemp(path.join(root, '.tmp', 'restore-issue-'));
    try {
      const zip = path.join(temp, 'checkpoint.zip');
      await fs.writeFile(zip, await gh(['api', `repos/${repo}/actions/artifacts/${artifact.id}/zip`]));
      const names = String(await unzip(['-Z1', zip])).trim().split('\n').filter(Boolean);
      if (new Set(names).size !== names.length || names.some(name => !/^(?:manifest|prepared|editor|cards|metadata|ready)\.json$/.test(name))) throw new Error('Unsafe checkpoint archive');
      const files = {};
      for (const name of names) files[name] = JSON.parse(await unzip(['-p', zip, name]));
      const identity = files['manifest.json']?.identity;
      if (identity?.kind !== kind || identity?.period_key !== period || identity?.cutoff_upper !== upper || identity.revision !== target) throw new Error('Checkpoint identity mismatch');
      const started = await jobs(artifact.workflow_run.id,artifact.attempt);
      const budgetUnknown = [...new Set([...startedModelStages(started).filter(label => label === 'writer' ? artifact.phase !== 'writer' : artifact.phase === 'prepared'),...await unknownAfter(artifact)])];
      if (files['manifest.json']?.rules !== rules || files['manifest.json']?.model !== model) {
        if (revision !== undefined) throw new Error('Requested revision has incompatible rules or model');
        return { restored: false, revision: highest + 1, reason: 'Highest revision has incompatible rules; explicit new revision selected', budget_unknown: budgetUnknown };
      }
      files['manifest.json'].budget_unknown = [...new Set([...(files['manifest.json'].budget_unknown || []),...budgetUnknown])];
      const result = await installCheckpoint(files, { stateDir, kind, period, upper, rules, model });
      return { ...result, budget_unknown: [...new Set([...(result.budget_unknown || []),...files['manifest.json'].budget_unknown])] };
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
  const unknown = new Set(await unknownAfter(null));
  if (artifact?.expired) for (const label of startedModelStages(await jobs(artifact.workflow_run.id,artifact.attempt))) unknown.add(label);
  const localDir = path.join(stateDir,'issues',kind,period,'r'+target), local = await readJson(path.join(localDir,'manifest.json'));
  if (local) {
    const files = {'manifest.json':{...local,budget_unknown:[...new Set([...(local.budget_unknown||[]),...unknown])]}};
    for (const phase of Object.keys(local.phases || {})) files[phase+'.json'] = await readJson(path.join(localDir,phase+'.json'));
    return installCheckpoint(files,{stateDir,kind,period,upper,rules,model});
  }
  if (revision !== undefined) throw new Error('Requested revision checkpoint is missing or expired; refusing to allocate another revision');
  return { restored: false, reason: unknown.size ? 'Prior model stage has no final ledger; remaining budget is unknown' : highest ? 'No compatible stage; explicit new revision selected' : 'No prior checkpoint', ...(highest || unknown.size ? { revision: Math.max(highest,allocationSeed) + 1 } : {}), budget_unknown: [...unknown] };
}
