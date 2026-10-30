import fs from 'node:fs';
import { shouldRun, buildWindow } from './lib/calendar.mjs';
import { validArchive, assertExpectedIssue } from './lib/issue-contract.mjs';
import { beijingDateStr } from './lib/dates.mjs';
const kind = process.argv[2], now = new Date();
let go = shouldRun(kind, now, { force: process.env.FORCE_RUN === '1' });
const verify = go;
if (go) assertExpectedIssue(kind, buildWindow(kind, now), process.env);
if (go && process.env.FORCE_RUN !== '1') {
  const window = buildWindow(kind, now), label = kind === 'daily' ? window.date : kind === 'weekly' ? window.periodStart : window.label;
  const dir = kind === 'daily' ? 'data' : `data/${kind}`;
  try { const saved = JSON.parse(fs.readFileSync(`${dir}/${label}.json`, 'utf8')); go = !!process.env.ISSUE_REVISION && Number(process.env.ISSUE_REVISION) > (saved?.edition?.revision || 0) || !validArchive(saved, { kind, upper: window.upper, period: label }); } catch {}
}
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `verify=${verify}\n`);
if (process.env.GITHUB_ENV && verify && kind !== 'monthly') fs.appendFileSync(process.env.GITHUB_ENV, `PUBLICATION_DEADLINE_MS=${Date.parse(beijingDateStr(now.getTime()) + 'T09:00:00+08:00')}\n`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `go=${go}\n`);
console.log(JSON.stringify({ kind, go, timezone: 'Asia/Shanghai' }));
