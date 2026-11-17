import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildWindow, withinRecoveryWindow, canAttemptRecoverySchedule, recoverableRevision } from '../lib/calendar.mjs';
import { LlmError } from '../lib/llm-client.mjs';
import { makeHandler } from '../lib/dispatch.mjs';
import { periodKey } from '../lib/issue-contract.mjs';
import { gitCommand, pushCandidate } from '../lib/publication.mjs';
import { runPipeline } from '../lib/pipeline.mjs';
import { sandbox, sample, modelDecision, modelEvidence, fakeClient } from './helpers.mjs';

const exec = promisify(execFile);

class Element {
  constructor() { this.children = []; this.hidden = false; this.textContent = ''; }
  replaceChildren(...nodes) { this.children = nodes; }
  append(...nodes) { this.children.push(...nodes); }
}

function loadRenderBrief(lang = 'zh') {
  return fs.readFile(new URL('../../public/app.js', import.meta.url), 'utf8').then(app => {
    const ids = Object.fromEntries(['briefBlock', 'briefText', 'briefTitle', 'coverageNote', 'researchCoverage', 'researchStatus', 'researchTitle'].map(x => [x, new Element()]));
    const ctx = { document: { createElement: () => new Element() }, $: id => ids[id], currentLang: lang, I18N: { zh: { sec: {} }, en: { sec: {} } }, tagLabelEn: x => x };
    vm.createContext(ctx);
    vm.runInContext(app.slice(app.indexOf('function renderBrief(data)')), ctx);
    return { ctx, ids, app };
  });
}

async function runEntry(scriptRel, root, kind, isoNow, extraEnv = {}) {
  const clock = `const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...args){super(...args.length?args:[${JSON.stringify(isoNow)}]);}static now(){return OriginalDate.parse(${JSON.stringify(isoNow)});}}`;
  const envFile = path.join(root, '.env-out-' + kind + '-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  const outputFile = envFile + '.out';
  await fs.writeFile(envFile, '');
  await fs.writeFile(outputFile, '');
  const env = { ...process.env, GITHUB_ENV: envFile, GITHUB_OUTPUT: outputFile, FORCE_RUN: '0', ISSUE_REVISION: '', EXPECTED_PERIOD: '', EXPECTED_CUTOFF: '', ...extraEnv };
  const result = await exec(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(clock), fileURLToPath(new URL(scriptRel, import.meta.url)), kind], { cwd: root, env });
  return { json: JSON.parse(result.stdout), env: await fs.readFile(envFile, 'utf8'), output: await fs.readFile(outputFile, 'utf8') };
}
const runCanRun = (root, kind, isoNow, extraEnv) => runEntry('../can-run.mjs', root, kind, isoNow, extraEnv);
const runRestore = (root, kind, isoNow, extraEnv) => runEntry('../restore-issue.mjs', root, kind, isoNow, extraEnv);

function btrAwareClient({ partialWriter = false } = {}) {
  const usage = [];
  let writerCalls = 0;
  return {
    usage,
    async call(_system, user, options) {
      usage.push({ label: options.label, effort: options.effort });
      if (options.label === 'editor') {
        return options.validate({
          decisions: JSON.parse(user).map(x => /Build-to-rent/i.test(x.title)
            ? modelDecision(x.id, { asset: 'btr-sfr', geo: 'phoenix', geo_evidence: 'Phoenix', primary_event: 'property_development_leasing', market_role: 'asset_location' })
            : modelDecision(x.id, { asset: 'multifamily', geo: 'phoenix', geo_evidence: 'Phoenix', primary_event: 'property_transaction_financing', market_role: 'asset_location', importance: partialWriter && /^Sunbelt multifamily report/.test(x.title) ? 3 : 4 }))
        });
      }
      if (partialWriter && writerCalls++ > 0) throw new LlmError('Budget exhausted');
      const input = JSON.parse(user);
      const keep = partialWriter ? input.items.slice(0, -1) : input.items;
      return options.validate({
        items: keep.map(x => ({ id: x.id, title_zh: '住宅市场进展', summary_zh: '研究显示销售增长 5%，可负担性仍是约束。', impact: 'neutral', ...modelEvidence(x) })),
        executive_summary: { sentences: [{ text: '研究显示住宅销售增长 5%，仍需关注可负担性。', text_en: 'Housing sales rose 5%, while affordability remains a constraint.', item_ids: keep.map(x => x.id) }] },
        themes: []
      });
    }
  };
}

