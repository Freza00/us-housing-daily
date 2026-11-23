import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLlmClient, LlmError } from '../lib/llm-client.mjs';
import { createModelBatch } from '../lib/model-references.mjs';
import { buildReviewDraft, createReviewRepair, createWritingRepair, validateDecisions, validateWriting, writingEvidenceOptions, writingPrompt, writingSystem, reviewPrompt, selectItems, numericValues, normalizeChinese, prepareReview } from '../lib/editorial.mjs';
import { digest, validateIssue } from '../lib/issue-contract.mjs';
import { runPipeline } from '../lib/pipeline.mjs';
import { fakeClient, modelDecision, modelEvidence, sandbox, sample, replayEnv } from './helpers.mjs';

const date = Date.parse('2026-10-28T14:00:00Z');
const items = ['ee97eb3b7b51bf8f', '8f51e30b0b1f3098', 'third'].map(id => sample(id, date));
const decision = id => ({ id, keep: true, importance: 4, section: 'national', capital_focus: false, tags: [], duplicate_of: null });
const card = item => ({ id: item.id, title_zh: '住宅研究', summary_zh: '销售增长 5%。', impact: 'neutral', ...(item.evidence_options ? modelEvidence(item) : { evidence_quote: item.description }) });
const writing = selected => ({ items: selected.map(card), executive_summary: { sentences: [{ text: '销售增长 5%，可负担性仍是约束。', text_en: 'Sales rose 5%, while affordability remains a constraint.', item_ids: selected.map(x => x.id) }] }, themes: [] });

test('numeric ranges and narrative dashes survive formatting without inventing negative claims', () => {
  for (const range of ['30–40', '30--40', '30-40', '30 - 40', '30%–40%', '30%-40%', '预期--30 至 40']) {
    assert.deepEqual([...numericValues(range)], ['30', '40'], range);
    assert.deepEqual(numericValues(normalizeChinese(range)), numericValues(range), range);
  }
  for (const negative of ['-40', '−40', '下降 -40%']) assert.deepEqual([...numericValues(negative)], ['-40']);
  assert.deepEqual([...numericValues('-40 to -30')], ['-40', '-30']);
  assert.deepEqual(numericValues(normalizeChinese('-40–−30')), new Set(['-40', '-30']));
  const selected = [{ ...items[0], description: 'Mortgage rates declined by 30–40 basis points according to the research.' }];
  const data = { items: [{ ...card(selected[0]), summary_zh: '利率下降 30–40 个基点。' }], executive_summary: { sentences: [{ text: '利率下降 30–40 个基点。', item_ids: [selected[0].id] }] }, themes: [{ title: '利率下降 30–40 个基点', item_ids: [selected[0].id] }] };
  const result = validateWriting(data, selected, 'weekly');
  assert.deepEqual(validateWriting(JSON.parse(JSON.stringify(result)), selected, 'weekly'), result);
  assert.throws(() => validateWriting({ ...data, items: [{ ...data.items[0], summary_zh: '利率为 -40。' }] }, selected), /number absent/);
});
function response(value, { done = true } = {}) {
  return new Response('data: ' + JSON.stringify({ id: 'upstream-response', model: 'test-model', choices: [{ delta: { content: typeof value === 'string' ? value : JSON.stringify(value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } }) + '\n\n' + (done ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'upstream-request' } });
}

test('57 short references round-trip stable IDs and reject the actual fused production ID', () => {
  const all = [...items.slice(0, 2), ...Array.from({ length: 55 }, (_, i) => sample('fixture-' + i, date))];
  const batch = createModelBatch(all);
  assert.equal(batch.items.length, 57);
  assert.deepEqual(batch.items.map(x => x.id), Array.from({ length: 57 }, (_, i) => String(i + 1)));
  const result = batch.decisions({ decisions: batch.items.map(x => decision(x.id)) });
  assert.deepEqual(validateDecisions(result, all).decisions.map(x => x.id), all.map(x => x.id));
  assert.throws(() => batch.decisions({ decisions: [decision('ee97eb3b7b1f3098')] }), /Unknown model reference/);
  assert.throws(() => batch.decisions({ decisions: [decision(1)] }), /Unknown model reference/);
  assert.throws(() => batch.decisions({ decisions: [null] }), /Unknown model reference/);
});

test('short references preserve global duplicate checks and summary/theme identity', () => {
  const batch = createModelBatch(items);
  const values = batch.items.map(x => decision(x.id));
  values[0].duplicate_of = '2'; values[1].duplicate_of = '3';
  assert.throws(() => validateDecisions(batch.decisions({ decisions: values }), items), /duplicate reference/);
  assert.throws(() => validateDecisions(batch.decisions({ decisions: [values[0], values[0], values[2]] }), items));
  const data = writing(batch.items); data.themes = [{ title: '销售改善', item_ids: ['1', '3'] }];
  const restored = batch.writing(data);
  assert.deepEqual(restored.executive_summary.sentences[0].item_ids, items.map(x => x.id));
  assert.deepEqual(restored.themes[0].item_ids, [items[0].id, items[2].id]);
  data.executive_summary.sentences[0].item_ids = ['unknown'];
  assert.throws(() => batch.writing(data), /Unknown model reference/);
});

test('normal pipeline uses three stages (editor high, writer high, reviewer xhigh) and never publishes batch references', async t => {
  const root = await sandbox(t), requests = [];
  const client = createLlmClient({ endpoint: 'https://example.com', apiKey: 'test', retryDelays: [], fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    const input = JSON.parse(body.messages[1].content);
    if (Array.isArray(input)) return response({ decisions: input.map(x => modelDecision(x.id)) });
    if (input.review_target) return response({ status: 'pass', issues: [], items: [] });
    return response(writing(input.items.map(x => ({ ...x, description: x.evidence }))));
  } });
  const env = await replayEnv(root, { items }, '2026-10-29T01:00:00Z');
  const result = await runPipeline('daily', { root, env, client });
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(x => x.model), ['gpt-6.2-sol', 'gpt-6.2-sol', 'gpt-6.2-sol']);
  assert.deepEqual(requests.map(x => x.reasoning_effort), ['high', 'high', 'xhigh']);
  assert.deepEqual(requests.map(x => x.max_completion_tokens), [16000, 16000, 24000]);
  assert.deepEqual(new Set(result.items.map(x => x.id)), new Set(items.map(x => x.id)));
  assert.ok(result.executive_summary.sentences[0].item_ids.every(id => items.some(x => x.id === id)));
});

