import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { shouldRun, buildWindow, coverageGaps } from './calendar.mjs';
import { beijingDateStr } from './dates.mjs';
import { createCollector } from './sources.mjs';
import { sourceLower, stageCapture, mergeCheckpoints, finishCapture, stageSupplement, mergeRawItems, materialFingerprint, uniqueSourceHealth } from './collection-checkpoint.mjs';
import { createLlmClient, LlmError } from './llm-client.mjs';
import { SECTIONS, dedupe, itemId } from './news-core.mjs';
import { dailyPublicationEligibility, prepareCandidates, candidateSector, employmentReportKey, repeatedEmploymentReport, assertFreshDailyReports, editorInstructions, candidatePrompt, validateDecisions, prepareModelDecisions, createDecisionRepair, selectItems, writingSystem, dailyWritingSystem, writingPrompt, createWritingRepair, validateWriting, prepareWriting, summaryCharacterCount, validateWritingCard, prepareWritingCard, validateWritingMetadata, prepareWritingMetadata, dryDecisions } from './editorial.mjs';
import { assembleDailyEdition, isDailyUSStory, DAILY_WRITING_LIMIT, DAILY_WRITING_POLICY } from './daily-edition.mjs';
import { createModelBatch } from './model-references.mjs';
import { editorialCoverage, coverageDates } from './editorial-coverage.mjs';
import { validArchive, periodKey, validateIssue, assertExpectedIssue } from './issue-contract.mjs';
import { openIssueStore, ruleDigest, revisionSeed, readDerivedJson } from './issue-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
async function readCacheJson(file, fallback) { try { return await readJson(file, fallback); } catch (e) { if (e instanceof SyntaxError) return fallback; throw e; } }
async function writeJson(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); const temp = file + '.tmp'; await fs.writeFile(temp, JSON.stringify(value, null, 2)); await fs.rename(temp, file); }
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function runPipeline(kind = 'daily', options = {}) {
  const env = options.env || process.env, now = options.now || new Date(env.PUBLISH_NOW || Date.now());
  const calendarForce = env.FORCE_RUN === '1', force = calendarForce && !env.ISSUE_REVISION, replay = !!env.REPLAY_SNAPSHOT, dry = env.LLM_SKIP === '1';
  if (!shouldRun(kind, now, { force: calendarForce }) && !replay) return { skipped: true, reason: 'Outside Beijing working-day publishing schedule' };
  const root = options.root || ROOT, dataDir = env.NEWS_DATA_DIR || path.join(root, 'data'), stateDir = env.NEWS_STATE_DIR || path.join(root, 'state');
  if ((replay || dry || env.PUBLISH_NOW) && ((!env.NEWS_DATA_DIR && !env.DIGEST_OUT_DIR) || !env.NEWS_STATE_DIR)) throw new Error('Replay, dry run and historical publish times require isolated output and state directories');
  const outDir = env.DIGEST_OUT_DIR || (kind === 'daily' ? dataDir : path.join(dataDir, kind));
  const latest = await readDerivedJson(path.join(outDir, 'latest.json'), null);
  const watermark = await readJson(path.join(stateDir, 'publication-watermark.json'), {});
  const checkpointFile = path.join(stateDir, 'collection-checkpoint.json');
  const checkpointCache = path.join(stateDir,'collection-cache.json');
  let checkpoint = mergeCheckpoints(await readJson(checkpointFile,{}),await readCacheJson(checkpointCache,{}));
  const saveCheckpoint = async value => {
    await writeJson(checkpointCache,value);
    const {last_capture,...durable}=value;
    await writeJson(checkpointFile,durable);
  };
  const legacyUpper = watermark.daily_upper ?? latest?.window?.upper ?? latest?.generated_at;
  const cutoff = Date.parse(beijingDateStr(now.getTime()) + 'T05:00:00+08:00');
  const previousCapture = checkpoint.daily_upper ?? (Number.isFinite(legacyUpper) && legacyUpper <= cutoff ? legacyUpper : null);
  let window = buildWindow(kind, now, kind === 'daily' && !replay ? previousCapture : null);
  const label = kind === 'daily' ? window.date : kind === 'weekly' ? window.periodStart : window.label;
  assertExpectedIssue(kind, window, env);
  const existing = await readJson(path.join(outDir, label + '.json'), null);
  if (!force && !replay && (!env.ISSUE_REVISION || Number(env.ISSUE_REVISION) <= (existing?.edition?.revision || 0)) && validArchive(existing, { kind, upper: window.upper, period: label })) return { skipped: true, reason: 'Validated issue already exists; delivery can be verified without generation', delivery_pending: true, kind, period: label };
  const sources = JSON.parse(await fs.readFile(path.join(root, 'config/sources.json'), 'utf8')).sources;
  const tagConfig = await readJson(path.join(root, 'config/tags.json'), null);
  const until = env.PIPELINE_UNTIL;
  if (until && !['prepared', 'editor', 'ready'].includes(until)) throw new Error('Invalid pipeline stage');
  const model = env.LLM_MODEL || 'gpt-6.1-sol';
  const store = !dry && await openIssueStore(stateDir, { kind, period: periodKey(kind, window), upper: window.upper, revision: env.ISSUE_REVISION || undefined, force, publishedRevision: existing?.edition?.revision || 0, allocationSeed: force ? revisionSeed(env) : 0, rules: fingerprint([await ruleDigest(), sources, tagConfig]), model });
  if (store && !force && env.ISSUE_BUDGET_UNKNOWN) store.manifest.budget_unknown = [...new Set([...(store.manifest.budget_unknown || []), ...env.ISSUE_BUDGET_UNKNOWN.split(',')])];
  const boundary = async stage => {
    if (store) await options.onCheckpoint?.(stage, store);
    return { checkpointed: true, stage, identity: store?.identity, issue_dir: store?.dir };
  };
  const ready = store && await store.get('ready');
  if (ready) {
    validateIssue(ready.payload, { kind, upper: window.upper, period: label });
    if (until) return boundary('ready');
    return materializeIssue(ready, { root, outDir, dataDir, stateDir, env, now, dry, replay });
  }
  const frozen = store && await store.get('prepared');
  const base = frozen?.base || { archive_sha256: existing ? fingerprint(existing) : null, latest_sha256: latest ? fingerprint(latest) : null, producer_commit: env.GITHUB_SHA || null };
  const dailyPool = kind === 'daily' && !dry;
  const editorSystem = editorInstructions(tagConfig, { usOnly: dailyPool });
  const writingContext = { requireEnglish: true, requireEvidenceIds: !dailyPool, fixedEvidence: dailyPool };
  const decisionContext = { scriptRouting: true, requireMarketScope: dailyPool };
  const rawSeen = await readJson(path.join(stateDir, 'seen.json'), []);
  let seen = (Array.isArray(rawSeen) ? rawSeen : []).filter(x => x.shown_date !== window.date);
  let allItems = [], health = [], snapshots = [], inputProvenance = 'live', collector;
  let normalized, eligibility, prepared, candidates, snapshot;
  let collectionFinishedAt = frozen?.collection_finished_at || Date.now();
  if (frozen) {
    snapshot = frozen.snapshot; window = snapshot.window; candidates = snapshot.items; seen = snapshot.initial_seen;
    health = snapshot.source_health; snapshots = snapshot.coverage_snapshots;
    inputProvenance = snapshot.provenance; normalized = frozen.normalized;
    eligibility = { excluded: snapshot.publication_exclusions || [] }; prepared = { eligible_count: frozen.eligible_count };
    checkpoint = mergeCheckpoints(checkpoint, frozen.checkpoint || {});
    if (!dry && !replay) await saveCheckpoint(checkpoint);
  } else {
  if (replay) {
    const saved = await readJson(env.REPLAY_SNAPSHOT, null);
    if (!saved || !Array.isArray(saved.items)) throw new Error('Invalid replay snapshot');
    allItems = saved.items; health = saved.source_health || []; inputProvenance = saved.provenance || 'snapshot';
    seen = saved.initial_seen || seen;
    snapshots = saved.coverage_snapshots || (saved.window ? [saved] : []);
  } else {
    if (kind !== 'daily') {
      if (checkpoint.pending?.window?.lower < window.upper && checkpoint.pending.window.upper > window.lower) { snapshots.push(checkpoint.pending); allItems.push(...checkpoint.pending.items); }
      const snapshotDir = path.join(stateDir, 'snapshots');
      for (const name of await fs.readdir(snapshotDir).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e))) {
        if (!name.endsWith('.json')) continue;
        const saved = await readJson(path.join(snapshotDir, name), null);
        if (saved?.window?.lower < window.upper && saved.window.upper > window.lower) { snapshots.push(saved); allItems.push(...saved.items); }
      }
      // Legacy daily selections are supplementary evidence, never full acquisition coverage.
      for (const name of await fs.readdir(dataDir)) {
        if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
        const saved = await readJson(path.join(dataDir, name), null);
        allItems.push(...(saved?.items || []));
      }
    }
    const cache = await readCacheJson(path.join(stateDir, 'source-cache.json'), {});
    const lowerBySource = kind === 'daily' ? Object.fromEntries(sources.map(s => [s.id,sourceLower(checkpoint,s.id,window.lower)])) : {};
    collector = options.collector || createCollector({ cache, sources, now: now.getTime(), upper: window.upper, lower: window.lower, lowerBySource });
    const toCollect = kind === 'daily' ? sources.filter(s => sourceLower(checkpoint,s.id,window.lower) < window.upper) : sources;
    const collected = await collector.collect(toCollect);
    if (kind === 'daily') {
      const prior = await readJson(path.join(stateDir,'snapshots',label+'.json'),null) || (checkpoint.last_capture?.window.upper === window.upper ? checkpoint.last_capture : null);
      const staged = stageCapture(checkpoint,sources,collected,window,prior,now.getTime());
      checkpoint = staged.checkpoint; window = staged.capture.window;
      allItems.push(...staged.capture.items); health = staged.capture.source_health; snapshots.push(staged.capture);
      await writeJson(path.join(stateDir,'snapshots',label+'.json'),staged.capture);
      if (!dry) await saveCheckpoint(checkpoint);
    } else {
      checkpoint = stageSupplement(checkpoint,sources,collected,window,now.getTime());
      if (!dry) await saveCheckpoint(checkpoint);
      allItems.push(...collected.flatMap(x=>x.items)); health=collected.map(x=>x.health);
      const observed = health.some(h=>h.required) && health.filter(h=>h.required).every(h=>h.status==='ok' && h.coverage?.lower<=window.lower && h.coverage?.upper>=window.upper);
      snapshots.push({schema_version:3,provenance:'live',coverage_status:observed?'observed':'unverified',generated_at:now.getTime(),window,items:dedupe(allItems).filter(it=>it.published_at>=window.lower&&it.published_at<window.upper),source_health:health});
    }
    await writeJson(path.join(stateDir,'source-cache.json'),collector.cache);
  }
  normalized = allItems.map(it => ({ ...it, id: it.id || itemId(it), source_family: it.source_family || sources.find(s => s.id === it.source_id)?.family || it.source_id, ...(kind === 'daily' && it.published_at < window.lower ? { late_discovery: true } : {}) }));
  const legacySnapshots = [];
  if (kind === 'daily' && normalized.some(it => it.published_at < window.lower && !Object.hasOwn(it, 'acquisition_window'))) {
    const snapshotDir = path.join(stateDir, 'snapshots');
    for (const name of await fs.readdir(snapshotDir).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e))) {
      if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
      const saved = await readJson(path.join(snapshotDir, name), null);
      if (saved?.provenance === 'live' && saved.window?.upper <= window.upper) legacySnapshots.push(saved);
    }
  }
  eligibility = kind === 'daily' ? dailyPublicationEligibility(normalized, window, legacySnapshots, { deferEvidence: true }) : { eligible: normalized, excluded: [] };
  const candidateWindow = kind === 'daily' ? { ...window, lower: eligibility.eligible.reduce((n,it)=>Math.min(n,it.published_at),window.lower) } : window;
  prepared = prepareCandidates(eligibility.eligible, candidateWindow, kind === 'daily' ? seen : [], 72, { sectorOpportunities: kind === 'daily' });
  candidates = [];
  let attempted = 0;
  const sectorCounts = {};
  if (kind === 'daily') for (const [bucket, available] of Object.entries(prepared.sector_counts)) {
    sectorCounts[bucket] = { available, attempted: 0, accepted: 0 };
  }
  while (attempted < prepared.candidates.length && attempted < prepared.limit && candidates.length < prepared.limit) {
    const slots = attempted === 0 ? prepared.initial_count : prepared.limit - candidates.length;
    const batch = prepared.candidates.slice(attempted, attempted + Math.min(slots, prepared.limit - attempted));
    attempted += batch.length;
    if (kind === 'daily') for (const item of batch) sectorCounts[candidateSector(item)].attempted++;
    const enriched = collector ? await collector.enrich(batch) : batch;
    if (kind === 'daily') {
      const checked = dailyPublicationEligibility(enriched, window);
      const originalSectors = new Map(batch.map(item => [item.id, candidateSector(item)]));
      for (const item of checked.eligible) sectorCounts[originalSectors.get(item.id)].accepted++;
      candidates.push(...checked.eligible); eligibility.excluded.push(...checked.excluded);
    } else candidates.push(...enriched);
  }
  const candidatePreparation = { limit: prepared.limit, initial_count: prepared.initial_count, attempted, accepted: candidates.length, rejected: attempted - candidates.length,
    ...(kind === 'daily' ? { sectors: sectorCounts } : {}) };
  if (collector) await writeJson(path.join(stateDir, 'source-cache.json'), collector.cache);
  if (!candidates.length) throw new Error('No eligible dated candidates; refusing to replace last successful issue');
  const recentCoverage = [];
  if (kind === 'daily') for (const date of coverageDates(label).slice(1)) {
    const issue = await readJson(path.join(dataDir, date + '.json'), null);
    if (issue?.date === date && Array.isArray(issue.items)) for (const item of issue.items) {
      const reportKey = employmentReportKey(item);
      recentCoverage.push({ date, id: item.id, title: item.title, published_at: item.published_at, summary_zh: String(item.summary_zh || '').slice(0, 160),
        ...(reportKey ? { report_key: reportKey, report_evidence: String(item.description || '').slice(0, 1800) } : {}) });
    }
  }
  snapshot = { schema_version: 2, provenance: inputProvenance, generated_at: now.getTime(), kind, window, items: candidates, candidate_preparation: candidatePreparation,
    ...(kind === 'daily' ? { recent_coverage: recentCoverage.slice(0, 80) } : {}),
    initial_seen: seen, source_health: health, publication_exclusions: eligibility.excluded, coverage_snapshots: snapshots.map(s => ({ window: s.window, coverage_status: s.coverage_status || 'unverified', source_health: uniqueSourceHealth(s.source_health || []) })), pipeline_version: '3.0' };
  await writeJson(path.join(stateDir, 'inputs', kind + '-' + label + '.json'), snapshot);
  collectionFinishedAt = Date.now();
  if (store) await store.put('prepared', { snapshot, normalized, checkpoint, base, eligible_count: prepared.eligible_count, collection_finished_at: collectionFinishedAt });
  }
  if (until === 'prepared') return boundary('prepared');
  await options.onCheckpoint?.('prepared', store);
  const targetDeadline = Number(env.PUBLICATION_DEADLINE_MS);
  const spentMs = store ? Object.values(store.manifest.attempts).flat().reduce((sum, event) => sum + (event.ms ?? event.reserved_ms ?? 240000) + (event.retry_delay_ms || 0), 0) : 0;
  const remainingBeforeReserve = targetDeadline - Date.now() - 180000;
  const budgetMs = remainingBeforeReserve > 0 ? Math.min(660000, remainingBeforeReserve + spentMs) : 660000;
  const client = options.client || createLlmClient({ ...options.llmOptions, endpoint: env.LLM_ENDPOINT, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL || 'gpt-6.1-sol', budgetMs, cacheDir: path.join(stateDir, 'llm-cache'),
    diagnosticsDir: path.join(stateDir, 'llm-diagnostics'), onEvent: event => console.log('LLM ' + JSON.stringify(event)), ledger: store && { attempts: store.manifest.attempts, spentMs, blockedStages: store.manifest.budget_unknown || [], recordAttempt: store.recordAttempt, recordOutcome: store.recordOutcome, recordDelay: store.recordDelay } });
  const editorBatch = createModelBatch(candidates);
  let decisions = store && await store.get('editor');
  if (dry) decisions = dryDecisions(candidates);
  else if (decisions) decisions = validateDecisions({ decisions }, candidates, tagConfig, decisionContext).decisions;
  else {
    let completeDecisions;
    const validate = (data, context = {}) => {
      if (!context.cacheHit) completeDecisions = structuredClone(data);
      const mapped = context.cacheHit ? data : editorBatch.decisions(validateDecisions(prepareModelDecisions(data, editorBatch.items, tagConfig), editorBatch.items, tagConfig, decisionContext));
      return validateDecisions(mapped, candidates, tagConfig, decisionContext);
    };
    const recentCoverage = snapshot.recent_coverage?.length
      ? '\n以下是冻结的近期已刊事件台账，不是新稿。候选与已刊属于同一事件时，只有独立新增事实或实质后续行动才可 keep=true，并在 reason 明确新增；更换来源、重复声明或立场重述均不另占条数。同一统计月的通用 Jobs/Employment Report 已刊时，仅有新的就业数据才保留，并输出 novelty_evidence 为当前输入中包含新增数据的逐字原句（20至500字符），否则 keep=false。新数据必须进入成品摘要，不能仅在内部 reason 提及。\n' + JSON.stringify(snapshot.recent_coverage) : '';
    decisions = (await client.call(editorSystem + recentCoverage, candidatePrompt(editorBatch.items), { effort: 'medium', label: 'editor', maxTokens: 12000,
      validate, repair: () => completeDecisions && createDecisionRepair(completeDecisions, editorBatch.items, tagConfig, validate, decisionContext) })).decisions;
  }
  if (store) await store.put('editor', decisions);
  if (until === 'editor') return boundary('editor');
  await options.onCheckpoint?.('editor', store);
  const marketExclusions = new Set();
  const reportExclusions = [];
  if (dailyPool) writingContext.recentReports = snapshot.recent_coverage || [];
  if (dailyPool) {
    const source = new Map(candidates.map(item => [item.id, item]));
    decisions = decisions.map(row => {
      if (!row.keep) return row;
      const item = source.get(row.id);
      if (!isDailyUSStory(item, row)) {
        marketExclusions.add(row.id);
        return { ...row, keep: false };
      }
      const repeated = repeatedEmploymentReport({ ...item, novelty_evidence: row.novelty_evidence }, snapshot.recent_coverage || []);
      if (repeated) {
        reportExclusions.push(repeated);
        return { ...row, keep: false };
      }
      return row;
    });
  }
  const selection = selectItems(candidates, decisions, dailyPool ? { limit: DAILY_WRITING_LIMIT } : {});
  if (!selection.items.length) throw new Error('No stories met the editorial quality threshold');
  const primary = dailyPool ? selection.items.slice(0, 20) : selection.items;
  let written;
  if (dry) written = { items: selection.items.map(it => ({ ...it, title_zh: '', summary_zh: '(离线验证，未调用模型)', impact: 'neutral' })), themes: [], executive_summary: null };
  else {
    const writerBatch = createModelBatch(selection.items);
    const selectedDigest = fingerprint(selection.items);
    let savedCards = store && await store.get('cards'), savedMetadata = store && await store.get('metadata');
    const assemble = options => assembleDailyEdition(primary, selection.items, savedCards?.items || [], savedMetadata, options);
    if ((savedCards && savedCards.selected_digest !== selectedDigest) || (savedMetadata && savedMetadata.selected_digest !== selectedDigest)) throw new Error('Writing checkpoint selection mismatch');
    // Presence and checksums do not establish content validity. Retain only parts
    // that pass the current contract before choosing a no-request resume path.
    if (savedCards) {
      const byId = new Map(selection.items.map(it => [it.id, it]));
      if (savedCards.items.some(it => !byId.has(it?.id)) || new Set(savedCards.items.map(it => it.id)).size !== savedCards.items.length) throw new LlmError('Invalid saved writing references');
      const items = [];
      for (const card of savedCards.items) {
        try { items.push(validateWritingCard(card, byId.get(card.id), writingContext)); } catch (error) { if (!(error instanceof LlmError)) throw error; }
      }
      savedCards = { selected_digest: selectedDigest, items };
      await store.put('cards', savedCards);
    }
    if (savedMetadata) {
      try { validateWritingMetadata(structuredClone(savedMetadata), selection.items, kind, writingContext); }
      catch (error) {
        if (!(error instanceof LlmError)) throw error;
        savedMetadata = null;
      }
    }
    const persistParts = async (data, context, summaryShortening) => {
      if (!store || !Array.isArray(data?.items)) return;
      summaryShortening ||= context.summaryShortening;
      const inputs = context.cacheHit ? selection.items : writerBatch.items;
      const byId = new Map(inputs.map(it => [it.id, it]));
      if (data.items.some(it => !byId.has(it?.id)) || new Set(data.items.map(it => it.id)).size !== data.items.length) return;
      const valid = [];
      for (const card of data.items) { try { valid.push(prepareWritingCard(card, byId.get(card.id), { ...writingContext, ...context })); } catch (error) { if (!(error instanceof LlmError)) throw error; } }
      const mapped = context.cacheHit ? valid : writerBatch.writing({ items: valid }).items;
      if (mapped.length) {
        const previous = savedCards?.items || [];
        const combined = dailyPool ? [...mapped, ...previous] : [...previous, ...mapped];
        savedCards = { selected_digest: selectedDigest, items: [...new Map(combined.map(it => [it.id, it])).values()] };
        await store.put('cards', savedCards);
      }
      if (dailyPool && savedMetadata) return;
      let metadata;
      try {
        metadata = prepareWritingMetadata(structuredClone(data), inputs, kind, writingContext);
        summaryShortening ||= metadata.summary_shortening;
      } catch (error) { if (error instanceof LlmError) return; throw error; }
      if (!context.cacheHit) metadata = writerBatch.writing({ items: [], ...metadata });
      savedMetadata = { selected_digest: selectedDigest, executive_summary: metadata.executive_summary, themes: metadata.themes, ...(summaryShortening ? { summary_shortening: summaryShortening } : {}) };
      await store.put('metadata', savedMetadata);
    };
    let completeAnswer, completeContext;
    const validate = async (data, context = {}) => {
      completeAnswer = structuredClone(data);
      completeContext = context;
      if (dailyPool) {
        if (!context.cacheHit) writerBatch.writing({ items: data?.items });
        const ids = new Set((context.cacheHit ? selection.items : writerBatch.items).map(item => item.id));
        if (!Array.isArray(data?.items) || data.items.some(card => !ids.has(card?.id)) || new Set(data.items.map(card => card.id)).size !== data.items.length) throw new LlmError('Invalid daily writing references');
        await persistParts(data, context, data.validation_notes?.summary_shortening);
        if (!assemble()) {
          // Keep the original per-card diagnostic for the existing repair path.
          for (const card of data.items) prepareWritingCard(card, (context.cacheHit ? selection.items : writerBatch.items).find(it => it.id === card.id), { ...writingContext, ...context });
          throw new LlmError('Daily writing pool cannot yet fill the planned issue');
        }
        // Cache the verified pool and unprojected metadata for cold resume.
        return { items: savedCards.items, executive_summary: savedMetadata?.executive_summary ?? null, themes: savedMetadata?.themes || [],
          validation_notes: savedMetadata?.summary_shortening ? { summary_shortening: savedMetadata.summary_shortening } : {} };
      }
      let preparedWriting, result;
      try {
        if (!context.cacheHit) writerBatch.writing({ items: data.items });
        preparedWriting = prepareWriting(structuredClone(data), context.cacheHit ? selection.items : writerBatch.items, kind, { ...context, ...writingContext });
        const mapped = context.cacheHit ? preparedWriting : writerBatch.writing(preparedWriting);
        result = validateWriting(mapped, selection.items, kind, { ...context, ...writingContext });
      } catch (error) { await persistParts(data, context); throw error; }
      const summaryShortening = preparedWriting.validation_notes?.summary_shortening || (context.cacheHit && data.validation_notes?.summary_shortening) || context.summaryShortening;
      if (summaryShortening) result.validation_notes.summary_shortening = summaryShortening;
      await persistParts(result, { cacheHit: true }, summaryShortening);
      return result;
    };
    const shortIds = new Map(selection.items.map((it, i) => [it.id, String(i + 1)]));
    const shortMetadata = value => value && ({ ...value, sentences: value.sentences?.map(row => ({ ...row, item_ids: row.item_ids.map(id => shortIds.get(id)) })) });
    const saved = { items: (savedCards?.items || []).map(it => ({ ...it, id: shortIds.get(it.id) })), executive_summary: shortMetadata(savedMetadata?.executive_summary), themes: savedMetadata?.themes?.map(row => ({ ...row, item_ids: row.item_ids.map(id => shortIds.get(id)) })) };
    const canonicalIds = new Set(saved.items.map(it => it.id));
    const preassembled = dailyPool && (assemble() || (targetDeadline > Date.now() && remainingBeforeReserve <= 0 && assemble({ allowPartial: true })));
    if (preassembled) written = preassembled;
    else if (!dailyPool && savedCards?.items.length === selection.items.length && savedMetadata) written = await validate(saved, { canonicalIds, summaryShortening: savedMetadata.summary_shortening });
    else {
      const resume = saved.items.length && createWritingRepair(saved, writerBatch.items, kind, validate, { ...writingContext, canonicalIds, summaryShortening: savedMetadata?.summary_shortening });
      try {
        written = await client.call(resume?.system || (dailyPool ? dailyWritingSystem : writingSystem), resume?.user || writingPrompt(kind, writerBatch.items, writingContext),
          { effort: 'low', label: 'writer', maxTokens: 10000, validate: (data, context) => context?.cacheHit ? validate(data, context) : (resume?.validate || validate)(data, context), repair: (data, error) => /Invalid repair reference|Metadata repair cannot replace cards|Repair coverage mismatch/.test(error?.message || '') ? null : createWritingRepair(completeAnswer || data, writerBatch.items, kind, validate, { ...writingContext, ...completeContext }) });
        if (dailyPool) written = assemble();
      } catch (error) {
        if (!dailyPool || !(error instanceof LlmError || error.llmTransport)) throw error;
        written = assemble({ allowPartial: true });
        if (!written) throw error;
      }
    }
  }
  const { validation_notes: validationNotes, writing: writingPlan, ...publicWritten } = written;
  const history = [];
  if (kind === 'daily') for (const date of coverageDates(label).slice(1)) {
    const issue = await readJson(path.join(dataDir, date + '.json'), null);
    if (issue?.date === date && Array.isArray(issue.items)) history.push(issue);
  }
  const editorialAudit = editorialCoverage({ candidates, decisions, selected: written.items, health, sources, tagConfig, date: beijingDateStr(now.getTime()), history });
  const gaps = coverageGaps(snapshots, window);
  const requiredProblems = health.filter(s => s.required && (s.status !== 'ok' || s.undated === s.articles));
  const sectionProblems = Object.values(editorialAudit.sections).some(section => section.source_failures.length);
  const status = dry ? 'dry_run' : gaps.length || requiredProblems.length || sectionProblems ? 'degraded' : 'complete';
  const sourceCounts = Object.create(null);
  for (const item of written.items) sourceCounts[item.source_family] = (sourceCounts[item.source_family] || 0) + 1;
  const publishedIds = new Set(written.items.map(item => item.id));
  const deferredIds = new Set(writingPlan?.deferred.map(item => item.id));
  const payload = { schema_version: 2, ...(!dry ? { editorial_schema: 2 } : {}), kind, date: kind === 'daily' ? label : undefined, publish_date: beijingDateStr(now.getTime()), generated_at: (env.PUBLISH_NOW || options.now) ? now.getTime() : Date.now(),
    period_start: window.periodStart, period_end: window.periodEnd, period_label: window.label, window,
    ...(dailyPool ? { writing_policy: DAILY_WRITING_POLICY, content_target: writingPlan.planned, summary_status: publicWritten.executive_summary ? 'available' : 'unavailable' } : {}),
    publication_status: writingPlan?.shortfall ? 'degraded' : status, coverage_status: status,
    content_status: dry ? 'dry_run' : writingPlan?.shortfall ? 'partial' : 'passed', delivery_state: 'ready', edition: store?.identity,
    sections: SECTIONS, ...publicWritten, sources_attempted: health.length, sources_ok: health.filter(h => h.status === 'ok').length,
    errors: health.filter(h => h.status !== 'ok').map(h => ({ source: h.name, error: h.error || h.status })),
    _diagnostics: { timings: { cutoff: window.upper, job_started_at: now.getTime(), collection_finished_at: collectionFinishedAt, generation_finished_at: Date.now() }, collection_watermarks: kind === 'daily' ? checkpoint.source_upper || {} : undefined, writer_validation: validationNotes || null, pipeline_version: '3.0', provenance: inputProvenance, window_hours: window.hours, candidate_pool_size: candidates.length, eligible_count: prepared.eligible_count, backlog_before_window: candidates.filter(it=>it.published_at<window.lower).map(it=>it.id),
      publication_exclusions: eligibility.excluded, source_health: health, research_audit: normalized.filter(x => x.is_research && x.published_at >= window.lower && x.published_at < window.upper).map(x => ({ id: x.id, source: x.source_name, title: x.title, link: x.link,
        disposition: publishedIds.has(x.id) ? 'selected' : deferredIds.has(x.id) ? 'writing_unvalidated' : marketExclusions.has(x.id) ? 'not_verified_us' : eligibility.excluded.find(it => it.id === x.id)?.reason || (decisions.find(d => d.id === x.id)?.duplicate_of ? 'merged' : candidates.some(it => it.id === x.id) ? 'editorial_not_selected' : 'candidate_budget') })),
      ...(dailyPool ? { writing_plan: writingPlan, market_exclusions: [...marketExclusions], report_exclusions: reportExclusions } : {}),
      editorial_coverage: editorialAudit, source_counts: dailyPool ? sourceCounts : selection.source_counts,
      source_exceptions: selection.exceptions.filter(row => !dailyPool || publishedIds.has(row.id) && sourceCounts[row.family] > 3),
      coverage_gaps: gaps, required_source_problems: requiredProblems.map(x => x.id),
      llm: store && Object.values(store.manifest.attempts).flat().length ? [...Object.values(store.manifest.attempts).flat(), ...(client.usage || []).filter(event => event.cache_hit)].sort((a,b) => String(a.started_at || '').localeCompare(String(b.started_at || ''))) : client.usage, input_fingerprint: fingerprint(snapshot.items), summary_characters: summaryCharacterCount(written.executive_summary?.text || '') } };
  const bundle = { schema_version: 1, identity: store?.identity, payload, checkpoint, snapshot, base };
  if (dailyPool) assertFreshDailyReports(payload, snapshot.recent_coverage || []);
  if (store) { validateIssue(payload, { kind, upper: window.upper, period: label }); await store.put('ready', bundle); }
  if (until === 'ready') return boundary('ready');
  await options.onCheckpoint?.('ready', store);
  return materializeIssue(bundle, { root, outDir, dataDir, stateDir, env, now, dry, replay });
}