test('daily keeps complete status when non-required 403 or selected-section evidence_gap occurs, and degrades when 0-selected or required fails', async t => {
  const now = new Date('2026-11-17T01:00:00Z');
  const window = buildWindow('daily', now);
  const baseDesc = 'The original research report finds housing sales rose 5% in Phoenix while inventory remains balanced.';
  const btrOk = { ...sample('btr-ok', window.upper - 3600000), title: 'Build-to-rent community opens in Phoenix', description: baseDesc, source_id: 'btr-pub', source_family: 'btr-pub' };
  const btrInsufficient = { ...sample('btr-bad', window.upper - 7200000), title: 'Build-to-rent pipeline update in Phoenix', description: baseDesc };
  const creOk = { ...sample('cre-ok', window.upper - 5400000), title: 'Sunbelt multifamily tower trades in Phoenix', description: baseDesc, source_id: 'req-ok', source_family: 'req-ok' };

  {
    const root = await sandbox(t);
    await fs.writeFile(path.join(root, 'config/sources.json'), JSON.stringify({ sources: [{ id: 'req-ok', required: true }, { id: 'opt-403', required: false, research: true }] }));
    const collector = {
      cache: {},
      enrich: async batch => batch.map(item => item.id === btrInsufficient.id ? { ...item, evidence_status: 'insufficient' } : item),
      collect: async () => [
        { items: [btrOk, btrInsufficient, creOk], health: { id: 'req-ok', required: true, status: 'ok', articles: 3, undated: 0, coverage: window } },
        { items: [], health: { id: 'opt-403', name: 'opt-403', required: false, research: true, status: 'error', error: 'HTTP 403' } }
      ]
    };
    const issue = await runPipeline('daily', { root, now, env: { NEWS_DATA_DIR: path.join(root, 'data'), NEWS_STATE_DIR: path.join(root, 'state'), PUBLISH_NOW: now.toISOString() }, collector, client: btrAwareClient() });
    assert.equal(issue.coverage_status, 'complete');
    assert.equal(issue.publication_status, 'complete');
    assert.deepEqual(issue.coverage_reasons, []);
    assert.equal(issue._diagnostics.editorial_coverage.sections.btr.evidence_gap, true);
    assert.ok(issue._diagnostics.editorial_coverage.sections.btr.selected >= 1);
    assert.deepEqual(issue.errors, [{ source: 'opt-403', error: 'HTTP 403' }]);
  }

  {
    const root = await sandbox(t);
    await fs.writeFile(path.join(root, 'config/sources.json'), JSON.stringify({ sources: [{ id: 'req-ok', required: true }] }));
    const collector = {
      cache: {},
      enrich: async batch => batch.map(item => item.id === btrInsufficient.id ? { ...item, evidence_status: 'insufficient' } : item),
      collect: async () => [
        { items: [btrInsufficient, creOk], health: { id: 'req-ok', required: true, status: 'ok', articles: 2, undated: 0, coverage: window } }
      ]
    };
    const issue = await runPipeline('daily', { root, now, env: { NEWS_DATA_DIR: path.join(root, 'data'), NEWS_STATE_DIR: path.join(root, 'state'), PUBLISH_NOW: now.toISOString() }, collector, client: btrAwareClient() });
    assert.equal(issue.coverage_status, 'degraded');
    assert.equal(issue.publication_status, 'degraded');
    assert.deepEqual(issue.coverage_reasons, ['section_lead_gap']);
    assert.equal(issue._diagnostics.editorial_coverage.sections.btr.selected, 0);
  }

  {
    const root = await sandbox(t);
    await fs.writeFile(path.join(root, 'config/sources.json'), JSON.stringify({ sources: [{ id: 'req-down', required: true }] }));
    const collector = {
      cache: {},
      enrich: async batch => batch,
      collect: async () => [
        { items: [btrOk, creOk], health: { id: 'req-down', required: true, status: 'error', error: 'HTTP 503' } }
      ]
    };
    const issue = await runPipeline('daily', { root, now, env: { NEWS_DATA_DIR: path.join(root, 'data'), NEWS_STATE_DIR: path.join(root, 'state'), PUBLISH_NOW: now.toISOString() }, collector, client: btrAwareClient() });
    assert.equal(issue.coverage_status, 'degraded');
    assert.deepEqual(issue.coverage_reasons, ['snapshot_gap', 'required_source']);
  }

  {
    const root = await sandbox(t);
    await fs.writeFile(path.join(root, 'config/sources.json'), JSON.stringify({ sources: [{ id: 'req-ok', required: true }, { id: 'sec-btr', required_for_section: 'btr' }] }));
    const collector = {
      cache: {},
      enrich: async batch => batch,
      collect: async () => [
        { items: [btrOk, creOk], health: { id: 'req-ok', required: true, status: 'ok', articles: 2, undated: 0, coverage: window } },
        { items: [], health: { id: 'sec-btr', required_for_section: 'btr', status: 'error', error: 'HTTP 403' } }
      ]
    };
    const issue = await runPipeline('daily', { root, now, env: { NEWS_DATA_DIR: path.join(root, 'data'), NEWS_STATE_DIR: path.join(root, 'state'), PUBLISH_NOW: now.toISOString() }, collector, client: btrAwareClient() });
    assert.equal(issue.coverage_status, 'degraded');
    assert.deepEqual(issue.coverage_reasons, ['required_source']);
  }

  {
    const root = await sandbox(t);
    await fs.writeFile(path.join(root, 'config/sources.json'), JSON.stringify({ sources: [{ id: 'req-ok', required: true }] }));
    const filler = Array.from({ length: 18 }, (_, i) => ({ ...sample(`extra-${i}`, window.upper - 1000 - i * 1000), title: `Sunbelt multifamily report ${i} in Phoenix`, description: baseDesc, source_id: 'req-ok', source_family: `pub-${i}` }));
    const collector = {
      cache: {},
      enrich: async batch => batch,
      collect: async () => [
        { items: [btrOk, creOk, ...filler], health: { id: 'req-ok', required: true, status: 'ok', articles: 20, undated: 0, coverage: window } }
      ]
    };
    const issue = await runPipeline('daily', { root, now, env: { NEWS_DATA_DIR: path.join(root, 'data'), NEWS_STATE_DIR: path.join(root, 'state'), PUBLISH_NOW: now.toISOString() }, collector, client: btrAwareClient({ partialWriter: true }) });
    assert.equal(issue.coverage_status, 'complete');
    assert.deepEqual(issue.coverage_reasons, []);
    assert.equal(issue.publication_status, 'degraded');
    assert.equal(issue.content_status, 'partial');
  }
});