test('writer repairs only bad cards, preserves good cards and revalidates cached full output', async t => {
  const root = await sandbox(t), batch = createModelBatch(items), cacheDir = path.join(root, 'state/cache');
  const initial = writing(batch.items); initial.items[1].summary_zh = '销售增长 99%。';
  initial.items[0].summary_zh = '研究显示销售增长 5%。';
  const validate = (data, context = {}) => validateWriting(context.cacheHit ? data : batch.writing(data), items, 'daily', context);
  const requests = [];
  const client = createLlmClient({ endpoint: 'https://example.com', apiKey: 'test', cacheDir, sleep: async () => {}, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    if (requests.length === 1) return response(initial);
    assert.deepEqual(JSON.parse(body.messages[1].content).items.map(x => x.id), ['2']);
    assert.match(JSON.parse(body.messages[1].content).corrections[0].error, /number absent/);
    assert.equal(JSON.parse(body.messages[1].content).corrections[0].previous_card.summary_zh, '销售增长 99%。');
    return response({ items: [card(batch.items[1])] });
  } });
  const options = { label: 'writer', validate, repair: data => createWritingRepair(data, batch.items, 'daily', validate) };
  const first = await client.call(writingSystem, writingPrompt('daily', batch.items), options);
  const second = await client.call(writingSystem, writingPrompt('daily', batch.items), options);
  assert.equal(requests.length, 2);
  assert.equal(first.items[0].summary_zh, initial.items[0].summary_zh);
  assert.deepEqual(first.items.map(x => x.id), items.map(x => x.id));
  assert.deepEqual(second.items, first.items);
  assert.equal(client.usage.at(-1).cache_hit, true);
});

test('writer cannot use a partial correction to rewrite another card or bypass number checks', () => {
  const batch = createModelBatch(items), data = writing(batch.items);
  data.items[1].summary_zh = '销售增长 99%。';
  const validate = value => validateWriting(batch.writing(value), items);
  const plan = createWritingRepair(data, batch.items, 'daily', validate);
  assert.throws(() => plan.validate({ items: [card(batch.items[0])] }), /repair reference/);
  assert.throws(() => plan.validate({ items: [data.items[1]] }), /number absent/);
  for (const invalid of [
    { ...data, items: [data.items[0], data.items[0]] },
    { ...data, items: [...data.items, { id: 'unknown' }] }
  ]) assert.equal(createWritingRepair(invalid, batch.items, 'daily', validate), null);
  const mixed = { ...data, executive_summary: { sentences: [{ text: '销售增长 99%。', item_ids: ['1'] }] } };
  const mixedPlan = createWritingRepair(mixed, batch.items, 'daily', validate);
  assert.throws(() => mixedPlan.validate({ items: [card(batch.items[1])], executive_summary: mixed.executive_summary }), /number absent/);
  assert.equal(mixedPlan.validate({ items: [card(batch.items[1])], executive_summary: { sentences: [{ text: '销售增长 5%。', item_ids: ['1'] }] }, themes: [] }).items.length, 3);
});

test('full correction includes the failed answer and shares a three-attempt transport budget', async () => {
  const requests = [];
  const client = createLlmClient({ endpoint: 'https://example.com', apiKey: 'test', sleep: async () => {}, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    if (requests.length === 1) throw new TypeError('terminated', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) });
    return response('bad JSON');
  } });
  await assert.rejects(client.call('s', 'u'), /invalid JSON/);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].messages.at(-2).role, 'assistant');
  assert.equal(requests[2].messages.at(-2).content, 'bad JSON');
  assert.equal(client.usage[0].causes[0].code, 'ECONNRESET');
  assert.ok(client.usage.every(x => x.failed));
});

test('failed attempts persist redacted diagnostics, response IDs and received usage', async t => {
  const root = await sandbox(t), diagnosticsDir = path.join(root, 'state/diagnostics'), events = [];
  const client = createLlmClient({ endpoint: 'https://example.com', apiKey: 'private-test-key', diagnosticsDir, retryDelays: [], onEvent: event => events.push(event), fetchImpl: async () => response('private-test-key') });
  await assert.rejects(client.call('s', 'u', { label: 'editor' }));
  const log = await fs.readFile(path.join(diagnosticsDir, 'attempts.jsonl'), 'utf8');
  const entries = log.trim().split('\n').map(JSON.parse), result = entries.at(-1);
  assert.equal(result.label, 'editor'); assert.equal(result.event, 'request_finished');
  assert.equal(result.upstream_request_id, 'upstream-request'); assert.equal(result.response_id, 'upstream-response');
  assert.equal(result.usage.completion_tokens, 4); assert.ok(result.request_id); assert.ok(result.request_hash);
  assert.equal(result.finish_reason, 'stop'); assert.ok(result.response_file);
  const raw = await fs.readFile(path.join(diagnosticsDir, result.response_file), 'utf8');
  assert.ok(!log.includes('private-test-key')); assert.ok(!raw.includes('private-test-key'));
  assert.equal(events.length, 2);
});

test('permanent routing failure is logged once with null usage and no secret', async t => {
  const root = await sandbox(t); let calls = 0;
  const client = createLlmClient({ endpoint: 'https://example.com', apiKey: 'private-test-key', diagnosticsDir: path.join(root, 'state/diagnostics'), fetchImpl: async () => { calls++; return new Response('model_not_found private-test-key', { status: 503 }); } });
  await assert.rejects(client.call('s', 'u'), error => !error.message.includes('private-test-key'));
  assert.equal(calls, 1); assert.equal(client.usage[0].usage, null); assert.equal(client.usage[0].retryable, false);
});

for (const [status, detail, backupEndpoint] of [
  [522, 'origin timed out', undefined],
  [403, 'insufficient_quota', 'https://backup.example.com/v1/chat/completions'],
  [429, 'insufficient_quota', 'https://primary.example.com/v1/chat/completions']
]) {
  test(`pipeline HTTP ${status} ${detail} switches within editor budget and writer reuses backup`, async t => {
    const root = await sandbox(t), requests = [];
    const env = { ...await replayEnv(root, { items }, '2026-10-29T01:00:00Z'),
      LLM_ENDPOINT: 'https://primary.example.com/v1/chat/completions', LLM_API_KEY: 'fixture-primary',
      LLM_BACKUP_API_KEY: 'fixture-backup', ...(backupEndpoint ? { LLM_BACKUP_ENDPOINT: backupEndpoint } : {}) };
    const result = await runPipeline('daily', { root, env, llmOptions: { sleep: async () => {}, fetchImpl: async (url, options) => {
      requests.push({ url, authorization: options.headers.Authorization });
      if (requests.length === 1) return new Response(detail, { status });
      const input = JSON.parse(JSON.parse(options.body).messages[1].content);
      if (input.review_target) return response({ status: 'pass', issues: [], items: [] });
      return Array.isArray(input) ? response({ decisions: input.map(x => modelDecision(x.id)) }) : response(writing(input.items.map(x => ({ ...x, description: x.evidence }))));
    } } });
    assert.deepEqual(requests, [
      { url: env.LLM_ENDPOINT, authorization: 'Bearer fixture-primary' },
      ...Array.from({ length: 3 }, () => ({ url: backupEndpoint || 'https://api.openai.com/v1/chat/completions', authorization: 'Bearer fixture-backup' }))
    ]);
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'state/issues/daily/2026-10-29/r1/manifest.json'), 'utf8'));
    assert.deepEqual(manifest.attempts.editor.map(x => [x.attempt, x.route]), [[1, 'primary'], [2, 'backup']]);
    assert.deepEqual(manifest.attempts.writer.map(x => [x.attempt, x.route]), [[1, 'backup']]);
    assert.deepEqual(manifest.attempts.reviewer.map(x => [x.attempt, x.route]), [[1, 'backup']]);
    assert.ok(Object.values(manifest.attempts).flat().every(x => x.reserved_ms > 0 && x.reserved_ms <= (x.label === 'reviewer' ? 270000 : 240000)));
    assert.equal(result.items.length, items.length);
  });
}

