import { LlmError } from './llm-client.mjs';

export const EDITORIAL_PROTOCOL = 'evidence-refs-v2';
export const SUPPORTED_EDITORIAL_PROTOCOLS = new Set(['evidence-refs-v1', 'evidence-refs-v2']);
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

const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const abbreviation = /\b(?:Rd|St|Ave|Blvd|Dr|Ste|Inc|Corp|Ltd|Co|L\.L\.C|U\.S|vs|No)\.$/i;

function evidenceSentences(body, protocol) {
  if (protocol === 'evidence-refs-v1') return body.split(/(?<=[.!?])\s+/).filter(text => text.trim());
  const sentences = [];
  for (const { segment } of sentenceSegmenter.segment(body)) {
    const previous = sentences.at(-1);
    // ICU can split addresses and company names at abbreviations. Merge only
    // continuation tokens, retaining real sentence starts and the original text.
    const continuation = /^(?:[a-z]|\d|[,;:]|[A-Z][\w'’-]*(?:\s+(?:[A-Z][\w'’-]*|\d+))*\s+(?:Rd\.|St\.|Ave\.|Blvd\.|Dr\.|Ste\.|Inc\.|Corp\.|Ltd\.|Co\.|L\.L\.C\.))/.test(segment.trimStart());
    const namedContinuation = previous && (
      /\b(?:St|Dr|vs)\.$/i.test(previous.trimEnd()) && /^(?!(?:The|It|They|This|That|These|Those|A|An|Meanwhile|However)\b)[A-Z][a-z]/.test(segment.trimStart()) ||
      /\bU\.S\.$/i.test(previous.trimEnd()) && /^(?:Department|Census|Bureau|Securities|Treasury|Bank|Federal|Supreme|Congress|Senate|House)\b/.test(segment.trimStart()));
    if (previous && abbreviation.test(previous.trimEnd()) && (continuation || namedContinuation)) sentences[sentences.length - 1] += segment;
    else sentences.push(segment);
  }
  return sentences.map(text => text.trim()).filter(Boolean);
}

export function editorEvidenceReferences(item, protocol = item.editorial_protocol || EDITORIAL_PROTOCOL) {
  if (!SUPPORTED_EDITORIAL_PROTOCOLS.has(protocol)) throw new LlmError('Unsupported editorial protocol: ' + protocol);
  const body = String(item.description || '').slice(0, item.is_research ? 1200 : 1000);
  return [{ id: 'title', text: item.title }, ...evidenceSentences(body, protocol).map((text, index) => ({ id: 'body-' + (index + 1), text }))];
}

export function freezeEditorEvidence(item) {
  return { ...item, editorial_protocol: EDITORIAL_PROTOCOL, editor_evidence: editorEvidenceReferences(item, EDITORIAL_PROTOCOL) };
}

function headquartersAnchor(text, match, protocol) {
  // v2 keeps abbreviated addresses together. Their later city/state tokens
  // remain headquarters background, including tokens after a comma or Rd.
  const background = protocol === 'evidence-refs-v1'
    ? /\b(?:headquarter(?:s|ed)?\s+(?:in|at)|based\s+in)\s+[^.!?;,]{1,120}/gi
    : /\b(?:headquarter(?:s|ed)?\s+(?:in|at)|based\s+in)\s+[^!?;]{1,200}/gi;
  const spans = [...text.matchAll(background)].map(row => {
    const action = row[0].search(/\b(?:acquir\w*|purchas\w*|buys?|sells?|opens?|develop\w*|owns?|but|while)\b/i);
    return { start: row.index, end: row.index + (action < 0 ? row[0].length : action) };
  });
  for (const row of text.matchAll(/\b[A-Z][A-Za-z'’.-]*(?:\s+[A-Z][A-Za-z'’.-]*){0,3}-based\b/g)) spans.push({ start: row.index, end: row.index + row[0].length });
  return spans.some(span => match.index < span.end && match.index + match.text.length > span.start);
}