test('recoverableRevision strictly bounds weekly 48h, monthly 3 working days, weekends, daily non-recovery, and max r2', () => {
  const monWeeklyNow = new Date('2026-11-16T06:07:00Z');
  const wWindow = buildWindow('weekly', monWeeklyNow);
  const fullWeeklySnap = { window: { lower: wWindow.lower, upper: wWindow.upper }, coverage_status: 'observed', source_health: [] };
  const baseWeeklySaved = {
    kind: 'weekly', period_start: wWindow.periodStart, window: wWindow, items: [{ id: 'a' }],
    edition: { revision: 1 }, coverage_status: 'degraded', publication_status: 'degraded',
    _diagnostics: { coverage_gaps: [{ lower: wWindow.lower, upper: wWindow.lower + 86400000 }] }
  };

  // Within 48h (Tuesday 10:17 CST and exact 48h boundary Wednesday 13:00 CST) -> 2
  assert.equal(recoverableRevision({ kind: 'weekly', saved: baseWeeklySaved, snapshots: [fullWeeklySnap], window: wWindow, now: new Date('2026-11-17T02:17:00Z') }), 2);
  assert.equal(recoverableRevision({ kind: 'weekly', saved: baseWeeklySaved, snapshots: [fullWeeklySnap], window: wWindow, now: new Date(wWindow.upper + 48 * 3600000) }), 2);
  // 1ms past 48h -> null
  assert.equal(recoverableRevision({ kind: 'weekly', saved: baseWeeklySaved, snapshots: [fullWeeklySnap], window: wWindow, now: new Date(wWindow.upper + 48 * 3600000 + 1) }), null);
  // Before Mon 14:00 CST primary -> false
  assert.equal(canAttemptRecoverySchedule('weekly', new Date('2026-11-16T05:59:59Z')), false);
  // Gap still incomplete -> null
  assert.equal(recoverableRevision({ kind: 'weekly', saved: baseWeeklySaved, snapshots: [{ window: { lower: wWindow.lower, upper: wWindow.lower + 3600000 }, coverage_status: 'observed', source_health: [] }], window: wWindow, now: new Date('2026-11-17T02:17:00Z') }), null);
  // Already r2 -> never triggers r3
  assert.equal(recoverableRevision({ kind: 'weekly', saved: { ...baseWeeklySaved, edition: { revision: 2 } }, snapshots: [fullWeeklySnap], window: wWindow, now: new Date('2026-11-17T02:17:00Z') }), null);
  // Non-gap degraded (coverage_gaps empty) -> null
  assert.equal(recoverableRevision({ kind: 'weekly', saved: { ...baseWeeklySaved, _diagnostics: { coverage_gaps: [] } }, snapshots: [fullWeeklySnap], window: wWindow, now: new Date('2026-11-17T02:17:00Z') }), null);

  // Daily never auto-revises
  const dailyNow = new Date('2026-11-17T01:00:00Z');
  const dWindow = buildWindow('daily', dailyNow);
  assert.equal(withinRecoveryWindow('daily', dailyNow, dWindow), false);
  assert.equal(canAttemptRecoverySchedule('daily', dailyNow), false);
  assert.equal(recoverableRevision({ kind: 'daily', saved: { kind: 'daily', items: [{ id: 'd' }], window: dWindow, edition: { revision: 1 }, coverage_status: 'degraded', _diagnostics: { coverage_gaps: [{ lower: 1, upper: 2 }] } }, snapshots: [], window: dWindow, now: dailyNow }), null);

  // Monthly: May 2026 starts Fri May 1 (#1), May 2 Sat, May 3 Sun, May 4 Mon (#2), May 5 Tue (#3), May 6 Wed (#4 -> rejected)
  const mayWindow = buildWindow('monthly', new Date('2026-05-01T07:07:00Z'));
  const maySaved = {
    kind: 'monthly', period_label: mayWindow.label, window: mayWindow, items: [{ id: 'm' }],
    edition: { revision: 1 }, coverage_status: 'degraded', _diagnostics: { coverage_gaps: [{ lower: mayWindow.lower, upper: mayWindow.upper }] }
  };
  const fullMaySnap = { window: { lower: mayWindow.lower, upper: mayWindow.upper }, coverage_status: 'observed', source_health: [] };
  assert.equal(canAttemptRecoverySchedule('monthly', new Date('2026-05-01T06:59:59Z')), false); // Before 15:00 CST on 1st working day
  assert.equal(withinRecoveryWindow('monthly', new Date('2026-05-02T02:17:00Z'), mayWindow), false); // Saturday
  assert.equal(withinRecoveryWindow('monthly', new Date('2026-05-03T02:17:00Z'), mayWindow), false); // Sunday
  assert.equal(recoverableRevision({ kind: 'monthly', saved: maySaved, snapshots: [fullMaySnap], window: mayWindow, now: new Date('2026-05-04T02:17:00Z') }), 2); // #2 working day
  assert.equal(recoverableRevision({ kind: 'monthly', saved: maySaved, snapshots: [fullMaySnap], window: mayWindow, now: new Date('2026-05-05T02:17:00Z') }), 2); // #3 working day
  assert.equal(recoverableRevision({ kind: 'monthly', saved: maySaved, snapshots: [fullMaySnap], window: mayWindow, now: new Date('2026-05-06T02:17:00Z') }), null); // #4 working day
});

