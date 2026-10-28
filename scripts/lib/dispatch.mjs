import { shouldRun } from './calendar.mjs';

export function makeHandler(kind, { now = () => new Date(), fetchImpl = fetch } = {}) {
  return async function handler(req, res) {
    if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'unauthorized' });
    if (!shouldRun(kind, now())) return res.status(200).json({ ok: true, skipped: true, reason: 'Outside Beijing publishing schedule' });
    if (!process.env.GH_PAT) return res.status(500).json({ error: 'GH_PAT not configured' });
    try {
      const r = await fetchImpl('https://api.github.com/repos/Freza00/us-housing-daily/dispatches', {
        method: 'POST', signal: AbortSignal.timeout(8000), headers: { Authorization: `Bearer ${process.env.GH_PAT}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'news-agent-vercel-cron' },
        body: JSON.stringify({ event_type: `${kind}-build` }),
      });
      if (!r.ok) return res.status(502).json({ error: 'GitHub dispatch failed', status: r.status });
      return res.status(200).json({ ok: true, dispatched_at: new Date().toISOString() });
    } catch { return res.status(502).json({ error: 'GitHub dispatch request failed' }); }
  };
}
