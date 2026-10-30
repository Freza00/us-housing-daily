import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { digest } from './issue-contract.mjs';

const PHASES = new Set(['prepared', 'editor', 'cards', 'metadata', 'ready']);
export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
// Only reconstructible published projections may tolerate JSON syntax damage.
export async function readDerivedJson(file, fallback = null) { try { return await readJson(file, fallback); } catch (error) { if (error instanceof SyntaxError) return fallback; throw error; } }
export function revisionSeed(env = process.env) {
  if (!env.GITHUB_RUN_ID && !env.GITHUB_RUN_ATTEMPT) return 0;
  const run = Number(env.GITHUB_RUN_ID), attempt = Number(env.GITHUB_RUN_ATTEMPT), seed = run * 1000 + attempt;
  if (!Number.isSafeInteger(run) || run < 1 || !Number.isSafeInteger(attempt) || attempt < 1 || attempt >= 1000 || !Number.isSafeInteger(seed)) throw new Error('Invalid workflow revision allocation seed');
  return seed;
}
export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file + '.tmp', JSON.stringify(data, null, 2)); await fs.rename(file + '.tmp', file);
}
export async function ruleDigest() {
  const names = ['pipeline.mjs', 'editorial.mjs', 'llm-client.mjs', 'model-references.mjs', 'issue-contract.mjs', 'issue-store.mjs', 'news-core.mjs', 'event-groups.mjs', 'collection-checkpoint.mjs', 'calendar.mjs', 'dates.mjs', 'editorial-coverage.mjs', 'sources.mjs', 'source-http.mjs'];
  const h = createHash('sha256');
  for (const name of names) h.update(name).update(await fs.readFile(fileURLToPath(new URL(name, import.meta.url))));
  return h.digest('hex');
}

export async function openIssueStore(stateDir, { kind, period, upper, revision, force = false, publishedRevision = 0, allocationSeed = 0, rules, model }) {
  if (!['daily','weekly','monthly'].includes(kind) || !/^\d{4}-\d{2}(?:-\d{2})?$/.test(period) || !Number.isFinite(upper)) throw new Error('Invalid issue identity');
  const base = path.join(stateDir, 'issues', kind, period);
  const dirs = await fs.readdir(base).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e));
  const revisions = dirs.filter(x => /^r[1-9]\d*$/.test(x)).map(x => Number(x.slice(1)));
  const number = revision === undefined ? force ? Math.max(publishedRevision, allocationSeed, ...revisions, 0) + 1 : Math.max(...revisions, 1) : Number(revision);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid issue revision');
  const identity = { kind, period_key: period, cutoff_upper: upper, revision: number };
  const dir = path.join(base, 'r' + number), file = path.join(dir, 'manifest.json');
  let manifest = await readJson(file);
  if (manifest && (digest(manifest.identity) !== digest(identity) || manifest.rules !== rules || manifest.model !== model)) throw new Error('Frozen issue is incompatible; create an explicit new revision');
  manifest ||= { schema_version: 1, identity, rules, model, phases: {}, attempts: {}, created_at: Date.now() };
  const save = async () => writeJson(file, manifest);
  return {
    dir, identity, manifest,
    async get(phase) {
      if (!PHASES.has(phase)) throw new Error('Invalid issue phase');
      const entry = manifest.phases[phase]; if (!entry) return null;
      const value = await readJson(path.join(dir, phase + '.json'));
      if (value === null || digest(value) !== entry.sha256) throw new Error('Corrupt frozen phase: ' + phase);
      return value;
    },
    async put(phase, value) {
      if (!PHASES.has(phase)) throw new Error('Invalid issue phase');
      await writeJson(path.join(dir, phase + '.json'), value);
      manifest.phases[phase] = { sha256: digest(value), saved_at: Date.now() }; await save();
    },
    async recordAttempt(label, event) {
      (manifest.attempts[label] ||= []).push(event); await save();
    },
    async recordOutcome(label, event) {
      const request = manifest.attempts[label]?.find(it => it.request_id === event.request_id);
      if (request) Object.assign(request, event);
      manifest.model_ms = (manifest.model_ms || 0) + event.ms; await save();
    },
    async recordDelay(label, requestId, milliseconds) {
      const request = manifest.attempts[label]?.find(it => it.request_id === requestId);
      if (request) request.retry_delay_ms = milliseconds;
      await save();
    }
  };
}