test('weekly compensatory recovery executes r2 cleanly on Tuesday once missing snapshot lands, pushes cleanly, and never runs r3', async t => {
  const temp = await sandbox(t);
  const seed = path.join(temp, 'seed'), remote = path.join(temp, 'remote.git'), root = path.join(temp, 'runner');
  await fs.mkdir(seed);
  await gitCommand(seed, ['init', '-b', 'main']);
  for (const d of ['data', 'state', 'config', 'public']) await fs.mkdir(path.join(seed, d));
  await fs.writeFile(path.join(seed, '.gitignore'), '.tmp/\nstate/issues/\nstate/collection-cache.json\nstate/source-cache.json\nstate/llm-cache/\nstate/llm-diagnostics/\n');
  await fs.writeFile(path.join(seed, 'config/sources.json'), JSON.stringify({ sources: [{ id: 'a', required: true }] }));
  await fs.writeFile(path.join(seed, 'config/tags.json'), await fs.readFile(new URL('../../config/tags.json', import.meta.url), 'utf8'));
  await fs.writeFile(path.join(seed, 'data/latest.json'), JSON.stringify({ date: '2026-11-13', window: { upper: Date.parse('2026-11-12T21:00:00Z') } }));
  await gitCommand(seed, ['add', '.']);
  await gitCommand(seed, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'seed']);
  await gitCommand(temp, ['init', '--bare', remote]);
  await gitCommand(seed, ['remote', 'add', 'origin', remote]);
  await gitCommand(seed, ['push', 'origin', 'main']);
  await gitCommand(temp, ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  await gitCommand(temp, ['clone', remote, root]);

  const mon = '2026-11-16T06:07:00Z';
  const wWindow = buildWindow('weekly', new Date(mon));
  const halfSpan = wWindow.lower + Math.floor((wWindow.upper - wWindow.lower) / 2);
  // Seed first half snapshot only so Monday r1 is degraded with a snapshot_gap
  await fs.mkdir(path.join(root, 'state/snapshots'), { recursive: true });
  await fs.writeFile(path.join(root, 'state/snapshots/part1.json'), JSON.stringify({ schema_version: 3, coverage_status: 'observed', window: { lower: wWindow.lower, upper: halfSpan }, source_health: [], items: [] }));

  const collector = {
    cache: {},
    enrich: async x => x,
    collect: async () => [{ items: [{ ...sample('wk-story', wWindow.upper - 3600000), source_id: 'a', source_family: 'a' }], health: { id: 'a', required: true, status: 'ok', articles: 1, undated: 0, coverage: { lower: halfSpan, upper: wWindow.upper } } }]
  };
  const r1 = await runPipeline('weekly', { root, now: new Date(mon), env: { NEWS_DATA_DIR: path.join(root, 'data'), NEWS_STATE_DIR: path.join(root, 'state'), PUBLISH_NOW: mon }, collector, client: fakeClient() });
  assert.equal(r1.edition.revision, 1);
  assert.equal(r1.coverage_status, 'degraded');
  assert.deepEqual(r1.coverage_reasons, ['snapshot_gap']);

  // Commit r1 and part1 snapshot to remote/main to reflect Monday production state
  await gitCommand(root, ['add', 'data/weekly', 'state/snapshots']);
  await gitCommand(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'publish r1 degraded']);
  await gitCommand(root, ['push', 'origin', 'main']);

  // Tuesday 10:17 CST BEFORE gap filled -> skipped everywhere
  const tue = '2026-11-17T02:17:00Z';
  const beforeGate = await runCanRun(root, 'weekly', tue);
  assert.equal(beforeGate.json.go, false);
  const beforeRestore = await runRestore(root, 'weekly', tue);
  assert.equal(beforeRestore.json.skipped, true);
  const skippedTue = await runPipeline('weekly', { root, now: new Date(tue), env: { NEWS_DATA_DIR: path.join(root, 'data'), NEWS_STATE_DIR: path.join(root, 'state'), PUBLISH_NOW: tue }, collector, client: { call() { throw new Error('must not run'); } } });
  assert.equal(skippedTue.skipped, true);

  // Dispatch handler on Tuesday 14:00 CST allows compensatory dispatch, while Saturday & Thursday skip
  const oldSecret = process.env.CRON_SECRET, oldPat = process.env.GH_PAT;
  delete process.env.CRON_SECRET; process.env.GH_PAT = 'test-pat';
  try {
    let dispatched = 0;
    const handlerTue = makeHandler('weekly', { now: () => new Date('2026-11-17T06:00:00Z'), fetchImpl: async () => { dispatched++; return { ok: true, status: 204 }; } });
    let bodyTue; await handlerTue({ headers: {} }, { status() { return this; }, json(v) { bodyTue = v; } });
    assert.equal(dispatched, 1); assert.equal(bodyTue.ok, true);

    const handlerThu = makeHandler('weekly', { now: () => new Date('2026-11-19T06:00:00Z'), fetchImpl: async () => { dispatched++; throw new Error('must not dispatch Thu'); } });
    let bodyThu; await handlerThu({ headers: {} }, { status() { return this; }, json(v) { bodyThu = v; } });
    assert.equal(bodyThu.skipped, true); assert.equal(dispatched, 1);
  } finally {
    if (oldSecret !== undefined) process.env.CRON_SECRET = oldSecret;
    if (oldPat !== undefined) process.env.GH_PAT = oldPat; else delete process.env.GH_PAT;
  }

  // Morning daily snapshot lands filling the rest of the weekly window -> pushed to origin/main
  await fs.writeFile(path.join(root, 'state/snapshots/part2.json'), JSON.stringify({ schema_version: 3, coverage_status: 'observed', window: { lower: halfSpan, upper: wWindow.upper }, source_health: [], items: [{ ...sample('wk-story', wWindow.upper - 3600000), source_id: 'a', source_family: 'a' }] }));
  await gitCommand(root, ['add', 'state/snapshots/part2.json']);
  await gitCommand(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fill missing snapshot']);
  await gitCommand(root, ['push', 'origin', 'main']);

  // Tuesday 10:17 CST AFTER gap filled -> can-run approves r2 and exports ISSUE_REVISION=2
  const afterGate = await runCanRun(root, 'weekly', tue);
  assert.equal(afterGate.json.go, true);
  assert.equal(afterGate.json.revision, 2);
  assert.match(afterGate.output, /go=true/);
  assert.match(afterGate.output, /verify=true/);
  assert.match(afterGate.env, /ISSUE_REVISION=2/);

  // pipeline runs r2 to ready in isolated r2 manifest without touching r1, then pushCandidate pushes cleanly on Tuesday
  const ready = await runPipeline('weekly', { root, now: new Date(tue), env: { NEWS_DATA_DIR: path.join(root, 'data'), NEWS_STATE_DIR: path.join(root, 'state'), PUBLISH_NOW: tue, PIPELINE_UNTIL: 'ready', ISSUE_REVISION: '2' }, collector: { cache: {}, enrich: async x => x, collect: async () => [{ items: [], health: { id: 'a', required: true, status: 'ok', articles: 1, undated: 0, coverage: { lower: halfSpan, upper: wWindow.upper } } }] }, client: fakeClient() });
  assert.equal(ready.stage, 'ready');
  const r2Bundle = JSON.parse(await fs.readFile(path.join(ready.issue_dir, 'ready.json'), 'utf8'));
  assert.equal(r2Bundle.payload.edition.revision, 2);
  assert.equal(r2Bundle.payload.recovered_from_revision, 1);
  assert.equal(r2Bundle.payload.coverage_status, 'complete');
  assert.deepEqual(r2Bundle.payload.coverage_reasons, []);

  // r1 manifest stays completely separate from r2
  await fs.access(path.join(root, 'state/issues/weekly', periodKey('weekly', wWindow), 'r1/manifest.json'));
  await fs.access(path.join(root, 'state/issues/weekly', periodKey('weekly', wWindow), 'r2/manifest.json'));

  const pushed = await pushCandidate(r2Bundle, { root, now: new Date('2026-11-17T02:20:00Z') });
  assert.ok(pushed.commit);
  await gitCommand(root, ['fetch', 'origin', 'main']);
  const remotePublished = JSON.parse(await gitCommand(root, ['show', 'origin/main:data/weekly/' + wWindow.periodStart + '.json']));
  assert.equal(remotePublished.edition.revision, 2);
  assert.equal(remotePublished.coverage_status, 'complete');
  assert.equal(remotePublished.recovered_from_revision, 1);

  const postRoot = path.join(temp, 'post-check');
  await gitCommand(temp, ['clone', remote, postRoot]);
  const postGate = await runCanRun(postRoot, 'weekly', '2026-11-17T06:17:00Z');
  assert.equal(postGate.json.go, false);
  const postRestore = await runRestore(postRoot, 'weekly', '2026-11-17T06:17:00Z', { ISSUE_REVISION: '2' });
  assert.equal(postRestore.json.skipped, true);
  const noR3 = await runPipeline('weekly', { root: postRoot, now: new Date('2026-11-17T06:17:00Z'), env: { NEWS_DATA_DIR: path.join(postRoot, 'data'), NEWS_STATE_DIR: path.join(postRoot, 'state'), PUBLISH_NOW: '2026-11-17T06:17:00Z' }, collector, client: { call() { throw new Error('must never create r3'); } } });
  assert.equal(noR3.skipped, true);
});

