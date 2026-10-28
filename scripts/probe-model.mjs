import { createLlmClient } from './lib/llm-client.mjs';
const client = createLlmClient({ endpoint: process.env.LLM_ENDPOINT, apiKey: process.env.LLM_API_KEY, model: process.env.LLM_MODEL, retryDelays: [], totalMs: 60000 });
for (const effort of ['low', 'medium']) {
  const result = await client.call('Return strict JSON only.', 'Return {"ok":true}.', { effort, maxTokens: 512, label: 'compatibility-probe' });
  console.log(JSON.stringify({ requested_effort: effort, result, usage: client.usage.at(-1) }));
}