// Reference binding proves provenance; the editor still supplies geographical
// and event semantics. Do not turn this into a city-name classifier.
export function editorialEvidenceProblems(item, decision, protocol = item.editorial_protocol || decision.editorial_protocol || EDITORIAL_PROTOCOL) {
  const problems = [];
  const fail = (message, related_fields, extra = {}) => problems.push({ error: message + ': ' + decision.id, related_fields, ...extra });
  const references = editorEvidenceReferences(item, protocol);
  if (item.editor_evidence && JSON.stringify(item.editor_evidence) !== JSON.stringify(references)) fail('Frozen editorial evidence mismatch', []);
  if (!PRIMARY_EVENTS.includes(decision.primary_event)) fail('Invalid primary_event', ['primary_event', 'event_evidence_id', 'market_role']);
  if (!['us', 'non-us', 'unclear'].includes(decision.market_scope)) fail('Invalid market_scope', ['market_scope', 'market_evidence_id', 'market_role']);
  if (!MARKET_ROLES.includes(decision.market_role)) fail('Invalid market_role', ['primary_event', 'event_evidence_id', 'market_role']);
  const event = references.find(row => row.id === decision.event_evidence_id);
  if (!event) fail('Unknown event_evidence_id', ['primary_event', 'event_evidence_id']);
  const market = references.find(row => row.id === decision.market_evidence_id);
  if (decision.market_scope === 'us') {
    if (!market) fail('Unknown market_evidence_id', ['market_evidence_id', 'geo_evidence']);
    if (['participant_background', 'unverified'].includes(decision.market_role)) fail('US scope requires subject evidence, not background', ['market_scope', 'market_role']);
    const asset = decision.asset || decision.tags?.[0];
    if (['property_transaction_financing', 'property_development_leasing'].includes(decision.primary_event) && !['asset_location', 'headquarters_event'].includes(decision.market_role)) fail('Property event requires subject location', ['primary_event', 'event_evidence_id', 'market_role']);
    if (capitalEvents.has(decision.primary_event) && decision.market_role !== 'capital_subject') fail('Fund or platform event requires capital subject evidence', ['primary_event', 'event_evidence_id', 'market_role']);
    if (decision.market_role === 'headquarters_event' && (asset !== 'office' || decision.primary_event !== 'property_development_leasing' || !/\b(?:headquarters?|HQ)\b/i.test(market?.text || ''))) fail('Headquarters event requires office development or leasing evidence', ['asset', 'primary_event', 'market_role', 'market_evidence_id']);
    const anchor = decision.geo_evidence;
    const matches = geographyEvidenceMatches(market?.text, anchor);
    if ((anchor != null && (typeof anchor !== 'string' || anchor.length > 100 || !matches.length)) || (['asset_location', 'headquarters_event'].includes(decision.market_role) && !matches.length)) fail('Subject geography anchor must occur in selected evidence', ['market_evidence_id', 'geo_evidence'], {
      matching_evidence_ids: references.filter(row => geographyEvidenceMatches(row.text, anchor).length).map(row => row.id),
      hint: anchor == null ? '必须从选中的范围证据句截取非空连续短锚；national + asset_location 也不例外。' : '短锚必须逐字连续命中本次 market_evidence_id；不要只改短锚而保留错配编号。'
    });
    if (decision.market_role !== 'headquarters_event' && matches.length && matches.every(match => headquartersAnchor(market.text, match, protocol))) fail('Headquarters background is not subject geography', ['market_evidence_id', 'geo_evidence', 'market_role']);
    const proof = anchor || market?.text || '';
    if (/\b(?:United Kingdom|Canada|Australia|Germany|Japan|Singapore|Hong Kong)\b/i.test(proof) && !/\b(?:US|USA|United States)\b|\bU\.S\./i.test(proof)) fail('US scope contradicts the selected country', ['market_scope', 'market_evidence_id', 'geo_evidence']);
  } else if (decision.market_evidence_id != null && !market) fail('Unknown market_evidence_id', ['market_scope', 'market_evidence_id']);
  return problems;
}

export function bindEditorialEvidence(item, decision, protocol = item.editorial_protocol || decision.editorial_protocol || EDITORIAL_PROTOCOL) {
  const problems = editorialEvidenceProblems(item, decision, protocol);
  if (problems.length) throw new LlmError(problems[0].error);
  const references = editorEvidenceReferences(item, protocol);
  const event = references.find(row => row.id === decision.event_evidence_id), market = references.find(row => row.id === decision.market_evidence_id);
  return { ...decision, editorial_protocol: protocol, capital_focus: capitalEvents.has(decision.primary_event),
    event_evidence: event.text, market_evidence: market?.text || null };
}

export function assertEditorialEvidence(item, decision = item) {
  const bound = bindEditorialEvidence(item, decision);
  if (!SUPPORTED_EDITORIAL_PROTOCOLS.has(decision.editorial_protocol) || decision.editorial_protocol !== bound.editorial_protocol || decision.capital_focus !== bound.capital_focus || decision.event_evidence !== bound.event_evidence || decision.market_evidence !== bound.market_evidence) throw new LlmError('Editorial evidence binding mismatch: ' + decision.id);
  return bound;
}
