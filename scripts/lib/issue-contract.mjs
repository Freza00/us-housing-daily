import { createHash } from 'node:crypto';
import { validateWriting } from './editorial.mjs';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function periodKey(kind, window) { return kind === 'daily' ? window.date : kind === 'weekly' ? window.periodStart : window.label; }
export function assertExpectedIssue(kind, window, env = {}) {
  if ((env.EXPECTED_PERIOD && env.EXPECTED_PERIOD !== periodKey(kind, window)) || (env.EXPECTED_CUTOFF && Number(env.EXPECTED_CUTOFF) !== window.upper)) throw new Error('Requested issue is no longer the current publish period');
}

export function validateIssue(issue, { kind = issue?.kind || 'daily', upper, period } = {}) {
  if (!issue || issue.schema_version !== 2 || !['complete', 'degraded'].includes(issue.publication_status)) throw new Error('Invalid published issue status');
  if ((issue.kind || 'daily') !== kind || !['daily', 'weekly', 'monthly'].includes(kind)) throw new Error('Issue kind mismatch');
  if (!Number.isFinite(issue.window?.lower) || !Number.isFinite(issue.window?.upper) || issue.window.lower >= issue.window.upper) throw new Error('Invalid issue window');
  if (upper !== undefined && issue.window.upper !== upper) throw new Error('Issue cutoff mismatch');
  const label = kind === 'daily' ? issue.date : kind === 'weekly' ? issue.period_start : issue.period_label;
  if (!label || periodKey(kind, issue.window) !== label || (period !== undefined && label !== period)) throw new Error('Issue period mismatch');
  if (!Array.isArray(issue.items) || !issue.items.length || issue.items.some(x => typeof x?.id !== 'string') || new Set(issue.items.map(x => x.id)).size !== issue.items.length) throw new Error('Invalid issue cards');
  if (issue.items.some(it => !Number.isFinite(it.published_at) || it.published_at >= issue.window.upper)) throw new Error('Invalid card publication date');
  validateWriting(structuredClone(issue), issue.items, kind);
  return issue;
}

export function reusableIssue(archive, latest, expected) {
  try {
    validateIssue(archive, expected); validateIssue(latest, expected);
    return digest(archive) === digest(latest);
  } catch { return false; }
}
export function validArchive(issue, expected) { try { validateIssue(issue, expected); return true; } catch { return false; } }
