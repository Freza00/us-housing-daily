import { geographyEvidenceMatches, validateWritingMetadata } from './editorial.mjs';
import { LlmError } from './llm-client.mjs';

export const DAILY_WRITING_POLICY = 'daily-pool-v1';
export const DAILY_WRITING_LIMIT = 26;

// A foreign investor's home market does not make a US property foreign. Ask
// for evidence of the subject of the deal when the headline is ambiguous.
const foreignMarket = /\b(?:United Kingdom|U\.?K\.?|London|(?<!New )England|Canada|Toronto|Vancouver|Australia|Sydney|Europe|Paris|Germany|Japan|Singapore|Hong Kong)\b/i;
const domesticMarket = /\bU\.S\.(?![A-Za-z])|\b(?:United States|USA|New England|New York|Texas|Dallas|Fort Worth|Houston|Austin|California|Florida|Arizona|Illinois|Chicago|Ohio|Michigan|Massachusetts|Boston|Virginia|Maryland|Carolinas?|Charlotte|Georgia|Atlanta|Washington|Seattle|Oregon|Colorado|Denver|Nevada|Las Vegas|Pennsylvania|Philadelphia|New Jersey|Tennessee|Nashville|Wisconsin|Minnesota|Missouri|Louisiana|Utah|Indiana|Oklahoma|Kentucky|Connecticut|Kansas|Iowa|Idaho|Hawaii|Alaska)\b/i;

export function isDailyUSStory(item, decision) {
  if (decision.market_scope !== 'us') return false;
  if (!foreignMarket.test(item.title) && !foreignMarket.test(decision.geo_evidence || '')) return true;
  const evidence = decision.market_evidence;
  if (typeof evidence !== 'string' || !domesticMarket.test(evidence) || /\b(?:headquarter(?:s|ed)?|based in)\b/i.test(evidence)) return false;
  return [item.title, item.description].some(text => geographyEvidenceMatches(text, evidence).length > 0);
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
