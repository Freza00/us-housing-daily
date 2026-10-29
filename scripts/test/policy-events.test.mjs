import test from 'node:test';
import assert from 'node:assert/strict';
import { selectItems } from '../lib/editorial.mjs';
import { policyEventKeys } from '../lib/event-groups.mjs';

const policyFixtures = {
  "official": {
    "id": "official",
    "title": "Federal Reserve issues FOMC statement",
    "link": "https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm",
    "published_at": 1793210400000,
    "description": "October 28, 2026. The Committee decided to maintain the target range for the federal funds rate at 3-3/4 to 4 percent."
  },
  "five": [
    {
      "id": "one",
      "title": "FOMC Leaves Rate Unchanged",
      "description": "October 28, 2026. The target range is 3.75 to 4.0 percent.",
      "published_at": 1793210400000,
      "link": "https://example.com/one"
    },
    {
      "id": "two",
      "title": "Fed Holds Rates, With Two Votes for Another Hike",
      "description": "October 28, 2026. The target range is 3.75% to 4%.",
      "published_at": 1793210400000,
      "link": "https://example.com/two"
    },
    {
      "id": "three",
      "title": "Fed Holds Rates Steady, But Sets Up a December Hike",
      "description": "October 28, 2026. The target range is 3.75% to 4%.",
      "published_at": 1793210400000,
      "link": "https://example.com/three"
    },
    {
      "id": "four",
      "title": "ANALYSIS: The Fed Holds Steady but the Cost of Capital Does Not",
      "description": "October 28, 2026. The benchmark rate stands at 3.75% to 4.00%.",
      "published_at": 1793210400000,
      "link": "https://example.com/four"
    },
    {
      "id": "five",
      "title": "Fed Holds Rates Amid Treasury Yield Surge",
      "description": "October 28, 2026. The target range remains 3.75% to 4%.",
      "published_at": 1793210400000,
      "link": "https://example.com/five"
    }
  ],
  "negatives": [
    {
      "id": "data",
      "title": "Mortgage applications fall after Fed holds rates",
      "description": "October 28, 2026. The target range is 3.75% to 4%.",
      "published_at": 1793210400000,
      "link": "https://example.com/data"
    },
    {
      "id": "forecast",
      "title": "Fed May Hold Rates in December",
      "description": "October 28, 2026. The target range is 3.75% to 4%.",
      "published_at": 1793210400000,
      "link": "https://example.com/forecast"
    },
    {
      "id": "nodate",
      "title": "Fed Holds Rates",
      "description": "The target range remains 3.75% to 4%.",
      "published_at": 1793210400000,
      "link": "https://example.com/nodate"
    },
    {
      "id": "otherdate",
      "title": "Fed Holds Rates",
      "description": "September 16, 2026. The target range remains 3.75% to 4%.",
      "published_at": 1793210400000,
      "link": "https://example.com/otherdate"
    },
    {
      "id": "old",
      "title": "Fed Holds Rates",
      "description": "October 28, 2026. The target range remains 3.75% to 4%.",
      "published_at": 1794744000000,
      "link": "https://example.com/old"
    }
  ],
  "separate": {
    "id": "differentresult",
    "title": "Fed Holds Rates",
    "description": "October 28, 2026. The target range is 4.0% to 4.25%.",
    "published_at": 1793210400000,
    "link": "https://example.com/differentresult"
  }
};

test('same dated FOMC result has one event key across five headlines and an official statement', () => {
  const { official, five } = policyFixtures;
  const keys = policyEventKeys([official, ...five]);
  assert.equal(keys.size, 6);
  assert.equal(new Set(keys.values()).size, 1);
});

test('independent data, forecasts, missing meeting dates and stale reports are not grouped', () => {
  const { official, five, negatives } = policyFixtures;
  const keys = policyEventKeys([official, ...five, ...negatives]);
  for (const item of negatives) assert.equal(keys.has(item.id), false, item.id);
});

test('different policy results and meetings remain separate events', () => {
  const { official, five, separate } = policyFixtures;
  const nextStatement = { ...official, id: 'next-official',
    link: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261216a.htm',
    published_at: Date.parse('2026-12-16T19:00:00Z'), description: official.description.replace('October 28', 'December 16') };
  const nextComment = { ...five[0], id: 'next-comment', published_at: nextStatement.published_at,
    description: five[0].description.replace('October 28', 'December 16') };
  const keys = policyEventKeys([official, ...five, separate, nextStatement, nextComment]);
  assert.notEqual(keys.get(separate.id), keys.get(five[0].id));
  assert.notEqual(keys.get(nextComment.id), keys.get(five[0].id));
  assert.equal(keys.get(nextComment.id), keys.get(nextStatement.id));
});

