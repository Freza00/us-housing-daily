import { createHash } from 'node:crypto';
import { validateWriting, routeSection, isMortgageRateStory } from './editorial.mjs';
import { DAILY_WRITING_POLICY, isDailyUSStory } from './daily-edition.mjs';
import { SUPPORTED_EDITORIAL_PROTOCOLS, assertEditorialEvidence } from './editor-evidence.mjs';

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
  if (issue.editorial_schema !== undefined && issue.editorial_schema !== 2) throw new Error('Unsupported editorial schema');
  if (issue.editorial_schema === 2 && issue.items.some(it => typeof it.capital_focus !== 'boolean' || it.section !== routeSection(it))) throw new Error('Script section mismatch');
  const evidenceProtocol = issue.editorial_protocol !== undefined || issue.items.some(item => item.editorial_protocol !== undefined);
  if (evidenceProtocol) {
    if (!SUPPORTED_EDITORIAL_PROTOCOLS.has(issue.editorial_protocol) || kind !== 'daily' || issue.editorial_schema !== 2 || issue.writing_policy !== DAILY_WRITING_POLICY || issue.items.some(item => item.editorial_protocol !== issue.editorial_protocol)) throw new Error('Inconsistent editorial protocol');
    for (const item of issue.items) assertEditorialEvidence(item);
    if (issue.selection_target !== 20 || !Number.isInteger(issue.selection_count) || issue.selection_count !== issue.content_target || issue.selection_shortfall !== 20 - issue.selection_count) throw new Error('Invalid selection target');
  }
  const fixedEvidence = issue.writing_policy === DAILY_WRITING_POLICY;
  if (issue.writing_policy !== undefined && (!fixedEvidence || kind !== 'daily' || issue.editorial_schema !== 2)) throw new Error('Unsupported issue writing policy');
  if (fixedEvidence) {
    if (issue.items.some(item => !isDailyUSStory(item, item))) throw new Error('Daily issue contains a story outside its verified US scope');
    const target = issue.content_target, shortfall = target - issue.items.length;
    if (!Number.isInteger(target) || target < issue.items.length || target > 20 || shortfall > 3 || issue.items.length < Math.ceil(target * 0.8) ||
        issue.content_status !== (shortfall ? 'partial' : 'passed') || (shortfall && issue.publication_status !== 'degraded')) throw new Error('Invalid daily content status');
    if (issue.summary_status !== (issue.executive_summary === null ? 'unavailable' : 'available')) throw new Error('Invalid daily summary status');
    const enforcesRateOutlookContract = issue.date > '2026-11-18' || (issue.date === '2026-11-18' && (Number(issue.edition?.revision) > 1 || Boolean(issue._diagnostics?.review) || Boolean(issue._diagnostics?.rate_pin) || Boolean(issue.executive_summary?.outlook)));
    if (enforcesRateOutlookContract && issue.items.some(it => isMortgageRateStory(it) && it.section === 'national') && (!isMortgageRateStory(issue.items[0]) || issue.items[0].section !== 'national')) {
      throw new Error('Daily issue must place the latest mortgage rate story first');
    }
    if (enforcesRateOutlookContract && issue.executive_summary !== null && !issue.executive_summary?.outlook?.text) {
      throw new Error('Missing daily 30-day release outlook in executive summary');
    }
  }
  validateWriting(structuredClone(issue), issue.items, kind, { requireEnglish: issue.editorial_schema === 2, fixedEvidence, allowMissingSummary: fixedEvidence, issueDate: issue.date });
  return issue;
}

export function reusableIssue(archive, latest, expected) {
  try {
    validateIssue(archive, expected); validateIssue(latest, expected);
    return digest(archive) === digest(latest);
  } catch { return false; }
}
export function validArchive(issue, expected) { try { validateIssue(issue, expected); return true; } catch { return false; } }
