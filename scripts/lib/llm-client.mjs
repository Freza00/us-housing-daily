import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export class LlmError extends Error {
  constructor(message, retryable = false) { super(message); this.retryable = retryable; }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export function parseJson(text) {
  const clean = String(text).trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  try { return JSON.parse(clean); } catch { throw new LlmError('Incomplete or invalid JSON response'); }
}

export function createLlmClient({ endpoint, apiKey, model = 'gpt-6.1-sol', cacheDir, fetchImpl = fetch, totalMs = 180000, idleMs = 90000, retryDelays = [1000, 4000], sleep = pause } = {}) {
  const usage = [];
  async function call(system, user, { effort = 'medium', maxTokens = 8000, label = 'llm', validate = x => x } = {}) {
    if (!endpoint || !apiKey) throw new LlmError('Missing LLM endpoint or API key');
    const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], reasoning_effort: effort,
      max_completion_tokens: maxTokens, response_format: { type: 'json_object' }, stream: true, stream_options: { include_usage: true } };
    const key = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const cacheFile = cacheDir && path.join(cacheDir, key + '.json');
    if (cacheFile) {
      try { const saved = JSON.parse(await fs.readFile(cacheFile, 'utf8')); const result = validate(saved.result, { cacheHit: true }); usage.push({ label, model, effort, cache_hit: true, response_model: saved.response_model || null, usage: saved.usage }); return result; }
      catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError) && !(e instanceof LlmError)) throw e; }
    }
    let repairs = 0;
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      const ctrl = new AbortController(); let idle;
      const started = Date.now(), total = setTimeout(() => ctrl.abort(new Error('LLM total timeout')), totalMs);
      let tokenUsage, responseModel, responseText = '', finish, done = false;
      const heartbeat = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(new Error('LLM stream idle timeout')), idleMs); };
      try {
        heartbeat();
        const res = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey }, body: JSON.stringify(body), signal: ctrl.signal });
        if (!res.ok) {
          const detail = (await res.text()).slice(0, 600);
          const permanent = /model_not_found|get_channel_failed|insufficient_quota|invalid_api_key|no available channel|无可用|無可用|可用渠道不存在/i.test(detail);
          throw new LlmError(`LLM HTTP ${res.status}: ${detail}`, !permanent && (res.status === 408 || res.status === 429 || res.status >= 500));
        }
        if (!/text\/event-stream/i.test(res.headers.get('content-type') || '')) {
          const json = await res.json(); responseText = json.choices?.[0]?.message?.content || ''; finish = json.choices?.[0]?.finish_reason; tokenUsage = json.usage; responseModel = json.model; done = true;
        } else {
          const decoder = new TextDecoder(); let buffer = '';
          stream: for await (const chunk of res.body) {
            heartbeat(); buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n'); buffer = lines.pop();
            for (const line of lines) {
              if (!line.startsWith('data:')) continue;
              const data = line.slice(5).trim();
              if (data === '[DONE]') { done = true; break stream; }
              if (!data) continue;
              let value; try { value = JSON.parse(data); } catch { throw new LlmError('Malformed SSE event', true); }
              if (value.error) throw new LlmError('LLM stream error: ' + JSON.stringify(value.error), true);
              responseText += value.choices?.[0]?.delta?.content || '';
              if (responseText.length > 2000000) throw new LlmError('Response exceeds size limit');
              finish = value.choices?.[0]?.finish_reason || finish;
              tokenUsage = value.usage || tokenUsage; responseModel = value.model || responseModel;
            }
          }
          if (buffer.trim() === 'data: [DONE]') done = true;
        }
        if (!done || finish !== 'stop' || !responseText.trim()) throw new LlmError(`Incomplete response: done=${done}, finish=${finish}`, true);
        let result;
        try { result = validate(parseJson(responseText), { cacheHit: false }); } catch (error) { if (error instanceof LlmError) error.validation = true; throw error; }
        usage.push({ label, model, effort, attempt: attempt + 1, ms: Date.now() - started, cache_hit: false, repairs, response_model: responseModel || null, usage: tokenUsage || null });
        if (cacheFile) { await fs.mkdir(cacheDir, { recursive: true }); await fs.writeFile(cacheFile, JSON.stringify({ result, response_model: responseModel || null, usage: tokenUsage || null })); }
        return result;
      } catch (error) {
        let retryable = error.retryable ?? !(error instanceof LlmError);
        if (error.validation && repairs === 0 && attempt < retryDelays.length) {
          repairs++; retryable = true;
          body.messages.push({ role: 'user', content: '上一答未通过契约校验：' + error.message + '。请只返回符合既定结构的完整严格 JSON，纠正该问题，勿增加事实、编号或解释。' });
        }
        if (error.validation && cacheDir) { await fs.mkdir(cacheDir, { recursive: true }); await fs.writeFile(path.join(cacheDir, key + '.failure.json'), JSON.stringify({ error: error.message, response: responseText })); }
        usage.push({ label, model, effort, attempt: attempt + 1, ms: Date.now() - started, failed: true, retryable, error: error.message, usage: tokenUsage || null });
        if (!retryable || attempt === retryDelays.length) throw error;
      } finally { clearTimeout(total); clearTimeout(idle); }
      await sleep(retryDelays[attempt]);
    }
  }
  return { call, usage };
}
