import { createHash, randomUUID } from 'node:crypto';
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

export function createLlmClient({ endpoint, apiKey, model = 'gpt-6.1-sol', cacheDir, diagnosticsDir, onEvent,
  fetchImpl = fetch, totalMs = 240000, firstByteMs = 150000, idleMs = 90000, budgetMs = 660000,
  retryDelays = [15000, 45000], sleep = pause, ledger } = {}) {
  const usage = [];
  const delays = retryDelays.slice(0, 2);
  const deadline = Date.now() + Math.max(0, budgetMs - (ledger?.spentMs || 0));
  const redact = value => apiKey ? String(value).replaceAll(apiKey, '[REDACTED]') : String(value);
  const safeEvent = event => JSON.parse(redact(JSON.stringify(event)));
  async function record(event) {
    const safe = safeEvent(event);
    if (diagnosticsDir) {
      await fs.mkdir(diagnosticsDir, { recursive: true });
      await fs.appendFile(path.join(diagnosticsDir, 'attempts.jsonl'), JSON.stringify(safe) + '\n');
    }
    onEvent?.(safe);
  }
  async function call(system, user, { effort = 'medium', maxTokens = 8000, label = 'llm', validate = x => x, repair } = {}) {
    if (!endpoint || !apiKey) throw new LlmError('Missing LLM endpoint or API key');
    const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], reasoning_effort: effort,
      max_completion_tokens: maxTokens, response_format: { type: 'json_object' }, stream: true, stream_options: { include_usage: true } };
    const key = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const cacheFile = cacheDir && path.join(cacheDir, key + '.json');
    if (cacheFile) {
      try { const saved = JSON.parse(await fs.readFile(cacheFile, 'utf8')); const result = await validate(saved.result, { cacheHit: true }); const event = safeEvent({ label, model, effort, cache_hit: true, response_model: saved.response_model || null, usage: saved.usage || null }); usage.push(event); await record({ event: 'cache_hit', ...event }); return result; }
      catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError) && !(e instanceof LlmError)) throw e; }
    }
    let repairs = 0, validateResponse = validate;
    if (ledger?.blockedStages?.includes(label)) throw new LlmError('Cross-run model budget is unknown; only validated cache or delivery recovery is allowed: ' + label);
    const previousAttempts = ledger?.attempts?.[label]?.length || 0;
    for (let attempt = previousAttempts; attempt <= delays.length; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { await record({ event: 'budget_exhausted', label, model, effort }); throw new LlmError('LLM run time budget exhausted'); }
      const ctrl = new AbortController(); let idle;
      const started = Date.now(), requestId = randomUUID();
      const total = setTimeout(() => ctrl.abort(new Error(remaining <= totalMs ? 'LLM run time budget exhausted' : 'LLM total timeout')), Math.min(totalMs, remaining));
      const first = setTimeout(() => ctrl.abort(new Error('LLM first response timeout')), firstByteMs);
      let tokenUsage, responseModel, responseText = '', finish, done = false, parsed, upstreamRequestId, responseId, firstByteAt, httpStatus;
      let outcome;
      const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      const request = { label, model, effort, attempt: attempt + 1, request_id: requestId, request_hash: requestHash, started_at: new Date(started).toISOString(), reserved_ms: Math.min(totalMs, remaining) };
      const heartbeat = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(new Error('LLM stream idle timeout')), idleMs); };
      const received = () => { if (!firstByteAt) { firstByteAt = Date.now(); clearTimeout(first); } heartbeat(); };
      const readText = async response => {
        const decoder = new TextDecoder(); let text = '';
        for await (const chunk of response.body) {
          if (chunk.length) received(); text += decoder.decode(chunk, { stream: true });
          if (text.length > 2000000) throw new LlmError('Response exceeds size limit');
        }
        return text + decoder.decode();
      };
      try {
        await ledger?.recordAttempt(label, request);
        await record({ event: 'request_started', ...request });
        const res = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey }, body: JSON.stringify(body), signal: ctrl.signal });
        httpStatus = res.status;
        upstreamRequestId = res.headers.get('x-request-id') || res.headers.get('request-id') || null;
        if (!res.ok) {
          const detail = (await readText(res)).slice(0, 600);
          const permanent = /model_not_found|get_channel_failed|insufficient_quota|invalid_api_key|no available channel|无可用|無可用|可用渠道不存在/i.test(detail);
          throw new LlmError(`LLM HTTP ${res.status}: ${detail}`, !permanent && (res.status === 408 || res.status === 429 || res.status >= 500));
        }
        if (!/text\/event-stream/i.test(res.headers.get('content-type') || '')) {
          const text = await readText(res);
          const json = JSON.parse(text); responseText = json.choices?.[0]?.message?.content || ''; finish = json.choices?.[0]?.finish_reason; tokenUsage = json.usage; responseModel = json.model; responseId = json.id; done = true;
        } else {
          const decoder = new TextDecoder(); let buffer = '';
          stream: for await (const chunk of res.body) {
            if (chunk.length) received(); buffer += decoder.decode(chunk, { stream: true });
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
              responseId = value.id || responseId;
            }
          }
          if (buffer.trim() === 'data: [DONE]') done = true;
        }
        if (!done || finish !== 'stop' || !responseText.trim()) throw new LlmError(`Incomplete response: done=${done}, finish=${finish}`, true);
        let result;
        try { parsed = parseJson(responseText); result = await validateResponse(parsed, { cacheHit: false }); } catch (error) { if (error instanceof LlmError) error.validation = true; throw error; }
        outcome = { ...request, cache_hit: false, repairs, response_model: responseModel || null };
        if (cacheFile) { await fs.mkdir(cacheDir, { recursive: true }); await fs.writeFile(cacheFile, JSON.stringify({ result, response_model: responseModel || null, usage: tokenUsage || null })); }
        return result;
      } catch (error) {
        if (ctrl.signal.aborted) error = ctrl.signal.reason;
        error.message = redact(error.message);
        let retryable = error.retryable ?? !(error instanceof LlmError);
        if (error.validation && repairs === 0 && attempt < delays.length) {
          repairs++; retryable = true;
          const correction = parsed && await repair?.(parsed, error);
          if (correction) {
            body.messages = [{ role: 'system', content: correction.system || system }, { role: 'user', content: correction.user }];
            validateResponse = correction.validate;
          } else {
            body.messages.push({ role: 'assistant', content: responseText }, { role: 'user', content: '上一答未通过契约校验：' + error.message + '。请只返回符合既定结构的完整严格 JSON，纠正该问题，勿增加事实、编号或解释。' });
          }
        }
        if (deadline <= Date.now()) retryable = false;
        if (error.validation && cacheDir) { await fs.mkdir(cacheDir, { recursive: true }); await fs.writeFile(path.join(cacheDir, key + '.failure.json'), redact(JSON.stringify({ error: error.message, response: responseText }))); }
        const causes = []; for (let cause = error.cause; cause && causes.length < 4; cause = cause.cause) causes.push({ name: cause.name, code: cause.code || null, message: cause.message });
        outcome = { ...request, failed: true, retryable, error: redact(error.message), error_name: error.name, error_code: error.code || null, causes };
        if (!retryable || attempt === delays.length) throw error;
      } finally {
        clearTimeout(total); clearTimeout(first); clearTimeout(idle);
        if (outcome) {
          const event = safeEvent({ ...outcome, ms: Date.now() - started, first_byte_ms: firstByteAt ? firstByteAt - started : null, http_status: httpStatus || null,
            upstream_request_id: upstreamRequestId || null, response_id: responseId || null,
            finish_reason: finish || null, done, usage: tokenUsage || null, response_characters: responseText.length });
          usage.push(event);
          await ledger?.recordOutcome(label, event);
          if (event.failed && diagnosticsDir && responseText) {
            event.response_file = requestId + '.response.json';
            await fs.writeFile(path.join(diagnosticsDir, event.response_file), redact(JSON.stringify({ request_id: requestId, label, error: event.error, response: responseText.slice(0, 2000000) })));
          }
          await record({ event: 'request_finished', ...event });
        }
      }
      if (deadline - Date.now() <= delays[attempt]) { await record({ event: 'budget_exhausted', label, model, effort }); throw new LlmError('LLM run time budget exhausted before retry'); }
      await ledger?.recordDelay(label, requestId, delays[attempt]);
      await sleep(delays[attempt]);
    }
    throw new LlmError('Issue stage request budget exhausted: ' + label);
  }
  return { call, usage };
}