test('frontend coverageNote renders honest mode-aware messages and eliminates false update promise', async () => {
  for (const lang of ['zh', 'en']) {
    const { ctx, ids, app } = await loadRenderBrief(lang);
    assert.doesNotMatch(app, /补齐后可更新|this issue can be updated/);

    // Complete daily with non-required error stays clean with hidden banner
    ctx.renderBrief({ kind: 'daily', coverage_status: 'complete', coverage_reasons: [], publication_status: 'complete', items: [{ id: '1', link: 'https://a.invalid', source_name: 'S' }], _diagnostics: { source_health: [{ name: 'BTR List', research: true, status: 'error' }] } });
    assert.equal(ids.coverageNote.hidden, true);
    assert.equal(ids.researchCoverage.hidden, false);

    // Weekly r1 snapshot_gap states bounded r2 rule honestly
    ctx.renderBrief({ kind: 'weekly', edition: { revision: 1 }, coverage_status: 'degraded', coverage_reasons: ['snapshot_gap'], publication_status: 'degraded', items: [{ id: '1', link: 'https://a.invalid', source_name: 'S' }] });
    assert.equal(ids.coverageNote.hidden, false);
    assert.match(ids.coverageNote.textContent, lang === 'zh' ? /第 2 版/ : /Edition 2/);

    // Weekly r2 recovered banner
    ctx.renderBrief({ kind: 'weekly', edition: { revision: 2 }, recovered_from_revision: 1, coverage_status: 'complete', coverage_reasons: [], publication_status: 'complete', items: [{ id: '1', link: 'https://a.invalid', source_name: 'S' }] });
    assert.equal(ids.coverageNote.hidden, false);
    assert.match(ids.coverageNote.textContent, lang === 'zh' ? /第 2 版：已补齐/ : /Edition 2: updated/);

    // Required or section lead gap never promises update
    ctx.renderBrief({ kind: 'daily', edition: { revision: 1 }, coverage_status: 'degraded', coverage_reasons: ['section_lead_gap'], publication_status: 'degraded', items: [{ id: '1', link: 'https://a.invalid', source_name: 'S' }] });
    assert.equal(ids.coverageNote.hidden, false);
    assert.doesNotMatch(ids.coverageNote.textContent, /补齐后可更新|can be updated/);
  }
});
