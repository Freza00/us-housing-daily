import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { sandbox } from './helpers.mjs';
import { createWritingRepair, validateWritingCard, validateWriting, writingSystem } from '../lib/editorial.mjs';
import { validateIssue } from '../lib/issue-contract.mjs';

const card = (id, quote, summary = '研究指出市场仍受约束。') => ({ id, title_zh: '市场研究', summary_zh: summary, impact: 'neutral', evidence_quote: quote });

test('calendar months support date prepositions and straight or curly possessives', () => {
  const evidence = [
    "with October's strong jobs report", 'with October’s strong jobs report',
    "October's stronger-than-anticipated gain", 'October’s stronger-than-anticipated gain',
    'with October employment gains', 'by October employment gains', 'before October employment gains',
    'after October employment gains', 'ahead of October employment gains'
  ];
  for (const description of evidence) {
    const source = { id: 'month', title: 'Labor market research', description };
    const result = validateWritingCard(card(source.id, description, '10 月就业报告仍强劲。'), source);
    assert.equal(result.summary_zh, '10 月就业报告仍强劲。', description);
    assert.throws(() => validateWritingCard(card(source.id, description, '就业增长 10%。'), source), /number absent.*10/, description);
  }
});

test('possessive names, surnames and parenthesized organizations never license numeric months', () => {
  for (const [monthNum, name] of [
    [5, 'May Capital'], [5, "May's Capital"], [5, 'May’s Capital'],
    [5, "May's (Capital Partners)"], [5, 'May’s (Capital Partners)'],
    [5, "Theresa May's housing policy"], [5, 'Theresa May’s housing policy'],
    [5, "Brian May's investment strategy"], [5, "May's housing policy"],
    [5, "Theresa May's jobs report"], [3, 'March Associates'], [8, 'August Partners']
  ]) {
    for (const prefix of ['', 'with ', 'by ', 'before ', 'after ', 'in ', 'ahead of ']) {
      const description = prefix + name + ' announced a housing investment strategy.';
      const source = { id: 'name', title: 'Investment manager strategy', description };
      assert.throws(() => validateWritingCard(card(source.id, description, `${monthNum} 月公布住宅投资策略。`), source), new RegExp(`number absent.*${monthNum}`), description);
    }
  }
});

