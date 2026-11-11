import { geographyEvidenceMatches, validateWritingMetadata } from './editorial.mjs';
import { LlmError } from './llm-client.mjs';

export const DAILY_WRITING_POLICY = 'daily-pool-v1';
export const DAILY_WRITING_LIMIT = 26;

// A foreign investor's home market does not make a US property foreign. Ask
// for evidence of the subject of the deal when the headline is ambiguous.
const foreignMarket = /\b(?:United Kingdom|U\.?K\.?|London|(?<!New )England|Canada|Toronto|Vancouver|Australia|Sydney|Europe|Paris|Germany|Japan|Singapore|Hong Kong)\b/i;
const usCountry = /\b(?:US|USA|United States)\b|\bU\.S\.(?![A-Za-z])/i;
const foreignCountry = /\b(?:United Kingdom|UK|U\.K\.|Canada|Australia|Germany|Japan|Singapore|Hong Kong)\b/i;
const headquarters = /\b(?:headquarter(?:s|ed)?|based in)\b/i;

function headquartersOverlap(source, match) {
  const spans = [...String(source).matchAll(/\b(?:headquarter(?:s|ed)?\s+(?:in|at)|based\s+in)\s+[^.!?;,]{1,120}/gi)].map(row => {
    const action = row[0].search(/\b(?:acquir\w*|purchas\w*|buys?|sells?|opens?|develop\w*|but|while)\b/i);
    return { start: row.index, end: row.index + (action < 0 ? row[0].length : action) };
  });
  for (const row of String(source).matchAll(/\b[A-Z][A-Za-z'’.-]*(?:\s+[A-Z][A-Za-z'’.-]*){0,3}-based\b/g)) spans.push({ start: row.index, end: row.index + row[0].length });
  if (spans.some(span => match.index < span.end && match.index + match.text.length > span.start)) return true;
  return !spans.length && match.contexts.some(context => headquarters.test(context));
}

export function isDailyUSStory(item, decision) {
  if (decision.market_scope !== 'us') return false;
  const evidence = decision.market_evidence;
  const ambiguous = foreignMarket.test(item.title) || foreignMarket.test(decision.geo_evidence || '');
  if (!ambiguous && evidence == null) return true;
  if (typeof evidence !== 'string' || !evidence.trim()) return false;
  // A quoted overseas location is a contradiction, not proof of a US asset.
  if (foreignCountry.test(evidence) && !usCountry.test(evidence)) return false;
  const officeOpening = /\b(?:opens?|leases?|develops?|builds?|relocates?)\b.{0,80}\bheadquarters\b/i.test(item.title);
  return [item.title, item.description].some((text, index) =>
    geographyEvidenceMatches(text, evidence).some(match => !headquartersOverlap(text, match) || index === 0 && officeOpening));
}

export function assembleDailyEdition(primary, pool, cards, metadata, { allowPartial = false } = {}) {
  const byId = new Map(cards.map(item => [item.id, item]));
  const primaryIds = new Set(primary.map(item => item.id));
  const slots = primary.map(item => byId.get(item.id));
  const reserves = pool.filter(item => !primaryIds.has(item.id) && byId.has(item.id));
  const replacements = [];
  const reserveFor = (index, predicate) => {
    const reserveIndex = reserves.findIndex(predicate);
    if (reserveIndex < 0) return;
    const [reserve] = reserves.splice(reserveIndex, 1);
    slots[index] = byId.get(reserve.id);
    replacements.push({ deferred_id: primary[index].id, published_id: reserve.id });
  };
  const deferred = primary.filter(item => !byId.has(item.id));
  if (deferred.some(item => item.importance >= 4)) return null;
  for (const match of [
    (reserve, item) => reserve.section === item.section && reserve.tags[0] === item.tags[0],
    (reserve, item) => reserve.section === item.section,
    () => true
  ]) {
    primary.forEach((item, index) => { if (!slots[index]) reserveFor(index, reserve => match(reserve, item)); });
  }
  const items = slots.filter(Boolean);
  const shortfall = primary.length - items.length;
  if (!items.length || primary.some(item => !items.some(kept => kept.section === item.section))) return null;
  if (shortfall && (!allowPartial || shortfall > 3 || items.length < Math.ceil(primary.length * 0.8))) return null;
  const ids = new Set(items.map(item => item.id));
  const sentences = metadata?.executive_summary?.sentences?.filter(row => row.item_ids.every(id => ids.has(id))) || [];
  let executiveSummary = null;
  if (sentences.length) {
    try {
      executiveSummary = validateWritingMetadata({ executive_summary: { sentences: structuredClone(sentences) }, themes: [] }, items, 'daily',
        { requireEnglish: true, fixedEvidence: true }).executive_summary;
    } catch (error) { if (!(error instanceof LlmError)) throw error; }
  }
  return {
    items,
    executive_summary: executiveSummary,
    themes: [],
    validation_notes: {
      ...(metadata?.summary_shortening ? { summary_shortening: metadata.summary_shortening } : {}),
      discarded_output_ids: []
    },
    writing: {
      planned: primary.length,
      pool_size: pool.length,
      shortfall,
      deferred: deferred.map(item => ({ id: item.id, section: item.section, reason: 'writing_unvalidated' })),
      replacements
    }
  };
}
