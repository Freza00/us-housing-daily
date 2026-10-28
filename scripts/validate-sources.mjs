import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareCandidates } from './lib/editorial.mjs';
import { createCollector } from './lib/sources.mjs';
const args = process.argv.slice(2), outputAt = args.indexOf('--output');
const output = outputAt >= 0 ? path.resolve(args[outputAt + 1]) : path.resolve('.tmp/source-probe.json');
if (!output.includes('/.tmp/')) throw new Error('Source probes must write to a task .tmp directory');
const config = JSON.parse(await fs.readFile(new URL('../config/sources.json', import.meta.url), 'utf8'));
const idsAt = args.indexOf('--ids'), ids = idsAt >= 0 ? args[idsAt + 1].split(',') : null;
const sources = config.sources.filter(s => (!args.includes('--research-only') || s.is_research) && (!ids || ids.includes(s.id)));
const collector = createCollector();
const results = await collector.collect(sources);
if (args.includes('--enrich')) {
 const eligible = prepareCandidates(results.flatMap(r => r.items), { lower: Date.now() - 14 * 86400000, upper: Date.now() }, []).candidates;
 const full = new Map((await collector.enrich(eligible)).map(it => [it.id, it]));
 for (const result of results) result.items = result.items.map(it => full.get(it.id) || it);
}

const report = { checked_at: new Date().toISOString(), sources: results.map(r => ({ ...r.health, samples: r.items.slice(0, 3).map(it => ({ title: it.title, url: it.link, published_at: it.published_at, body_length: it.description.length, access: it.access || 'feed_excerpt' })) })) };
await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2));
await fs.writeFile(output.replace(/\.json$/, '') + '-snapshot.json', JSON.stringify({ provenance: 'retrospective_reconstruction', generated_at: Date.now(), items: results.flatMap(r => r.items), source_health: results.map(r => r.health) }, null, 2));
await fs.writeFile(output.replace(/\.json$/, '') + '-cache.json', JSON.stringify(collector.cache));
console.log(JSON.stringify({ output, attempted: sources.length, ok: report.sources.filter(s => s.status === 'ok').length, failed: report.sources.filter(s => s.status !== 'ok').map(s => ({ id: s.id, status: s.status, error: s.error })) }, null, 2));

if (!sources.length || report.sources.some(s => s.required && s.status !== 'ok')) process.exitCode = 1;