export async function materializeIssue(bundle, { root, outDir, dataDir, stateDir, env = {}, now = new Date(), dry = false, replay = false }) {
  const payload = bundle.payload, kind = payload.kind, window = payload.window;
  const label = kind === 'daily' ? payload.date : kind === 'weekly' ? payload.period_start : payload.period_label;
  const latest = await readDerivedJson(path.join(outDir, 'latest.json'), null);
  let validLatest = false; try { validateIssue(latest, { kind }); validLatest = true; } catch {}
  if (validLatest && (latest.window.upper > window.upper || (latest.window.upper === window.upper && (latest.edition?.revision || 0) > (payload.edition?.revision || 0)))) throw new Error('A newer issue is already published');
  if (!dry) validateIssue(payload, { kind, upper: window.upper, period: label });
  await writeJson(path.join(outDir, label + '.json'), payload);
  const datesFile = path.join(outDir, 'dates.json');
  let dates = await readDerivedJson(datesFile, null);
  if (!Array.isArray(dates)) dates = (await fs.readdir(outDir)).filter(name => /^\d{4}-\d{2}(?:-\d{2})?\.json$/.test(name)).map(name => name.slice(0,-5));
  if (!dates.includes(label)) dates.push(label);
  await writeJson(datesFile, dates.sort().slice(kind === 'daily' ? -180 : -36));
  if (kind === 'daily' && !dry && !replay) {
    const currentSeen = await readJson(path.join(stateDir, 'seen.json'), []);
    await writeJson(path.join(stateDir, 'seen.json'), [...currentSeen.filter(it => it.shown_date !== label), ...payload.items.map(it => ({ id: it.id, link: it.link, title: it.title, shown_date: label, shown_at: payload.generated_at }))]);
    if (!env.NEWS_DATA_DIR && !env.DIGEST_OUT_DIR && !env.PUBLISH_NOW) {
    const indexPath = path.join(root, 'public/index.html');
    const html = await fs.readFile(indexPath, 'utf8');
    await fs.writeFile(indexPath, html.replace(/(<script id="initial-data" type="application\/json">)[\s\S]*?(<\/script>)/, () => '<script id="initial-data" type="application/json">' + JSON.stringify(payload).replace(/</g, '\\u003c') + '</script>'));
    }
  }
  await writeJson(path.join(outDir, 'latest.json'), payload);
  if (kind === 'daily' && !dry && !replay) {
    const watermark = await readJson(path.join(stateDir,'publication-watermark.json'),{});
    await writeJson(path.join(stateDir,'publication-watermark.json'),{...watermark,daily_upper:Math.max(watermark.daily_upper || 0,window.upper)});
    const checkpoint = mergeCheckpoints(await readJson(path.join(stateDir, 'collection-checkpoint.json'), {}), bundle.checkpoint || {});
    const finished = finishCapture(checkpoint, window.upper);
    const consumed = new Set((bundle.checkpoint?.last_capture?.items || bundle.checkpoint?.pending?.items || []).filter(it => it.published_at < window.upper).map(materialFingerprint));
    const retained = checkpoint.pending?.items.filter(it => it.published_at >= window.upper || !consumed.has(materialFingerprint(it))) || [];
    finished.pending = retained.length ? {...checkpoint.pending,items:retained} : null;
    const { last_capture, ...durable } = finished;
    await writeJson(path.join(stateDir, 'collection-checkpoint.json'), durable);
    await writeJson(path.join(stateDir, 'collection-cache.json'), finished);
  } else if (!dry && !replay && bundle.checkpoint) {
    const merged = mergeCheckpoints(await readJson(path.join(stateDir, 'collection-checkpoint.json'), {}), bundle.checkpoint);
    const { last_capture, ...durable } = merged;
    await writeJson(path.join(stateDir, 'collection-checkpoint.json'), durable);
    await writeJson(path.join(stateDir, 'collection-cache.json'), merged);
  }
  if (!dry && !replay && bundle.snapshot) {
    const snapshot={...bundle.snapshot};
    if(Array.isArray(snapshot.coverage_snapshots))snapshot.coverage_snapshots=snapshot.coverage_snapshots.map(s=>({...s,source_health:uniqueSourceHealth(s.source_health||[])}));
    await writeJson(path.join(stateDir, 'inputs', kind + '-' + label + '.json'), snapshot);
    const capture = bundle.checkpoint?.last_capture;
    if (kind === 'daily' && capture?.cutoff_upper === window.upper) {
      const file = path.join(stateDir, 'snapshots', label + '.json'), current = await readJson(file, null);
      const lower = Math.min(capture.window.lower,current?.window?.lower??capture.window.lower);
      const sourceHealth = new Map((capture.source_health || []).map(it => [it.id,it]));
      for (const row of current?.source_health || []) if ((row.checked_at || 0) >= (sourceHealth.get(row.id)?.checked_at || 0)) sourceHealth.set(row.id,row);
      await writeJson(file, { ...capture, generated_at: Math.max(capture.generated_at || 0,current?.generated_at || 0), coverage_status: current && current.coverage_status !== 'observed' ? 'unverified' : capture.coverage_status, window: {...capture.window,lower,hours:(capture.window.upper-lower)/3600000}, source_health: [...sourceHealth.values()], items: mergeRawItems([...(current?.items || []), ...capture.items.filter(it => it.published_at < window.upper)]) });
    }
  }
  return payload;
}

export async function cli(kind) {
  try {
    const result = await runPipeline(kind);
    if (process.env.GITHUB_OUTPUT && result.checkpointed) await fs.appendFile(process.env.GITHUB_OUTPUT, 'issue_dir=' + path.relative(ROOT, result.issue_dir) + '\nrevision=' + result.identity.revision + '\nperiod=' + result.identity.period_key + '\ncutoff=' + result.identity.cutoff_upper + '\n');
    console.log(JSON.stringify(result.skipped || result.checkpointed ? result : { kind, status: result.publication_status, items: result.items.length, date: result.date || result.period_start, llm: result._diagnostics.llm }, null, 2));
  }
  catch (e) { console.error('FATAL:', e.stack || e.message); process.exitCode = 1; }
}
