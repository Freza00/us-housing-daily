import fs from 'node:fs';
import path from 'node:path';
import { shouldRun, buildWindow, publicationDeadline, canAttemptRecoverySchedule, recoverableRevision } from './lib/calendar.mjs';
import { validArchive, assertExpectedIssue, periodKey } from './lib/issue-contract.mjs';
import { loadWindowSnapshots } from './lib/issue-store.mjs';
const kind = process.argv[2], now = new Date(), force = process.env.FORCE_RUN === '1';
const scheduled = shouldRun(kind, now, { force });
let go = scheduled, verify = scheduled, recoveryRevision = null;
const canEvaluate = scheduled || (!force && canAttemptRecoverySchedule(kind, now));
if (canEvaluate) {
  const window = buildWindow(kind, now), label = periodKey(kind, window);
  assertExpectedIssue(kind, window, process.env);
  const dataDir = process.env.NEWS_DATA_DIR || 'data', stateDir = process.env.NEWS_STATE_DIR || 'state';
  const dir = kind === 'daily' ? dataDir : path.join(dataDir, kind);
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(path.join(dir, `${label}.json`), 'utf8')); } catch {}
  const validSaved = validArchive(saved, { kind, upper: window.upper, period: label });
  const recoverable = !force && validSaved ? recoverableRevision({ kind, saved, snapshots: await loadWindowSnapshots(stateDir, window), window, now }) : null;
  if (scheduled) {
    if (!force && validSaved) {
      if (process.env.ISSUE_REVISION) go = Number(process.env.ISSUE_REVISION) > (saved?.edition?.revision || 0);
      else if (recoverable) { go = true; recoveryRevision = recoverable; }
      else go = false;
    }
  } else if (recoverable && (!process.env.ISSUE_REVISION || Number(process.env.ISSUE_REVISION) === recoverable)) {
    go = true; verify = true; recoveryRevision = recoverable;
  }
}
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `verify=${verify}\n`);
if (process.env.GITHUB_ENV && verify) fs.appendFileSync(process.env.GITHUB_ENV, `PUBLICATION_DEADLINE_MS=${publicationDeadline(kind, now)}\n`);
if (process.env.GITHUB_ENV && recoveryRevision && !process.env.ISSUE_REVISION) fs.appendFileSync(process.env.GITHUB_ENV, `ISSUE_REVISION=${recoveryRevision}\n`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `go=${go}\n`);
console.log(JSON.stringify({ kind, go, ...(recoveryRevision ? { revision: recoveryRevision } : {}), timezone: 'Asia/Shanghai' }));