test('unverified or spoofed statement URLs cannot anchor a policy event', () => {
  const { official, five } = policyFixtures;
  assert.equal(policyEventKeys(five).size, 0);
  assert.equal(policyEventKeys([{ ...official, link: official.link.replace('federalreserve.gov', 'federalreserve.gov.example.com') }, ...five]).size, 0);
});

test('holding a conference or keeping markets guessing is not a rate decision', () => {
  const { official, five } = policyFixtures;
  const ambiguous = ['Fed keeps markets guessing on rates', 'Fed holds conference on future rates', 'Fed holds rate expectations conference']
    .map((title, index) => ({ ...five[0], id: 'ambiguous-title-' + index, title }));
  const keys = policyEventKeys([official, ...ambiguous]);
  for (const item of ambiguous) assert.equal(keys.has(item.id), false, item.title);
});

test('multiple meeting dates or different target ranges do not form an inferred event', () => {
  const { official, five } = policyFixtures;
  const ambiguous = [
    { ...five[0], id: 'two-dates', description: five[0].description + ' September 16, 2026 also had a meeting.' },
    { ...five[0], id: 'two-ranges', description: five[0].description + ' The prior target range was 3.5% to 3.75%.' },
  ];
  const keys = policyEventKeys([official, ...ambiguous]);
  for (const item of ambiguous) assert.equal(keys.has(item.id), false, item.id);
});

function choosePolicy(extraItems = [], blockedFamily = false) {
  const { official, five } = policyFixtures;
  const items = [
    { ...official, source_family: 'federal-reserve', score: 1 },
    ...five.map((item, index) => ({ ...item, source_family: blockedFamily && index === 0 ? 'blocked' : 'publisher-' + index, score: 50 - index })),
    ...extraItems,
  ];
  const decisions = items.map((item, index) => ({ id: item.id, keep: index > 0, importance: index === 1 ? 5 : 3,
    section: index < 4 ? 'national' : 'cre', tags: [], duplicate_of: null, reason: 'Fixture' }));
  return { items, decisions };
}

test('an explicit hold decision can use the official result without restating its numeric range', () => {
  const { official, five } = policyFixtures;
  const comment = { ...five[0], id: 'without-numbers', description: 'October 28th, 2026. The committee voted to hold rates steady at today’s meeting.' };
  const keys = policyEventKeys([official, comment]);
  assert.equal(keys.get(comment.id), keys.get(official.id));
});

test('weekday policy leads need a matching publication day and an authoritative meeting anchor', () => {
  const { official, five } = policyFixtures;
  const comment = { ...five[0], id: 'weekday', description: 'Officials at the Federal Reserve voted to hold the benchmark interest rate flat Wednesday.' };
  const keys = policyEventKeys([official, comment]);
  assert.equal(keys.get(comment.id), keys.get(official.id));
  assert.equal(policyEventKeys([comment]).size, 0);
  assert.equal(policyEventKeys([official, { ...comment, published_at: comment.published_at + 86400000 }]).has(comment.id), false);
  assert.equal(policyEventKeys([official, { ...comment, description: comment.description.replace('Wednesday', 'Tuesday') }]).has(comment.id), false);
});

test('one FOMC event occupies one card across sections without suppressing independent data', () => {
  const independent = { ...policyFixtures.negatives[0], source_family: 'independent', score: 10 };
  const { items, decisions } = choosePolicy([independent]);
  const result = selectItems(items, decisions);
  assert.equal(result.items.filter(item => policyFixtures.five.some(comment => comment.id === item.id)).length, 1);
  assert.ok(result.items.some(item => item.id === independent.id));
});

test('a publisher-blocked event leader does not discard an admissible event representative', () => {
  const { items, decisions } = choosePolicy([], true);
  items.unshift({ id: 'prior', title: 'Systemic event', source_family: 'blocked', score: 100 });
  decisions.unshift({ id: 'prior', keep: true, importance: 5, section: 'national', tags: [], duplicate_of: null });
  const result = selectItems(items, decisions, { sourceCap: 1 });
  assert.equal(result.items[0].id, 'prior');
  assert.ok(result.items.some(item => policyFixtures.five.slice(1).some(comment => comment.id === item.id)));
  assert.equal(result.items.filter(item => policyFixtures.five.some(comment => comment.id === item.id)).length, 1);
});