test('complete JSON validation errors repair on the current primary or backup route', async () => {
  for (const startOnBackup of [false, true]) {
    const routes = []; let validations = 0, repairs = 0;
    const client = createLlmClient({ endpoint: 'https://primary.example.com', apiKey: 'fixture-primary',
      fallbackEndpoint: 'https://backup.example.com', fallbackApiKey: 'fixture-backup', sleep: async () => {}, fetchImpl: async url => {
        routes.push(url);
        if (startOnBackup && routes.length === 1) return new Response('origin timed out', { status: 522 });
        return response({ ok: true });
      } });
    const validate = value => { if (++validations === 1) throw new LlmError('Invalid business evidence'); return value; };
    assert.deepEqual(await client.call('s', 'u', { validate, repair: () => { repairs++; return { user: 'repair only the failed evidence', validate }; } }), { ok: true });
    await client.call('s', 'writer', { label: 'writer' });
    assert.deepEqual(routes, startOnBackup
      ? ['https://primary.example.com', 'https://backup.example.com', 'https://backup.example.com', 'https://backup.example.com']
      : ['https://primary.example.com', 'https://primary.example.com', 'https://primary.example.com']);
    assert.equal(repairs, 1);
  }
});

test('all primary HTTP failures can switch, while permanent backup HTTP errors fail immediately', async () => {
  for (const [status, detail] of [[400, 'bad request'], [401, 'invalid_api_key'], [403, 'forbidden'], [408, 'timeout'], [429, 'rate limit'], [500, 'server error'], [503, 'get_channel_failed'], [404, 'model_not_found']]) {
    const routes = [];
    const client = createLlmClient({ endpoint: 'https://primary.example.com', apiKey: 'fixture-primary',
      fallbackEndpoint: 'https://backup.example.com', fallbackApiKey: 'fixture-backup', sleep: async () => {}, fetchImpl: async url => {
        routes.push(url); return routes.length === 1 ? new Response(detail, { status }) : response({ ok: true });
      } });
    assert.deepEqual(await client.call('s', 'u'), { ok: true });
    assert.deepEqual(routes, ['https://primary.example.com', 'https://backup.example.com']);
  }
  for (const [status, detail] of [[404, 'model_not_found'], [401, 'invalid_api_key'], [429, 'insufficient_quota'], [503, 'get_channel_failed']]) {
    const routes = [];
    const client = createLlmClient({ endpoint: 'https://primary.example.com', apiKey: 'fixture-primary',
      fallbackEndpoint: 'https://backup.example.com', fallbackApiKey: 'fixture-backup', sleep: async () => {}, fetchImpl: async url => {
        routes.push(url); return routes.length === 1 ? new Response('origin timed out', { status: 522 }) : new Response(detail, { status });
      } });
    await assert.rejects(client.call('s', 'u'), new RegExp(detail));
    assert.deepEqual(routes, ['https://primary.example.com', 'https://backup.example.com']);
    assert.equal(client.usage.at(-1).retryable, false);
  }
});

