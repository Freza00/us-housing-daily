import { createLlmClient } from './lib/llm-client.mjs';
const fallbackApiKey = process.env.LLM_BACKUP_API_KEY?.trim();
const fallbackEndpoint = process.env.LLM_BACKUP_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
const fallback = fallbackApiKey && (fallbackEndpoint !== process.env.LLM_ENDPOINT || fallbackApiKey !== process.env.LLM_API_KEY)
  ? { fallbackEndpoint, fallbackApiKey } : {};
const client = createLlmClient({ endpoint: process.env.LLM_ENDPOINT, apiKey: process.env.LLM_API_KEY, model: process.env.LLM_MODEL || 'gpt-6.2-sol', ...fallback, retryDelays: [0, 0], totalMs: 60000 });
for (const effort of ['high', 'xhigh']) {
  const result = await client.call('Return strict JSON only.', 'Return {"ok":true}.', { effort, maxTokens: 512, label: 'compatibility-probe' });
  console.log(JSON.stringify({ requested_effort: effort, result, usage: client.usage.at(-1) }));
}
