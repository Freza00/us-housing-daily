import {createHash} from 'node:crypto';

// Acquisition retains content versions; editorial story deduplication happens later.
export function mergeRawItems(items) {
 const result=new Map();
 for(const item of items){const key=materialFingerprint(item);if(!result.has(key))result.set(key,item);}
 return [...result.values()];
}
export const materialFingerprint=it=>createHash('sha256').update(JSON.stringify([it.id,it.content_hash||'',it.published_at,it.title||'',it.description||''])).digest('hex');

export function captureFingerprint(row) {
 const upper=row.cutoff_upper??row.window.upper;
 return createHash('sha256').update(JSON.stringify(row.items.filter(it=>it.published_at<upper).map(materialFingerprint).sort())).digest('hex');
}
function legacyCaptureFingerprint(row){const upper=row.cutoff_upper??row.window.upper;return createHash('sha256').update(JSON.stringify(row.items.filter(it=>it.published_at<upper).map(it=>[it.id,it.content_hash||'']).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))))).digest('hex');}

export function sourceLower(checkpoint,id,fallback) {
  return checkpoint.source_upper?.[id] ?? checkpoint.source_floor?.[id] ?? fallback;
}
function combinePending(rows) {
  rows=rows.filter(r=>r?.items?.length);if(!rows.length)return null;
  const items=mergeRawItems(rows.flatMap(r=>r.items));
  const lower=Math.min(...rows.map(r=>r.window.lower),...items.map(it=>it.published_at));
  const upper=Math.max(...rows.map(r=>r.window.upper),...items.map(it=>it.published_at+1));
  return {schema_version:3,provenance:'live',coverage_status:'unverified',cutoff_upper:Math.max(...rows.map(r=>r.cutoff_upper??r.window.upper)),window:{lower,upper,hours:(upper-lower)/3600000},items,source_health:rows.flatMap(r=>r.source_health||[])};
}
export function mergeCheckpoints(committed={},cached={}) {
  const source_upper={},source_floor={},health=new Map();
  for(const state of [committed,cached]) {
    for(const [id,value] of Object.entries(state.source_upper||{}))source_upper[id]=Math.max(source_upper[id]||0,value);
    for(const [id,value] of Object.entries(state.source_floor||{}))source_floor[id]=Math.min(source_floor[id]??value,value);
    for(const h of state.health||[])if(!health.has(h.id)||(h.checked_at||0)>=(health.get(h.id).checked_at||0))health.set(h.id,h);
  }
  const rows=[committed.pending,cached.pending,cached.last_capture].filter(Boolean);
  const pending=combinePending(rows.map(r=>{
    const upper=r.cutoff_upper??r.window.upper,done=committed.processed_capture;
    const processed=done?.upper===upper&&(done.fingerprint===captureFingerprint(r)||(!done.fingerprint_version&&r.items.filter(it=>it.published_at<upper).every(it=>it.content_hash)&&done.fingerprint===legacyCaptureFingerprint(r)));
    return {...r,items:processed?r.items.filter(it=>it.published_at>=upper):r.items};
  }));
  return {schema_version:1,daily_upper:Math.max(committed.daily_upper||0,cached.daily_upper||0)||undefined,source_upper,source_floor,observed_ids:[...new Set([...(committed.observed_ids||[]),...(cached.observed_ids||[])])],initialized_sources:[...new Set([...(committed.initialized_sources||[]),...(cached.initialized_sources||[])])],health:[...health.values()],processed_capture:committed.processed_capture,pending,last_capture:cached.last_capture};
}
export function finishCapture(checkpoint,upper) {
  const row=checkpoint.pending;
  const pending=row?combinePending([{...row,window:{lower:upper,upper:Math.max(upper,...row.items.map(it=>it.published_at+1))},items:row.items.filter(it=>it.published_at>=upper)}]):null;
  return {...checkpoint,pending,processed_capture:checkpoint.last_capture?{upper,fingerprint:captureFingerprint(checkpoint.last_capture),fingerprint_version:2}:checkpoint.processed_capture};
}

// The caller writes raw capture first, then this checkpoint, before invoking models.
export function stageCapture(previous,sources,results,window,priorCapture=null,capturedAt=Date.now(),{activatePending=true}={}) {
  const source_upper={...previous.source_upper},source_floor={...previous.source_floor};
  const healthById=new Map((previous.health||[]).map(h=>[h.id,h]));
  const fresh=[],observedIds=new Set(previous.observed_ids||[]),initialized=new Set(previous.initialized_sources||[]);
  for(const source of sources)source_floor[source.id]??=window.lower;
  for(const {items,health} of results) {
    const lower=sourceLower(previous,health.id,window.lower);healthById.set(health.id,health);
    // Retain observed post-cutoff items even if they disappear from tomorrow's feed.
    for(const it of items) {
      if(!Number.isFinite(it.published_at)||!it.published_at||!it.title||!(it.description?.length>=80))continue;
      const unseen=!observedIds.has(it.id);observedIds.add(it.id);
      if(unseen && (it.published_at>=lower || initialized.has(health.id)))fresh.push({...it,
        acquisition_window:it.published_at>=lower?{lower,upper:window.upper}:null,
        ...(it.published_at<lower?{late_discovery:true}: {})});
    }
    if(health.status==='ok')initialized.add(health.id);
    if(health.status==='ok'&&!health.undated&&health.coverage?.lower<=lower&&health.coverage?.upper>=window.upper&&!health.article_errors?.length)source_upper[health.id]=Math.max(source_upper[health.id]||0,window.upper);
  }
  const raw=mergeRawItems([...(previous.pending?.items||[]),...(priorCapture?.items||[]),...fresh]).map(it=>
    activatePending&&it.published_at>=window.lower&&it.published_at<window.upper
      ?{...it,acquisition_window:{lower:window.lower,upper:window.upper}}:it);
  const items=raw.filter(it=>it.published_at<window.upper);
  const lower=Math.min(window.lower,priorCapture?.window?.lower??window.lower);
  const captureWindow={...window,lower,hours:(window.upper-lower)/3600000};
  const health=sources.map(s=>healthById.get(s.id)).filter(Boolean);
  const observed=health.some(h=>h.required)&&health.filter(h=>h.required).every(h=>h.status==='ok'&&h.coverage?.lower<=lower&&h.coverage?.upper>=window.upper);
  const capture={schema_version:3,provenance:'live',coverage_status:observed?'observed':'unverified',generated_at:capturedAt,window:captureWindow,items,source_health:health};
  const last_capture={...capture,items:raw,cutoff_upper:window.upper};
  return {capture,checkpoint:{schema_version:1,daily_upper:Math.max(previous.daily_upper||0,window.upper),source_upper,source_floor,observed_ids:[...observedIds],initialized_sources:[...initialized],health,processed_capture:previous.processed_capture,pending:combinePending([last_capture]),last_capture}};
}

// Periodic audits retain new observations without consuming the daily acquisition interval.
export function stageSupplement(previous,sources,results,window,capturedAt=Date.now()) {
 const staged=stageCapture(previous,sources,results,window,null,capturedAt,{activatePending:false}).checkpoint;
 return {...previous,source_floor:staged.source_floor,observed_ids:staged.observed_ids,initialized_sources:staged.initialized_sources,pending:staged.pending};
}