test('network, timeout, stream and invalid or incomplete JSON failures switch before content validation', async () => {
  const failures = [
    async () => { throw new TypeError('network unavailable'); },
    async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    async () => new Response('data: {"error":{"message":"channel failed"}}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    async () => response({ ok: true }, { done: false }),
    async () => response('{"ok":'),
    async () => new Response('{invalid envelope', { headers: { 'content-type': 'application/json' } })
  ];
  for (const failure of failures) {
    const routes = [], payloads = []; let validations = 0;
    const client = createLlmClient({ endpoint: 'https://primary.example.com', apiKey: 'fixture-primary',
      fallbackEndpoint: 'https://backup.example.com', fallbackApiKey: 'fixture-backup', totalMs: 20, sleep: async () => {}, fetchImpl: async (url, options) => {
        routes.push(url); payloads.push(JSON.parse(options.body)); return routes.length === 1 ? failure(url, options) : response({ ok: true });
      } });
    assert.deepEqual(await client.call('s', 'u', { validate: value => { validations++; return value; } }), { ok: true });
    assert.deepEqual(routes, ['https://primary.example.com', 'https://backup.example.com']);
    assert.equal(payloads.at(-1).messages.length, 2);
    assert.equal(client.usage.at(-1).repairs, 0);
    assert.equal(validations, 1);
  }
});

test('both keys are fully redacted even when either key is a prefix of the other', async t => {
  const root = await sandbox(t);
  for (const [apiKey, fallbackApiKey] of [['fixture-secret', 'fixture-secret-long'], ['fixture-secret-long', 'fixture-secret']]) {
    const dir = path.join(root, apiKey), diagnosticsDir = path.join(dir, 'diagnostics'), cacheDir = path.join(dir, 'cache'), events = [], ledgerEvents = [];
    let calls = 0;
    const client = createLlmClient({ endpoint: 'https://primary.example.com', apiKey, fallbackEndpoint: 'https://backup.example.com', fallbackApiKey,
      diagnosticsDir, cacheDir, sleep: async () => {}, onEvent: event => events.push(event),
      ledger: { recordAttempt: async (label, event) => ledgerEvents.push(event), recordOutcome: async (label, event) => ledgerEvents.push(event), recordDelay: async () => {} },
      fetchImpl: async () => {
        if (++calls === 1) throw new TypeError(apiKey + ' ' + fallbackApiKey, { cause: new Error(fallbackApiKey + ' ' + apiKey) });
        const res = response(apiKey + ' ' + fallbackApiKey);
        res.headers.set('x-request-id', fallbackApiKey); return res;
      } });
    await assert.rejects(client.call('s', 'u'), error => !error.message.includes('fixture-secret'));
    assert.equal(calls, 3);
    const files = [];
    for (const folder of [diagnosticsDir, cacheDir]) for (const name of await fs.readdir(folder)) files.push(await fs.readFile(path.join(folder, name), 'utf8'));
    const all = JSON.stringify([files, client.usage, events, ledgerEvents]);
    assert.ok(!all.includes(apiKey)); assert.ok(!all.includes(fallbackApiKey));
    assert.ok(!all.includes('[REDACTED]-long')); assert.match(all, /REDACTED/);
    assert.deepEqual(client.usage.map(x => x.route), ['primary', 'backup', 'backup']);
  }
});

test('absent, incomplete or identical fallback preserves permanent primary fast failure', async () => {
  for (const fallback of [{}, { fallbackEndpoint: 'https://backup.example.com' }, { fallbackApiKey: 'fixture-backup' },
    { fallbackEndpoint: 'https://primary.example.com', fallbackApiKey: 'fixture-primary' }]) {
    let calls = 0;
    const client = createLlmClient({ endpoint: 'https://primary.example.com', apiKey: 'fixture-primary', ...fallback, sleep: async () => {},
      fetchImpl: async () => { calls++; return new Response('insufficient_quota', { status: 429 }); } });
    await assert.rejects(client.call('s', 'u'), /insufficient_quota/);
    assert.equal(calls, 1);
  }
});

test('primary and backup failures share the hard three-request limit and cross-run attempts', async () => {
  for (const previousAttempts of [0, 2, 3]) {
    const routes = [], attempts = [];
    const client = createLlmClient({ endpoint: 'https://primary.example.com', apiKey: 'fixture-primary',
      fallbackEndpoint: 'https://backup.example.com', fallbackApiKey: 'fixture-backup', retryDelays: [0, 0, 0, 0], sleep: async () => {},
      ledger: { attempts: { editor: Array.from({ length: previousAttempts }, () => ({})) },
        recordAttempt: async (label, event) => attempts.push(event.attempt), recordOutcome: async () => {}, recordDelay: async () => {} },
      fetchImpl: async url => { routes.push(url); return new Response('origin timed out', { status: 522 }); } });
    await assert.rejects(client.call('s', 'u', { label: 'editor' }), /522|stage request budget exhausted/);
    assert.equal(routes.length, 3 - previousAttempts);
    assert.deepEqual(attempts, Array.from({ length: 3 - previousAttempts }, (_, i) => previousAttempts + i + 1));
    assert.deepEqual(routes, ['https://primary.example.com', 'https://backup.example.com', 'https://backup.example.com'].slice(0, 3 - previousAttempts));
  }
});

for (const sameOrigin of [false, true]) test(`automatic switch only skips the first backoff across origins (same origin=${sameOrigin})`, async () => {
  const delays = [], sleeps = [], outcomes = [];
  let calls = 0, switches = 0;
  const client = createLlmClient({ endpoint: 'https://primary.example.com/a', apiKey: 'fixture-primary',
    fallbackEndpoint: sameOrigin ? 'https://primary.example.com/b' : 'https://backup.example.com/b', fallbackApiKey: 'fixture-backup',
    onSwitchToBackup: async () => { switches++; throw new Error('environment file unavailable'); },
    ledger: { recordAttempt: async () => {}, recordOutcome: async (_label, event) => outcomes.push(event), recordDelay: async (_label, _id, ms) => delays.push(ms) },
    sleep: async ms => sleeps.push(ms), fetchImpl: async () => ++calls < 3 ? new Response('upstream failure', { status: 522 }) : response({ ok: true }) });
  assert.deepEqual(await client.call('s', 'u'), { ok: true });
  assert.deepEqual(delays, sameOrigin ? [15000, 45000] : [45000]);
  assert.deepEqual(sleeps, delays);
  assert.equal(switches, 1);
  assert.deepEqual(outcomes.map(event => event.route), ['primary', 'backup', 'backup']);
});

test('cross-origin switching fits in a short balance but stops at the exact deadline', async t => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  for (const [budgetMs, elapsed, sameOrigin, expectedCalls] of [[0, 0, false, 0], [30, 29, false, 2], [30, 30, false, 1], [30, 29, true, 1]]) {
    let calls = 0;
    const client = createLlmClient({ endpoint: 'https://primary.example.com/a', apiKey: 'fixture-primary',
      fallbackEndpoint: sameOrigin ? 'https://primary.example.com/b' : 'https://backup.example.com', fallbackApiKey: 'fixture-backup', budgetMs,
      onSwitchToBackup: async () => { clock += elapsed; },
      sleep: async () => assert.fail('Must not sleep'), fetchImpl: async () => ++calls === 1 ? new Response('insufficient_quota', { status: 429 }) : response({ ok: true }) });
    if (expectedCalls === 2) assert.deepEqual(await client.call('s', 'u'), { ok: true });
    else await assert.rejects(client.call('s', 'u'), /budget exhausted/);
    assert.equal(calls, expectedCalls);
  }
});

test('explicit initial backup requires only its own credentials, including when identical to primary', async () => {
  const endpoint = 'https://backup.example.com', apiKey = 'fixture-backup';
  for (const primary of [{}, { endpoint, apiKey }]) {
    const client = createLlmClient({ ...primary, initialRoute: 'backup', fallbackEndpoint: endpoint, fallbackApiKey: apiKey,
      fetchImpl: async (url, request) => {
        assert.equal(url, endpoint);
        assert.equal(request.headers.Authorization, 'Bearer ' + apiKey);
        return response({ ok: true });
      } });
    assert.deepEqual(await client.call('s', 'u'), { ok: true });
    assert.equal(client.usage[0].route, 'backup');
  }
  const incomplete = createLlmClient({ endpoint, apiKey, initialRoute: 'backup', fallbackEndpoint: endpoint });
  await assert.rejects(incomplete.call('s', 'u'), /Missing LLM endpoint or API key/);
});

test('recovered pipeline public diagnostics redact nested causes and upstream identifiers', async t => {
  const root = await sandbox(t), key = 'private-test-key'; let calls = 0;
  const client = createLlmClient({ endpoint: 'https://example.com', apiKey: key, sleep: async () => {}, fetchImpl: async (url, options) => {
    calls++;
    if (calls === 1) throw new TypeError('terminated', { cause: new Error('server echoed ' + key) });
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    const res = Array.isArray(input) ? response({ decisions: input.map(x => modelDecision(x.id)) }) : input.review_target ? response({ status: 'pass', issues: [], items: [] }) : response(writing(input.items.map(x => ({ ...x, description: x.evidence }))));
    res.headers.set('x-request-id', 'upstream-' + key); return res;
  } });
  const result = await runPipeline('daily', { root, client, env: await replayEnv(root, { items }, '2026-10-29T01:00:00Z') });
  assert.equal(calls, 4); assert.ok(!JSON.stringify(result).includes(key));
  const published = await fs.readFile(path.join(root, 'data/latest.json'), 'utf8');
  assert.ok(!published.includes(key)); assert.match(published, /REDACTED/);
});

test('full editorial correction reports short references rather than internal stable IDs', async t => {
  const root = await sandbox(t), requests = []; let editorCalls = 0;
  const client = createLlmClient({ endpoint: 'https://example.com', apiKey: 'test', sleep: async () => {}, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    const input = JSON.parse(body.messages[1].content);
    if (Array.isArray(input)) {
      editorCalls++; const decisions = input.map(x => modelDecision(x.id));
      if (editorCalls === 1) decisions[0].importance = 2.5;
      return response({ decisions });
    }
    if (input.review_target) return response({ status: 'pass', issues: [], items: [] });
    return response(writing(input.items.map(x => ({ ...x, description: x.evidence }))));
  } });
  await runPipeline('daily', { root, client, env: await replayEnv(root, { items }, '2026-10-29T01:00:00Z') });
  assert.equal(editorCalls, 2); assert.match(requests[1].messages.at(-1).content, /"id":"1"/);
  assert.ok(!items.some(x => requests[1].messages.at(-1).content.includes(x.id)));
});

