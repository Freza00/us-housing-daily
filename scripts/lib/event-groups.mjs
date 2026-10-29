// Conservative event grouping for reports of the same FOMC policy decision.
const POLICY_HEADLINE = /^(?:analysis\s*:\s*)?(?:the\s+)?(?:fomc|fed(?:eral reserve)?)\s+(?:holds?|leaves?|keeps?|maintains?)\s+(?:(?:(?:the|its)\s+)?(?:(?:policy|interest|benchmark|key|federal\s+funds)\s+)?rates?\b(?=\s*(?:[,;:]|$)|\s+(?:steady|unchanged|flat|put|at|amid|as|with)\b)|steady\b(?=\s*(?:[,;:]|$)|\s+(?:but|amid|as)\b))/i;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function statementDate(item) {
  const match = String(item.link || '').match(/^https:\/\/(?:www\.)?federalreserve\.gov\/newsevents\/pressreleases\/monetary(\d{4})(\d{2})(\d{2})a\.htm(?:[?#].*)?$/i);
  if (!match) return null;
  const date = match.slice(1).join('-'), timestamp = Date.parse(date + 'T00:00:00Z');
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date ? date : null;
}

function rangeValue(value) {
  const fraction = value.match(/^(\d+)[ -](\d+)\/(\d+)$/);
  return fraction ? Number(fraction[1]) + Number(fraction[2]) / Number(fraction[3]) : Number(value);
}

function policyRange(text) {
  const matches = String(text || '').matchAll(/\b(?:target\s+range|benchmark\s+(?:interest\s+)?rates?|federal\s+funds\s+rate)[^.!?]{0,120}?\b(\d+(?:[ -]\d+\/\d+|\.\d+)?)\s*(?:%|percent)?\s*(?:to|[-\u2011\u2013\u2014])\s*(\d+(?:[ -]\d+\/\d+|\.\d+)?)\s*(?:%|percent)/gi);
  const ranges = new Set();
  for (const match of matches) {
    const low = rangeValue(match[1]), high = rangeValue(match[2]);
    if (Number.isFinite(low) && Number.isFinite(high) && low <= high) ranges.add(low + ':' + high);
  }
  return ranges.size === 0 ? undefined : ranges.size === 1 ? [...ranges][0] : null;
}

function mentionsDate(text, date, published) {
  const dates = new Set(String(text).match(/\b\d{4}-\d{2}-\d{2}\b/g) || []);
  const names = MONTHS.flatMap(name => [name, name.slice(0, 3) + '\\.?']).join('|');
  const pattern = new RegExp('\\b(' + names + ')\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b', 'gi');
  for (const match of String(text).matchAll(pattern)) {
    const month = MONTHS.findIndex(name => name.slice(0, 3).toLowerCase() === match[1].slice(0, 3).toLowerCase()) + 1;
    dates.add(match[3] + '-' + String(month).padStart(2, '0') + '-' + match[2].padStart(2, '0'));
  }
  if (dates.size) return dates.size === 1 && dates.has(date);
  if (new Date(published).toISOString().slice(0, 10) !== date) return false;
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(date + 'T00:00:00Z').getUTCDay()];
  return new RegExp('\\b(?:hold|holds|held|maintain|maintained|left|kept)\\b[^.!?]{0,180}\\b(?:rates?|flat|steady|unchanged)\\b[^.!?]{0,40}\\b' + weekday + '\\b', 'i').test(String(text).slice(0, 360));
}

export function policyEventKeys(items) {
  const anchors = new Map();
  for (const item of items) {
    const date = statementDate(item), range = policyRange(item.description);
    if (date && range && /\b(?:maintain|unchanged|hold)\b/i.test(String(item.description))) anchors.set(date, range);
  }
  const dates = [...anchors.keys()];
  const keys = new Map();
  for (const item of items) {
    const official = statementDate(item);
    if (!official && !POLICY_HEADLINE.test(String(item.title || ''))) continue;
    const text = String(item.description || '');
    const range = policyRange(text);
    if (range === null) continue;
    for (const date of official ? [official] : dates) {
      const published = Number(item.published_at), midnight = Date.parse(date + 'T00:00:00Z');
      if (!Number.isFinite(published) || published < midnight || published >= midnight + 2 * 86400000) continue;
      if (!official && !mentionsDate(text, date, published)) continue;
      if (official && !/\b(?:maintain|unchanged|hold)\b/i.test(text)) continue;
      const result = range || anchors.get(date);
      if (!result) continue;
      keys.set(item.id, 'fomc:' + date + ':hold:' + result);
      break;
    }
  }
  return keys;
}
