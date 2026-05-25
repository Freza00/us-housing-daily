// Vercel Cron endpoint — dispatches the GitHub Actions monthly-build workflow.
// Vercel cron 配在 vercel.json，每月一日北京 10:30 (UTC 02:30) 触发；
// 真实 pipeline 跑在 GH Actions runner (.github/workflows/monthly.yml)。

export default async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  const ghPat = process.env.GH_PAT;
  if (!ghPat) {
    return res.status(500).json({ error: "GH_PAT not configured in Vercel env" });
  }

  const r = await fetch("https://api.github.com/repos/Freza00/us-housing-daily/dispatches", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ghPat}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "news-agent-vercel-cron",
    },
    body: JSON.stringify({ event_type: "monthly-build" }),
  });

  if (!r.ok) {
    const errText = await r.text();
    console.error(`GH dispatch failed: ${r.status} ${errText.slice(0, 300)}`);
    return res.status(502).json({ error: "GH dispatch failed", status: r.status, detail: errText.slice(0, 300) });
  }

  return res.status(200).json({ ok: true, dispatched_at: new Date().toISOString() });
}
