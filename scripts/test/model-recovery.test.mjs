import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLlmClient } from '../lib/llm-client.mjs';
import { createModelBatch } from '../lib/model-references.mjs';
import { createWritingRepair, validateDecisions, validateWriting, writingPrompt, writingSystem, selectItems, numericValues } from '../lib/editorial.mjs';
import { runPipeline } from '../lib/pipeline.mjs';
import { sandbox, sample, replayEnv } from './helpers.mjs';

const date = Date.parse('2026-10-28T14:00:00Z');
const items = ['ee97eb3b7b51bf8f', '8f51e30b0b1f3098', 'third'].map(id => sample(id, date));
const decision = id => ({ id, keep: true, importance: 4, section: 'national', tags: [], duplicate_of: null });
const card = item => ({ id: item.id, title_zh: '住宅研究', summary_zh: '销售增长 5%。', impact: 'neutral', evidence_quote: item.description });
const writing = selected => ({ items: selected.map(card), executive_summary: { sentences: [{ text: '销售增长 5%，可负担性仍是约束。', item_ids: selected.map(x => x.id) }] }, themes: [] });
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

test('normal pipeline uses exactly two calls and never publishes batch references', async t => {
  const root = await sandbox(t), requests = [];
  const client = createLlmClient({ endpoint: 'https://example.com', apiKey: 'test', retryDelays: [], fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    const input = JSON.parse(body.messages[1].content);
    if (Array.isArray(input)) return response({ decisions: input.map(x => decision(x.id)) });
    return response(writing(input.items.map(x => ({ ...x, description: x.evidence }))));
  } });
  const env = await replayEnv(root, { items }, '2026-10-29T01:00:00Z');
  const result = await runPipeline('daily', { root, env, client });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(x => x.reasoning_effort), ['medium', 'low']);
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
    { ...data, items: [...data.items, { id: 'unknown' }] },
    { ...data, executive_summary: { sentences: [{ text: '销售增长 99%。', item_ids: ['1'] }] } }
  ]) assert.equal(createWritingRepair(invalid, batch.items, 'daily', validate), null);
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

test('recovered pipeline public diagnostics redact nested causes and upstream identifiers', async t => {
  const root = await sandbox(t), key = 'private-test-key'; let calls = 0;
  const client = createLlmClient({ endpoint: 'https://example.com', apiKey: key, sleep: async () => {}, fetchImpl: async (url, options) => {
    calls++;
    if (calls === 1) throw new TypeError('terminated', { cause: new Error('server echoed ' + key) });
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    const res = Array.isArray(input) ? response({ decisions: input.map(x => decision(x.id)) }) : response(writing(input.items.map(x => ({ ...x, description: x.evidence }))));
    res.headers.set('x-request-id', 'upstream-' + key); return res;
  } });
  const result = await runPipeline('daily', { root, client, env: await replayEnv(root, { items }, '2026-10-29T01:00:00Z') });
  assert.equal(calls, 3); assert.ok(!JSON.stringify(result).includes(key));
  const published = await fs.readFile(path.join(root, 'data/latest.json'), 'utf8');
  assert.ok(!published.includes(key)); assert.match(published, /REDACTED/);
});

test('full editorial correction reports short references rather than internal stable IDs', async t => {
  const root = await sandbox(t), requests = []; let editorCalls = 0;
  const client = createLlmClient({ endpoint: 'https://example.com', apiKey: 'test', sleep: async () => {}, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    const input = JSON.parse(body.messages[1].content);
    if (Array.isArray(input)) {
      editorCalls++; const decisions = input.map(x => decision(x.id));
      if (editorCalls === 1) decisions[0].importance = 2.5;
      return response({ decisions });
    }
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
    if (Array.isArray(input)) { editors++; return response({ decisions: input.map(x => decision(x.id)) }); }
    writers++; if (writers === 1) throw new TypeError('terminated');
    return response(writing(input.items.map(x => ({ ...x, description: x.evidence }))));
  } });
  const result = await runPipeline('daily', { root, client, env: await replayEnv(root, { items }, '2026-10-29T01:00:00Z') });
  assert.equal(editors, 1); assert.equal(writers, 2); assert.equal(result.items.length, 3);
});
