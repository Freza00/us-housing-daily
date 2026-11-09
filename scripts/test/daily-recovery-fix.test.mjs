import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createWritingRepair, validateWritingCard, validateWriting } from '../lib/editorial.mjs';

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