test('first response wait may exceed stream idle limit without being aborted', async () => {
  const client = createLlmClient({ endpoint: 'https://example.com', apiKey: 'test', firstByteMs: 200, idleMs: 5, retryDelays: [], fetchImpl: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return response({ ok: true }); } });
  assert.deepEqual(await client.call('s', 'u'), { ok: true });
  assert.ok(client.usage[0].first_byte_ms >= 15);
});

test('idle after an SSE byte is aborted and recorded independently from first response', async () => {
  const client = createLlmClient({ endpoint: 'https://example.com', apiKey: 'test', firstByteMs: 200, idleMs: 5, retryDelays: [], fetchImpl: async (url, { signal }) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
    signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
  } }), { headers: { 'content-type': 'text/event-stream' } }) });
  await assert.rejects(client.call('s', 'u'), /stream idle timeout/);
  assert.equal(client.usage[0].usage, null); assert.notEqual(client.usage[0].first_byte_ms, null);
});

test('shared run budget aborts an active request and prevents an over-budget backoff', async () => {
  let calls = 0, sleeps = 0;
  const client = createLlmClient({ endpoint: 'https://example.com', apiKey: 'test', budgetMs: 10, firstByteMs: 200, fetchImpl: (url, { signal }) => {
    calls++; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  await assert.rejects(client.call('s', 'u'), /run time budget/);
  assert.equal(calls, 1);
  const backoff = createLlmClient({ endpoint: 'https://example.com', apiKey: 'test', budgetMs: 30, retryDelays: [100], sleep: async () => { sleeps++; }, fetchImpl: async () => new Response('overloaded', { status: 503 }) });
  await assert.rejects(backoff.call('s', 'u'), /budget exhausted before retry/);
  assert.equal(sleeps, 0);
});

test('incomplete streams never enter content repair or accept partial JSON', async () => {
  let calls = 0, repairs = 0;
  const client = createLlmClient({ endpoint: 'https://example.com', apiKey: 'test', sleep: async () => {}, fetchImpl: async () => { calls++; return response({ ok: true }, { done: false }); } });
  await assert.rejects(client.call('s', 'u', { repair: () => { repairs++; } }), /Incomplete response/);
  assert.equal(calls, 3); assert.equal(repairs, 0);
});

test('caller retry settings cannot raise the hard three-request stage limit', async () => {
  let calls = 0;
  const client = createLlmClient({ endpoint: 'https://example.com', apiKey: 'test', retryDelays: [0, 0, 0, 0], sleep: async () => {}, fetchImpl: async () => { calls++; return new Response('overloaded', { status: 503 }); } });
  await assert.rejects(client.call('s', 'u'), /503/);
  assert.equal(calls, 3);
});

test('null model JSON and null records use the bounded contract correction', async () => {
  for (const invalid of [null, { decisions: [null, null, null] }]) {
    let calls = 0;
    const client = createLlmClient({ endpoint: 'https://example.com', apiKey: 'test', sleep: async () => {}, fetchImpl: async () => {
      calls++; return response(calls === 1 ? invalid : { decisions: items.map(x => decision(x.id)) });
    } });
    const result = await client.call('s', 'u', { validate: data => validateDecisions(data, items) });
    assert.equal(calls, 2); assert.equal(result.decisions.length, 3);
  }
  assert.throws(() => validateWriting(null, items), /writing items/);
  assert.throws(() => validateWriting({ items: [null] }, items), /writing object/);
});

test('rejected metadata is canonicalized without changing selected IDs or order', () => {
  const data = { decisions: [decision(items[0].id), { id: items[1].id, keep: false, importance: 1, section: 'texas', tags: ['texas'] }, { id: items[2].id, keep: false }] };
  const before = selectItems(items, structuredClone(data.decisions)).items.map(x => x.id);
  const validated = validateDecisions(data, items);
  assert.deepEqual(selectItems(items, validated.decisions).items.map(x => x.id), before);
  assert.deepEqual(validated.decisions[1], { id: items[1].id, keep: false, importance: 1, section: null, tags: [], duplicate_of: null });
  assert.equal(validated.decisions[2].section, null);
});

test('rejected-to-rejected roots clear while retained duplicate targets stay strict', () => {
  const data = { decisions: [decision(items[0].id), { ...decision(items[1].id), keep: false }, { ...decision(items[2].id), keep: false, duplicate_of: items[1].id }] };
  assert.equal(validateDecisions(structuredClone(data), items).decisions[2].duplicate_of, null);
  data.decisions[2].duplicate_of = items[0].id;
  assert.equal(validateDecisions(structuredClone(data), items).decisions[2].duplicate_of, items[0].id);
  data.decisions[0].duplicate_of = items[1].id;
  assert.throws(() => validateDecisions(data, items), /duplicate reference/);
});

test('rejected unknown targets, self references, chains and cycles fail before normalization', () => {
  for (const references of [['missing', null, null], [items[0].id, null, null], [items[1].id, items[2].id, null], [items[1].id, items[0].id, null]]) {
    for (const reverse of [false, true]) {
      const decisions = items.map((item, index) => ({ id: item.id, keep: false, duplicate_of: references[index] }));
      if (reverse) decisions.reverse();
      assert.throws(() => validateDecisions({ decisions }, items), /duplicate reference/);
    }
  }
});

test('rejection normalization cannot forgive retained metadata, non-boolean keep or unknown IDs', () => {
  for (const override of [{ section: 'texas' }, { importance: 2.5 }, { tags: null }, { keep: 'false' }, { id: 'invented', keep: false }]) {
    const decisions = items.map(item => decision(item.id)); Object.assign(decisions[0], override);
    assert.throws(() => validateDecisions({ decisions }, items), /Invalid decision/);
  }
});

test('falsy duplicate references cannot be erased by rejection normalization', () => {
  for (const duplicate_of of [0, false, '']) {
    const decisions = items.map(item => ({ id: item.id, keep: false, duplicate_of: null }));
    decisions[0].duplicate_of = duplicate_of;
    assert.throws(() => validateDecisions({ decisions }, items), /duplicate reference/);
  }
});

test('hyphenated monetary scale matches translated amounts while different amounts still fail', () => {
  assert.deepEqual(numericValues('$475-million'), numericValues('4.75 亿美元'));
  assert.deepEqual(numericValues('$2-billion'), numericValues('20 亿美元'));
  assert.deepEqual(numericValues('-5 million'), numericValues('-500 万'));
  const source = { ...items[0], description: 'KKR announced a $475-million investment in the life sciences campus.' };
  const data = writing([source]); data.items[0].summary_zh = 'KKR 投资 4.75 亿美元。';
  data.executive_summary.sentences[0].text = '机构投资生命科学园区。';
  assert.equal(validateWriting(data, [source]).items.length, 1);
  data.items[0].summary_zh = 'KKR 投资 4.76 亿美元。';
  assert.throws(() => validateWriting(data, [source]), /number absent/);
});

test('omitted words inside an evidence quote remain invalid until an exact source quote is supplied', () => {
  const source = { ...items[0], description: 'The committee left the Federal Funds rate unchanged at its October meeting in a target range of 3.75 to 4.0 percent.' };
  const data = writing([source]); data.items[0].summary_zh = '委员会维持利率区间不变。';
  data.executive_summary.sentences[0].text = '政策利率维持不变。';
  data.items[0].evidence_quote = 'left the Federal Funds rate unchanged in a target range of 3.75 to 4.0 percent';
  assert.throws(() => validateWriting(data, [source]), /quote is not present/);
  data.items[0].evidence_quote = 'left the Federal Funds rate unchanged at its October meeting in a target range of 3.75 to 4.0 percent';
  assert.equal(validateWriting(data, [source]).items.length, 1);
});

test('writer transport recovery does not call the completed editor again', async t => {
  const root = await sandbox(t); let editors = 0, writers = 0;
  const client = createLlmClient({ endpoint: 'https://example.com', apiKey: 'test', sleep: async () => {}, fetchImpl: async (url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    if (Array.isArray(input)) { editors++; return response({ decisions: input.map(x => modelDecision(x.id)) }); }
    if (input.review_target) return response({ status: 'pass', issues: [], items: [] });
    writers++; if (writers === 1) throw new TypeError('terminated');
    return response(writing(input.items.map(x => ({ ...x, description: x.evidence }))));
  } });
  const result = await runPipeline('daily', { root, client, env: await replayEnv(root, { items }, '2026-10-29T01:00:00Z') });
  assert.equal(editors, 1); assert.equal(writers, 2); assert.equal(result.items.length, 3);
});

test('reviewer xhigh stage revises cards and summary, enforces deterministic number checks via local repair, and switches primary to backup', async t => {
  const root = await sandbox(t), requests = [];
  const env = {
    ...await replayEnv(root, { items }, '2026-10-29T01:00:00Z'),
    LLM_ENDPOINT: 'https://primary.example.com/v1/chat/completions',
    LLM_API_KEY: 'primary-secret-key',
    LLM_BACKUP_ENDPOINT: 'https://backup.example.com/v1/chat/completions',
    LLM_BACKUP_API_KEY: 'backup-secret-key'
  };
  let reviewCalls = 0;
  const result = await runPipeline('daily', {
    root,
    env,
    llmOptions: {
      retryDelays: [0, 0],
      sleep: async () => {},
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        const input = JSON.parse(body.messages[1].content);
        requests.push({ url, auth: options.headers.Authorization, model: body.model, effort: body.reasoning_effort });
        if (Array.isArray(input)) {
          return response({ decisions: input.map(x => modelDecision(x.id)) });
        }
        if (!input.review_target) {
          return response(writing(input.items.map(x => ({ ...x, description: x.evidence }))));
        }
        reviewCalls++;
        if (reviewCalls === 1) {
          // Primary fails on reviewer -> switches to backup on attempt 2
          return new Response('model_not_found on primary', { status: 503 });
        }
        if (reviewCalls === 2) {
          // Backup returns a revision with an ungrounded number 99% -> triggers deterministic repair on backup
          return response({
            status: 'revise',
            issues: [{ id: '2', field: 'summary_zh', reason: 'Impact and wording refined' }],
            items: [{ id: '2', title_zh: '住宅研究修订', summary_zh: '销售增长 99%。', impact: 'short-pos' }]
          });
        }
        // Attempt 3 on backup repairs the ungrounded number to 5%
        assert.ok(input.previous_review);
        assert.deepEqual(input.items.map(it => it.id), ['2']);
        assert.match(input.error, /number absent/);
        return response({
          status: 'revise',
          issues: [{ id: '2', field: 'summary_zh', reason: 'Impact and wording refined' }],
          items: [{ id: '2', title_zh: '住宅研究修订', summary_zh: '销售增长 5%，短期需求回暖。', impact: 'short-pos' }]
        });
      }
    }
  });
  assert.equal(requests.length, 5);
  assert.deepEqual(requests.map(r => [r.url, r.model, r.effort]), [
    ['https://primary.example.com/v1/chat/completions', 'gpt-6.2-sol', 'high'],
    ['https://primary.example.com/v1/chat/completions', 'gpt-6.2-sol', 'high'],
    ['https://primary.example.com/v1/chat/completions', 'gpt-6.2-sol', 'xhigh'],
    ['https://backup.example.com/v1/chat/completions', 'gpt-6.2-sol', 'xhigh'],
    ['https://backup.example.com/v1/chat/completions', 'gpt-6.2-sol', 'xhigh']
  ]);
  const revisedItem = result.items[1];
  assert.equal(revisedItem.title_zh, '住宅研究修订');
  assert.equal(revisedItem.summary_zh, '销售增长 5%，短期需求回暖。');
  assert.equal(revisedItem.impact, 'short-pos');
  assert.equal(result._diagnostics.review.status, 'revise');
  assert.deepEqual(result._diagnostics.review.revised_ids, [revisedItem.id]);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'state/issues/daily/2026-10-29/r1/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.attempts.reviewer.map(x => [x.attempt, x.route]), [[1, 'primary'], [2, 'backup'], [3, 'backup']]);
  assert.ok(manifest.phases.reviewer?.sha256);
});

test('staged PIPELINE_UNTIL=writer freezes before reviewer and resumes only reviewer xhigh on PIPELINE_UNTIL=ready', async t => {
  const root = await sandbox(t), stages = [];
  const env = await replayEnv(root, { items }, '2026-10-29T01:00:00Z');
  const client = {
    usage: [],
    async call(_system, user, options) {
      stages.push({ label: options.label, model: options.model, effort: options.effort });
      if (options.label === 'reviewer') {
        assert.equal(options.firstByteMs, 210_000);
        assert.equal(options.totalMs, 270_000);
        assert.equal(options.maxTokens, 24000);
      }
      if (options.label === 'editor') return options.validate({ decisions: JSON.parse(user).map(x => modelDecision(x.id)) });
      if (options.label === 'writer') {
        const input = JSON.parse(user);
        return options.validate(writing(input.items.map(x => ({ ...x, description: x.evidence }))));
      }
      if (options.label === 'reviewer') return options.validate({ status: 'pass', issues: [], items: [] });
      throw new Error('Unexpected stage: ' + options.label);
    }
  };
  const writerStep = await runPipeline('daily', { root, env: { ...env, PIPELINE_UNTIL: 'writer' }, client });
  assert.equal(writerStep.stage, 'writer');
  assert.deepEqual(stages, [
    { label: 'editor', model: 'gpt-6.2-sol', effort: 'high' },
    { label: 'writer', model: 'gpt-6.2-sol', effort: 'high' }
  ]);
  const readyStep = await runPipeline('daily', { root, env: { ...env, PIPELINE_UNTIL: 'ready' }, client });
  assert.equal(readyStep.stage, 'ready');
  assert.deepEqual(stages, [
    { label: 'editor', model: 'gpt-6.2-sol', effort: 'high' },
    { label: 'writer', model: 'gpt-6.2-sol', effort: 'high' },
    { label: 'reviewer', model: 'gpt-6.2-sol', effort: 'xhigh' }
  ]);
  const draft = {
    items: items.map(it => ({ ...it, title_zh: '住宅研究', summary_zh: '销售增长 5%。', impact: 'neutral', evidence_quote: it.description })),
    executive_summary: { sentences: [{ text: '销售增长 5%。', text_en: 'Sales rose 5%.', item_ids: [items[0].id] }] },
    themes: []
  };
  assert.throws(() => prepareReview({ status: 'unknown' }, items, draft, 'daily', { fixedEvidence: true, requireEnglish: true }), /Invalid review status/);
  assert.throws(() => prepareReview({ status: 'revise', issues: [], items: [] }, items, draft, 'daily', { fixedEvidence: true, requireEnglish: true }), /requires at least one item or metadata revision/);
  assert.throws(() => prepareReview({ status: 'revise', items: [{ id: 'unknown', title_zh: 'x', summary_zh: '销售增长 5%。', impact: 'neutral' }] }, items, draft, 'daily', { fixedEvidence: true, requireEnglish: true }), /Invalid review item reference/);
});

test('createReviewRepair sends only touched items and blocks revising undisplayed items', () => {
  const pool = Array.from({ length: 20 }, (_, i) => sample(String(i + 1), date));
  const draft = {
    items: pool.map(it => ({ ...it, title_zh: '住宅研究', summary_zh: '销售增长 5%。', impact: 'neutral', evidence_quote: it.description })),
    executive_summary: { sentences: [{ text: '销售增长 5%。', text_en: 'Sales rose 5%.', item_ids: ['1'] }] },
    themes: []
  };
  const failed = {
    status: 'revise',
    issues: [],
    items: [{ id: '3', title_zh: '住宅研究', summary_zh: '销售增长 99%。', impact: 'neutral' }],
    executive_summary: { sentences: [{ text: '销售增长 99%。', text_en: 'Sales rose 99%.', item_ids: ['2', '1'] }] }
  };
  const repair = createReviewRepair(failed, pool, draft, 'daily', x => x, { fixedEvidence: true, requireEnglish: true, issueDate: '2026-11-18' }, new LlmError('Output contains a number absent from its evidence: 99'));
  const user = JSON.parse(repair.user);
  assert.deepEqual(user.items.map(it => it.id), ['1', '2', '3']);
  assert.match(user.error, /number absent/);
  assert.deepEqual(user.previous_review, failed);
  assert.equal(user.all_item_ids.length, 20);
  assert.ok(user.upcoming_release_calendar);
  assert.throws(() => repair.validate({ status: 'revise', items: [{ id: '9', title_zh: 'x', summary_zh: '销售增长 5%。', impact: 'neutral' }] }), /Invalid review item reference/);
  const emptyRepair = createReviewRepair({ status: 'pass', items: [] }, pool, draft, 'daily', x => x, { fixedEvidence: true, requireEnglish: true, issueDate: '2026-11-18' });
  assert.equal(JSON.parse(emptyRepair.user).items.length, 0);
});

test('weekly buildReviewDraft maps evidence_id to short batch IDs that prepareReview accepts', () => {
  const long = items.map(it => ({ ...it, description: 'Housing sales rose 5% in September 2026. Inventory improved across major metros. Affordability remains a constraint for buyers.' }));
  const written = {
    items: long.map(it => ({ ...it, title_zh: '住宅研究', summary_zh: '销售增长 5%。', impact: 'neutral', evidence_quote: writingEvidenceOptions(it).find(opt => opt.id.endsWith(':body-1')).text })),
    executive_summary: { sentences: [{ text: '销售增长 5%。', text_en: 'Sales rose 5%.', item_ids: [long[0].id] }] },
    themes: [{ title: '库存改善', title_en: 'Inventory improves', item_ids: [long[1].id] }]
  };
  const batch = createModelBatch(long);
  const draft = buildReviewDraft(written, long, { fixedEvidence: false });
  const parsed = JSON.parse(reviewPrompt('weekly', batch.items, draft));
  parsed.items.forEach((it, i) => {
    assert.equal(it.draft.evidence_id, `${i + 1}:body-1`);
    assert(it.evidence_options.includes(it.draft.evidence_id));
  });
  assert.deepEqual(draft.executive_summary.sentences[0].item_ids, ['1']);
  assert.deepEqual(draft.themes[0].item_ids, ['2']);
  const reviewed = prepareReview({
    status: 'revise',
    issues: [],
    items: [{ id: '2', title_zh: '住宅研究修订', summary_zh: '销售增长 5%。', impact: 'short-pos', evidence_id: draft.items[1].evidence_id }]
  }, batch.items, draft, 'weekly', { requireEvidenceIds: true, requireEnglish: true });
  assert.deepEqual(reviewed.revised_ids, ['2']);
});

for (const legacy of [false, true]) test(`reviewer fallback warns and cold-recovers without a request or rewriting the saved review (legacy=${legacy})`, async t => {
  const root = await sandbox(t);
  const env = await replayEnv(root, { items }, '2026-10-29T01:00:00Z');
  const client = {
    usage: [],
    async call(_system, user, options) {
      if (options.label === 'editor') return options.validate({ decisions: JSON.parse(user).map(x => modelDecision(x.id)) });
      if (options.label === 'writer') {
        const input = JSON.parse(user);
        return options.validate(writing(input.items.map(x => ({ ...x, description: x.evidence }))));
      }
      if (options.label === 'reviewer') throw new LlmError('Review validation failed after repairs');
      throw new Error('Unexpected stage: ' + options.label);
    }
  };
  const warnings = t.mock.method(console, 'warn', () => {});
  const revStep = await runPipeline('daily', { root, env: { ...env, GITHUB_ACTIONS: 'true', PIPELINE_UNTIL: 'reviewer' }, client });
  assert.equal(revStep.stage, 'reviewer');
  const reviewFile = path.join(revStep.issue_dir, 'reviewer.json'), manifestFile = path.join(revStep.issue_dir, 'manifest.json');
  const savedRev = JSON.parse(await fs.readFile(reviewFile, 'utf8'));
  assert.equal(savedRev.status, 'fallback');
  assert.equal(savedRev.reason, 'review_failed');
  if (legacy) {
    savedRev.status = 'pass';
    delete savedRev.reason;
    const manifest = JSON.parse(await fs.readFile(manifestFile));
    manifest.phases.reviewer.sha256 = digest(savedRev);
    await fs.writeFile(reviewFile, JSON.stringify(savedRev));
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
  }
  const savedBytes = await fs.readFile(reviewFile, 'utf8');
  assert.equal(savedRev.fallback_reason, 'Review validation failed after repairs');
  const readyStep = await runPipeline('daily', { root, env: { ...env, GITHUB_ACTIONS: 'true', PIPELINE_UNTIL: 'ready' }, client: { call() { throw new Error('Must not call LLM on ready resume'); } } });
  assert.equal(readyStep.stage, 'ready');
  const { payload } = JSON.parse(await fs.readFile(path.join(revStep.issue_dir, 'ready.json'), 'utf8'));
  validateIssue(payload);
  assert.equal(await fs.readFile(reviewFile, 'utf8'), savedBytes);
  assert.deepEqual(warnings.mock.calls.map(call => call.arguments), Array.from({ length: 2 }, () => ['::warning::reviewer status=fallback reason=review_failed']));
  assert.equal(payload._diagnostics.review.status, 'fallback');
  assert.equal(payload._diagnostics.review.reason, 'review_failed');
  assert.equal(payload._diagnostics.review.fallback_reason, 'Review validation failed after repairs');
});

test('weekly reviewer settles three malformed HTTP 200 envelopes and keeps the frozen writer edition ready', async t => {
  const root = await sandbox(t), routes = [];
  const env = { ...await replayEnv(root, { items }, '2026-11-02T06:07:00Z'),
    LLM_ENDPOINT: 'https://primary.example.com', LLM_API_KEY: 'fixture-primary',
    LLM_BACKUP_ENDPOINT: 'https://backup.example.com', LLM_BACKUP_API_KEY: 'fixture-backup' };
  const writer = await runPipeline('weekly', { root, env: { ...env, PIPELINE_UNTIL: 'writer' }, client: fakeClient() });
  assert.equal(writer.stage, 'writer');
  const manifestFile = path.join(writer.issue_dir, 'manifest.json');
  const frozen = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  assert.equal(frozen.phases.reviewer, undefined);
  const ready = await runPipeline('weekly', {
    root, env: { ...env, PIPELINE_UNTIL: 'ready' },
    llmOptions: {
      sleep: async () => {},
      fetchImpl: async (url, request) => {
        assert.ok(JSON.parse(JSON.parse(request.body).messages[1].content).review_target);
        routes.push(url);
        return new Response('<html>Upstream proxy error</html>', { headers: { 'content-type': 'text/html' } });
      }
    }
  });
  assert.equal(ready.stage, 'ready');
  assert.deepEqual(routes, [env.LLM_ENDPOINT, env.LLM_BACKUP_ENDPOINT, env.LLM_BACKUP_ENDPOINT]);
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const attempts = manifest.attempts.reviewer;
  assert.deepEqual(attempts.map(({ attempt, route }) => [attempt, route]), [[1, 'primary'], [2, 'backup'], [3, 'backup']]);
  for (const request of attempts) {
    assert.equal(request.http_status, 200);
    assert.equal(request.failed, true);
    assert.equal(request.error, 'Malformed JSON response envelope');
    assert.ok(Number.isFinite(request.ms));
  }
  assert.equal(manifest.model_ms, (frozen.model_ms || 0) + attempts.reduce((total, request) => total + request.ms, 0));
  assert.equal(manifest.phases.cards.sha256, frozen.phases.cards.sha256);
  assert.equal(manifest.phases.metadata.sha256, frozen.phases.metadata.sha256);
  const review = JSON.parse(await fs.readFile(path.join(writer.issue_dir, 'reviewer.json'), 'utf8'));
  assert.equal(review.status, 'fallback');
  assert.equal(review.reason, 'review_failed');
  const { payload } = JSON.parse(await fs.readFile(path.join(writer.issue_dir, 'ready.json'), 'utf8'));
  validateIssue(payload);
  assert.equal(payload._diagnostics.review.status, 'fallback');
});

test('three pipeline processes inherit backup via GITHUB_ENV and preserve editor timing, a fresh job starts primary', async t => {
  const root = await sandbox(t), githubEnv = path.join(root, 'github.env');
  const env = { ...await replayEnv(root, { items }, '2026-10-29T01:00:00Z'), GITHUB_ENV: githubEnv,
    LLM_ENDPOINT: 'https://primary.example.com', LLM_API_KEY: 'fixture-primary',
    LLM_BACKUP_ENDPOINT: 'https://backup.example.com', LLM_BACKUP_API_KEY: 'fixture-backup' };
  const program = `
    import { runPipeline } from ${JSON.stringify(new URL('../lib/pipeline.mjs', import.meta.url).href)};
    import { fakeClient } from ${JSON.stringify(new URL('./helpers.mjs', import.meta.url).href)};
    const result = await runPipeline('daily', { root: process.env.FIXTURE_ROOT, llmOptions: {
      sleep: async () => { throw Error('Unexpected retry delay'); },
      fetchImpl: async (url, request) => {
        if (url === process.env.LLM_ENDPOINT && process.env.FAIL_PRIMARY === '1') return new Response('unavailable', { status: 522 });
        const payload = JSON.parse(request.body), user = payload.messages[1].content, input = JSON.parse(user);
        const label = Array.isArray(input) ? 'editor' : input.review_target ? 'reviewer' : 'writer';
        const content = await fakeClient().call(null, user, { label, validate: value => value });
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] });
      }
    } });
    console.log(JSON.stringify(result));
  `;
  const exec = promisify(execFile);
  const run = async (stage, extra = {}) => {
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', program], { env: {
      ...env, LLM_ACTIVE_ROUTE: '', FIXTURE_ROOT: root, PIPELINE_UNTIL: stage, ...extra
    } });
    return JSON.parse(stdout.trim().split('\n').at(-1));
  };
  const editor = await run('editor', { FAIL_PRIMARY: '1' });
  const manifest = async issue => JSON.parse(await fs.readFile(path.join(issue.issue_dir, 'manifest.json')));
  const oldEditor = (await manifest(editor)).phases.editor;
  const environment = await fs.readFile(githubEnv, 'utf8');
  assert.equal(environment, 'LLM_ACTIVE_ROUTE=backup\n');
  const inherited = Object.fromEntries(environment.trim().split('\n').map(line => line.split('=')));
  const writer = await run('writer', inherited);
  assert.deepEqual((await manifest(writer)).phases.editor, oldEditor);
  const ready = await run('ready', inherited);
  const frozen = await manifest(ready);
  assert.deepEqual(frozen.phases.editor, oldEditor);
  assert.deepEqual(Object.fromEntries(Object.entries(frozen.attempts).map(([stage, attempts]) => [stage, attempts.map(x => x.route)])),
    { editor: ['primary', 'backup'], writer: ['backup'], reviewer: ['backup'] });
  assert.equal(frozen.attempts.editor[0].retry_delay_ms, undefined);
  assert.equal(frozen.attempts.reviewer[0].reserved_ms, 270_000);
  const { payload } = JSON.parse(await fs.readFile(path.join(ready.issue_dir, 'ready.json')));
  assert(payload._diagnostics.timings.editor_finished_at <= payload._diagnostics.timings.writer_started_at);
  const fresh = await run('editor', { NEWS_STATE_DIR: path.join(root, 'fresh-state'), GITHUB_ENV: path.join(root, 'fresh-github.env') });
  assert.deepEqual((await manifest(fresh)).attempts.editor.map(x => x.route), ['primary']);
});
