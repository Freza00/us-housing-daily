import { LlmError } from './llm-client.mjs';

// Only the model boundary uses short references. Published IDs stay unchanged.
export function createModelBatch(items) {
  const ids = new Map(items.map((item, index) => [String(index + 1), item.id]));
  const restore = ref => {
    if (typeof ref !== 'string' || !ids.has(ref)) throw new LlmError('Unknown model reference: ' + JSON.stringify(ref));
    return ids.get(ref);
  };
  return {
    items: items.map((item, index) => ({ ...item, id: String(index + 1) })),
    decisions(data) {
      if (!Array.isArray(data?.decisions)) throw new LlmError('Missing decisions array');
      return { ...data, decisions: data.decisions.map(value => ({ ...value, id: restore(value?.id), duplicate_of: value.duplicate_of == null ? null : restore(value.duplicate_of) })) };
    },
    writing(data) {
      if (!Array.isArray(data?.items)) throw new LlmError('Missing writing items array');
      const references = values => Array.isArray(values) ? values.map(value => ({ ...value, item_ids: Array.isArray(value?.item_ids) ? value.item_ids.map(restore) : value?.item_ids })) : values;
      return { ...data, items: data.items.map(value => ({ ...value, id: restore(value?.id) })),
        executive_summary: data.executive_summary && { ...data.executive_summary, sentences: references(data.executive_summary.sentences) },
        themes: references(data.themes) };
    }
  };
}