test('November 9 first writer card 18 passes directly with its original numeric month', async () => {
  const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/2026-11-09-writer-card18.json', import.meta.url), 'utf8'));
  assert.match(fixture.card.summary_zh, /10 月/);
  assert.match(fixture.source.description, /with October's strong jobs report/);
  const result = validateWritingCard(fixture.card, fixture.source);
  assert.equal(result.summary_zh, fixture.card.summary_zh);
  assert.equal(result.evidence_quote, fixture.card.evidence_quote);
});

test('quote repair explains exact copying and forbids expanding a source abbreviation', () => {
  const description = 'Dallas’ office investment volume reached $3.7 billion year-to-date through September.';
  const selected = [{ id: '9', title: 'Dallas Office Market on Rise', description }, { id: '18', title: 'Housing research', description: 'Housing demand remains constrained by affordability.' }];
  const good = card('18', selected[1].description);
  const bad = card('9', description.replace('Dallas’', 'Dallas-Fort Worth’s'));
  const data = { items: [bad, good], executive_summary: { sentences: [{ text: '市场仍受约束。', item_ids: ['18'] }] }, themes: [] };
  const repair = createWritingRepair(data, selected, 'daily', answer => validateWriting(answer, selected));
  const input = JSON.parse(repair.user);
  assert.equal(input.corrections.length, 1);
  const error = input.corrections[0].error;
  assert.match(error, /^Evidence quote is not present in source for 9/);
  assert(error.endsWith('（请逐字复制 title 或 evidence 中的连续原文，不得将简称或代词改写为全称，例如原文为 Dallas’ 时不得写为 Dallas-Fort Worth’s）'));
  assert.deepEqual(input.items.map(it => it.id), ['9']);
  assert.deepEqual(input.corrections[0].previous_card, bad);
  assert.throws(() => repair.validate({ items: [bad] }), /Evidence quote is not present in source/);
  const result = repair.validate({ items: [{ ...bad, evidence_quote: description }] });
  assert.equal(result.items[0].evidence_quote, description);
  assert.equal(result.items[1].summary_zh, good.summary_zh);
  assert.deepEqual(result.executive_summary.sentences, data.executive_summary.sentences);
  const numericBad = { ...data, items: [card('9', description, '投资额达 99 亿美元。'), good] };
  const numericRepair = JSON.parse(createWritingRepair(numericBad, selected, 'daily', () => {}).user);
  assert.match(numericRepair.corrections[0].error, /number absent/);
  assert.doesNotMatch(numericRepair.corrections[0].error, /不得将简称/);
});

test('daily fallback schedule includes Beijing 09:17 and keeps the earlier slots', async () => {
  const workflow = await fs.readFile(new URL('../../.github/workflows/daily.yml', import.meta.url), 'utf8');
  assert.match(workflow, /cron: '17 21,22,23 \* \* 0-4'/);
  assert.match(workflow, /cron: '17 0,1 \* \* 1-5'/);
});

for (const [kind, crons] of [
  ['daily', ['17 21,22,23 * * 0-4', '17 0,1 * * 1-5']],
  ['weekly', ['7,27,47 6 * * 1', '17 10 * * 1', '17 2 * * 2-3', '17 6 * * 2']],
  ['monthly', ['7,27,47 7 1-3 * *', '17 2 1-5 * *', '17 7 4-5 * *']]
]) {
  const readWorkflow = () => fs.readFile(new URL(`../../.github/workflows/${kind}.yml`, import.meta.url), 'utf8');
  const step = (workflow, name) => {
    const block = workflow.split(/^      - /m).find(block => block.startsWith(`name: ${name}\n`));
    assert(block, `Missing step: ${name}`);
    return block;
  };

  test(`${kind} manual backup override defaults off while all three stages receive automatic fallback credentials`, async () => {
    const workflow = await readWorkflow();
    assert.match(workflow, /  workflow_dispatch:\n    inputs:\n      use_backup:\n        description: .*manual run only\n        type: boolean\n        default: false\n/);
    assert.equal(workflow.match(/          LLM_API_KEY:/g)?.length, 3);
    assert.equal(workflow.match(/          LLM_ENDPOINT:/g)?.length, 3);
    for (const name of ['Select frozen issue', 'Write and validate frozen issue', 'Review frozen issue']) {
      const block = step(workflow, name);
      for (const name of ['LLM_API_KEY', 'LLM_ENDPOINT', 'LLM_BACKUP_API_KEY', 'LLM_BACKUP_ENDPOINT']) {
        assert(block.includes(`          ${name}: \${{ secrets.${name} }}\n`));
      }
      assert.doesNotMatch(block, /LLM_ACTIVE_ROUTE:|inputs\.use_backup/);
    }
  });

  test(`${kind} validates backup credentials after gate and before freezing input`, async t => {
    const workflow = await readWorkflow();
    const block = step(workflow, 'Validate backup credentials');
    assert.match(workflow, /run: node scripts\/can-run\.mjs \w+\n      - name: Validate backup credentials\n/);
    assert(workflow.indexOf('name: Validate backup credentials') < workflow.indexOf('name: Freeze issue input'));
    assert.match(block, /if: steps\.gate\.outputs\.go == 'true' && github\.event_name == 'workflow_dispatch' && inputs\.use_backup\n/);
    assert.match(block, /LLM_BACKUP_API_KEY: \$\{\{ secrets\.LLM_BACKUP_API_KEY \}\}/);
    assert.doesNotMatch(block, /continue-on-error:/);
    const script = block.split('        run: |\n')[1];
    assert(script);
    const root = await sandbox(t), envFile = path.join(root, 'github.env');
    for (const value of [undefined, '', ' \t\n', 'present']) {
      await fs.writeFile(envFile, '');
      const valid = Boolean(value?.trim());
      const result = spawnSync('bash', ['-c', script], { env: { GITHUB_ENV: envFile, ...(value === undefined ? {} : { LLM_BACKUP_API_KEY: value }) }, encoding: 'utf8' });
      assert.ifError(result.error);
      assert.equal(result.status, valid ? 0 : 1);
      if (!valid) assert.match(result.stdout, /::error::LLM_BACKUP_API_KEY is required/);
      assert.equal(await fs.readFile(envFile, 'utf8'), valid ? 'LLM_ACTIVE_ROUTE=backup\n' : '');
    }
  });

  test(`${kind} sets the 21-minute deadline before checkout and keeps the 25-minute job cap`, async t => {
    const workflow = await readWorkflow();
    assert.match(workflow, /^    timeout-minutes: 25$/m);
    assert.match(workflow, /    steps:\n      - name: Set job stop deadline\n        run: [^\n]+\n      - uses: actions\/checkout@v5/);
    const root = await sandbox(t), envFile = path.join(root, 'github.env');
    const script = step(workflow, 'Set job stop deadline').match(/^        run: (.*)$/m)[1];
    const before = Math.floor(Date.now() / 1000);
    const result = spawnSync('bash', ['-c', script], { env: { GITHUB_ENV: envFile, PATH: process.env.PATH } });
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    const value = await fs.readFile(envFile, 'utf8');
    assert.match(value, /^LLM_JOB_STOP_MS=\d+\n$/);
    const stop = Number(value.split('=')[1]);
    assert(stop >= (before + 21 * 60) * 1000 && stop <= (Math.floor(Date.now() / 1000) + 21 * 60) * 1000);
  });

  test(`${kind} backup switch preserves the original cron schedule`, async () => {
    const workflow = await readWorkflow();
    assert.deepEqual([...workflow.matchAll(/^    - cron: '([^']+)'$/gm)].map(match => match[1]), crons);
    assert.match(workflow, new RegExp(`  repository_dispatch:\\n    types: \\[${kind}-build\\]`));
  });
}

test('writingSystem anchors impact to institutional real estate owners and 2026-11-09 card #6 is neutral', async () => {
  assert.match(writingSystem, /impact 判断框架：锚定美国住宅／BTR-SFR／多户及 CRE 机构资产持有者与投资人/);
  assert.match(writingSystem, /不能机械判负，更不能直接推定租金或资产价值上涨/);
  assert.match(writingSystem, /①供给：.*②成本：.*③融资与资本：.*④需求与运营：.*⑤宏观：/);
  const selected = [{ id: 'bad', title: 'Housing', description: 'Housing demand remains constrained.' }, { id: 'good', title: 'Housing', description: 'Housing supply remains stable.' }];
  const data = { items: [card('bad', 'Quote absent from source.'), card('good', selected[1].description)], executive_summary: { sentences: [{ text: '住房需求仍受约束。', item_ids: ['bad'] }] }, themes: [] };
  for (const kind of ['daily', 'weekly', 'monthly']) {
    const repair = createWritingRepair(data, selected, kind, answer => validateWriting(answer, selected, kind));
    assert(repair.system.startsWith(writingSystem));
    assert.equal(JSON.parse(repair.user).kind, kind);
    const result = repair.validate({ items: [card('bad', selected[0].description)] });
    assert.equal(result.items[0].impact, 'neutral');
  }
  // Only the fixed archive is permanent; latest and initial-data advance each issue.
  const archive = JSON.parse(await fs.readFile(new URL('../../data/2026-11-09.json', import.meta.url), 'utf8'));
  validateIssue(archive, { kind: 'daily', period: '2026-11-09', upper: archive.window.upper });
  const card6 = archive.items.find(it => it.id === '5256d67a543953a1');
  assert.equal(card6?.impact, 'neutral');
});
