import { LlmError } from './llm-client.mjs';

export const EDITORIAL_PROTOCOL = 'evidence-refs-v1';
export const PRIMARY_EVENTS = ['property_transaction_financing', 'property_development_leasing', 'fund_platform_capital', 'institutional_allocation', 'capital_governance', 'company_operations', 'market_research_policy'];
export const MARKET_ROLES = ['asset_location', 'market_policy', 'capital_subject', 'headquarters_event', 'participant_background', 'unverified'];
const capitalEvents = new Set(['fund_platform_capital', 'institutional_allocation', 'capital_governance']);

export function geographyEvidenceMatches(source, evidence) {
  if (typeof evidence !== 'string' || !evidence.trim()) return [];
  const pattern = evidence.trim().split(/(\s+|['’‘]|["“”])/u).map(part =>
    /^\s+$/u.test(part) ? '\\s+' : /['’‘]/u.test(part) ? "['’‘]" : /["“”]/u.test(part) ? '["“”]' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ).join('');
  const text = String(source || ''), matches = [...text.matchAll(new RegExp(pattern, 'gi'))];
  const sentences = []; let start = 0;
  for (const boundary of text.matchAll(/(?<=[.!?])\s+/g)) {
    sentences.push({ start, end: boundary.index }); start = boundary.index + boundary[0].length;
  }
  sentences.push({ start, end: text.length });
  return matches.map(match => ({ text: match[0], index: match.index,
    contexts: sentences.filter(sentence => sentence.start < match.index + match[0].length && sentence.end > match.index).map(sentence => text.slice(sentence.start, sentence.end)) }));
}

export function editorEvidenceReferences(item) {
  const body = String(item.description || '').slice(0, item.is_research ? 1200 : 1000);
  return [{ id: 'title', text: item.title }, ...body.split(/(?<=[.!?])\s+/).filter(text => text.trim()).map((text, index) => ({ id: 'body-' + (index + 1), text }))];
}

export function freezeEditorEvidence(item) {
  return { ...item, editor_evidence: editorEvidenceReferences(item) };
}

function headquartersAnchor(text, match) {
  const spans = [...text.matchAll(/\b(?:headquarter(?:s|ed)?\s+(?:in|at)|based\s+in)\s+[^.!?;,]{1,120}/gi)].map(row => {
    const action = row[0].search(/\b(?:acquir\w*|purchas\w*|buys?|sells?|opens?|develop\w*|owns?|but|while)\b/i);
    return { start: row.index, end: row.index + (action < 0 ? row[0].length : action) };
  });
  for (const row of text.matchAll(/\b[A-Z][A-Za-z'’.-]*(?:\s+[A-Z][A-Za-z'’.-]*){0,3}-based\b/g)) spans.push({ start: row.index, end: row.index + row[0].length });
  return spans.some(span => match.index < span.end && match.index + match.text.length > span.start);
}

// Reference binding proves provenance; the editor still supplies geographical
// and event semantics. Do not turn this into a city-name classifier.
export function bindEditorialEvidence(item, decision) {
  const fail = message => { throw new LlmError(message + ': ' + decision.id); };
  const references = editorEvidenceReferences(item);
  if (item.editor_evidence && JSON.stringify(item.editor_evidence) !== JSON.stringify(references)) fail('Frozen editorial evidence mismatch');
  if (!PRIMARY_EVENTS.includes(decision.primary_event)) fail('Invalid primary_event');
  if (!['us', 'non-us', 'unclear'].includes(decision.market_scope)) fail('Invalid market_scope');
  if (!MARKET_ROLES.includes(decision.market_role)) fail('Invalid market_role');
  const event = references.find(row => row.id === decision.event_evidence_id);
  if (!event) fail('Unknown event_evidence_id');
  const market = references.find(row => row.id === decision.market_evidence_id);
  if (decision.market_scope === 'us') {
    if (!market) fail('Unknown market_evidence_id');
    if (['participant_background', 'unverified'].includes(decision.market_role)) fail('US scope requires subject evidence, not background');
    const asset = decision.asset || decision.tags?.[0];
    if (['property_transaction_financing', 'property_development_leasing'].includes(decision.primary_event) && !['asset_location', 'headquarters_event'].includes(decision.market_role)) fail('Property event requires subject location');
    if (capitalEvents.has(decision.primary_event) && decision.market_role !== 'capital_subject') fail('Fund or platform event requires capital subject evidence');
    if (decision.market_role === 'headquarters_event' && (asset !== 'office' || decision.primary_event !== 'property_development_leasing' || !/\b(?:headquarters?|HQ)\b/i.test(market.text))) fail('Headquarters event requires office development or leasing evidence');
    const anchor = decision.geo_evidence;
    const matches = geographyEvidenceMatches(market.text, anchor);
    if ((anchor != null && (typeof anchor !== 'string' || anchor.length > 100 || !matches.length)) || (['asset_location', 'headquarters_event'].includes(decision.market_role) && !matches.length)) fail('Subject geography anchor must occur in selected evidence');
    if (decision.market_role !== 'headquarters_event' && matches.length && matches.every(match => headquartersAnchor(market.text, match))) fail('Headquarters background is not subject geography');
    const proof = anchor || market.text;
    if (/\b(?:United Kingdom|Canada|Australia|Germany|Japan|Singapore|Hong Kong)\b/i.test(proof) && !/\b(?:US|USA|United States)\b|\bU\.S\./i.test(proof)) fail('US scope contradicts the selected country');
  } else if (decision.market_evidence_id != null && !market) fail('Unknown market_evidence_id');
  return { ...decision, editorial_protocol: EDITORIAL_PROTOCOL, capital_focus: capitalEvents.has(decision.primary_event),
    event_evidence: event.text, market_evidence: market?.text || null };
}

export function assertEditorialEvidence(item, decision = item) {
  const bound = bindEditorialEvidence(item, decision);
  if (decision.editorial_protocol !== EDITORIAL_PROTOCOL || decision.capital_focus !== bound.capital_focus || decision.event_evidence !== bound.event_evidence || decision.market_evidence !== bound.market_evidence) throw new LlmError('Editorial evidence binding mismatch: ' + decision.id);
  return bound;
}
