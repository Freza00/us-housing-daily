import fs from 'node:fs';
import { shouldRun, buildWindow } from './lib/calendar.mjs';
const kind = process.argv[2], now = new Date();
let go = shouldRun(kind, now, { force: process.env.FORCE_RUN === '1' });
if (go && process.env.FORCE_RUN !== '1') {
  const window = buildWindow(kind, now), label = kind === 'daily' ? window.date : kind === 'weekly' ? window.periodStart : window.label;
  const dir = kind === 'daily' ? 'data' : `data/${kind}`;
  try { const saved = JSON.parse(fs.readFileSync(`${dir}/${label}.json`, 'utf8')); const latest = JSON.parse(fs.readFileSync(`${dir}/latest.json`, 'utf8')); go = !(saved.schema_version === 2 && saved.publication_status === 'complete' && saved.window?.upper === window.upper && saved.window?.upper === latest.window?.upper); } catch {}
}
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `go=${go}\n`);
console.log(JSON.stringify({ kind, go, timezone: 'Asia/Shanghai' }));
