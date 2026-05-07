<h1 align="center">US Housing Daily</h1>

<p align="center">
  <strong>A daily-updated dashboard for US residential real-estate news, in Chinese.</strong><br>
  30 RSS sources → bilingual cards with importance scores and impact direction → published as a static site.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="Apache 2.0"></a>
  <a href="https://news-agent-mu.vercel.app"><img src="https://img.shields.io/badge/demo-live-success?logo=vercel&logoColor=white" alt="Live demo"></a>
  <a href=".github/workflows/daily.yml"><img src="https://img.shields.io/badge/cron-daily_08:57_Beijing-brightgreen" alt="Daily build"></a>
  <a href="https://github.com/Freza00/us-housing-daily/stargazers"><img src="https://img.shields.io/github/stars/Freza00/us-housing-daily?style=social" alt="Stars"></a>
</p>

<p align="center">
  <a href="https://news-agent-mu.vercel.app">→ Live demo</a> ·
  <a href="docs/DEPLOY.md">Deploy your own</a> ·
  <a href="config/sources.json">Source list</a>
</p>

---

## What this is

A free, open-source pipeline that wakes up every day at **08:57 Beijing time**, pulls 30 hand-picked RSS feeds covering US residential real-estate news (national + Sun Belt + BTR/SFR + CRE + institutional capital), runs them through a deduplicating + scoring pipeline, then makes a single batched LLM call to translate the top 20 stories into Chinese-language titles and 60-character summaries with **★ importance** (1–5) and **impact direction** (long-pos / short-pos / neutral / short-neg / long-neg).

The output is a static `/data/latest.json` file, served directly from Vercel. The frontend is a single `index.html` + `app.js` with a Chinese/English language toggle. **Total infrastructure cost: under $1/month** (Vercel hobby + GitHub Actions free tier + LLM API).

It is built for someone who wants the highlights of the US residential market every morning without reading 200 RSS items by hand. The pipeline is open-source and easily forked for adjacent verticals — multifamily ops, single-family rental, fintech, etc. — by editing `config/sources.json` and a few regex patterns.

## Features

- **30 first-party RSS sources** — HousingWire / Inman / Multi-Housing News / Bisnow / Calculated Risk / ResiClub / SEC EDGAR (INVH/AMH 8-K) / NAHB Eye on Housing / Phoenix–Atlanta–Miami Agent Magazines / TRERC / and more
- **Five sections with hard quotas** — National housing (5) · Sun Belt residential (4) · BTR/SFR (3) · CRE (5) · Institutional capital (3) — never more, never less
- **Strict 24-hour window for high-volume sections; 7-day extended-window fallback for low-volume ones** with visible `[ext]` badge so you can tell apart fresh from carry-over
- **Cloudflare/Substack 403 fallback** — sources that block GitHub Actions IPs (Inman, Multi-Housing News, ResiClub) auto-route through a Google News RSS aggregator with no proxy or secret needed
- **Importance-aware ranking** — LLM scores each story 1–5 with a forced distribution (no all-3s); items reordered by `importance × 5 + score × 0.5` so the most consequential headline floats to the top of each section
- **Cross-day deduplication** with rolling 21-day seen-list to avoid yesterday's news showing up again
- **One LLM call per day** — entire batch of 20 in a single request, keeping cost under $1/month even on commercial models (GPT-4o-mini / Kimi / Claude Haiku)
- **Bilingual frontend** — Chinese/English toggle with cached language preference; mobile-responsive
- **Apache 2.0 licensed** — fork it, change the topic, change the language, ship a different vertical

## Architecture

```
30 RSS sources
     ↓ fetch (parallel, browser-fingerprint headers + alternates fallback)
     ↓ parse / score / 28-tag classify
     ↓ 24h time-window + entity-level dedupe + cross-day dedupe (21d)
     ↓ enrich top-30 by fetching article bodies
     ↓ pick by section quota (3-pass: 24h-quota → 7d-extend → 24h-flex)
     ↓ ensureSectionMinimum: ≥ 2 per section · ensureTexasCity: ≥ 1 DFW/Houston/Austin
     ↓ single LLM batch call → titles_zh + summaries_zh + imp 1-5 + dir
     ↓ importance-aware reranking inside each section
write data/latest.json + data/YYYY-MM-DD.json + state/seen.json
     ↓ git commit + push
     ↓ Vercel auto-deploys main on every push
public/index.html → serves the static dashboard
```

90% scripts (fetcher / regex / scoring / classification / dedup), 10% LLM (one call to translate and rank).

## Quick start

```bash
git clone https://github.com/Freza00/us-housing-daily.git
cd us-housing-daily

# 1. Configure
cp .env.example .env
# Edit .env to fill in:
#   LLM_API_KEY, LLM_ENDPOINT, LLM_MODEL  (any OpenAI-compatible API)
#   SEC_CONTACT_EMAIL                     (your email, required by SEC EDGAR)

# 2. Run the pipeline
npm run build               # full pipeline with LLM (~70s)
LLM_SKIP=1 node scripts/build.mjs   # skip LLM, just verify fetching (~12s)

# 3. Preview the dashboard
npm run preview             # http://localhost:8080
```

That's it for local. For continuous daily updates on free tiers (GitHub Actions cron + Vercel hosting), see [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Customizing

- **Add or remove a source** — edit `config/sources.json`. Each entry needs `id`, `name`, `url`, `tier` (A–E), `tags` (canonical IDs from `scripts/build.mjs`), `weight` (1–10), `region`. Optional: `alternates: []` for 403-prone feeds, `ua_style: "sec"` for SEC EDGAR fair-use UA.
- **Tweak section quotas** — `SECTIONS` array near the top of `scripts/build.mjs`. Each section has `quota` (target count) and `extendedWindow` (whether to fall back to the 7-day pool when 24h pool is dry).
- **Reclassify items** — `classify()` and the `RE_*` regex patterns. The current logic routes `multifamily-in-Sun-Belt` to the sunbelt section and bare `multifamily` (no Sun Belt city) to CRE; flip this by editing `RE_MULTIFAMILY_ASSET` and `SUNBELT_REGIONS`.
- **Change the language or tone** — the LLM `systemPrompt` in `summarizeBatch()` is in Chinese; rewrite it for English, German, etc. A few in-prompt examples teach the model the desired voice.
- **Use a different LLM provider** — set `LLM_ENDPOINT` to any OpenAI-compatible chat-completions URL. Tested with Kimi (Moonshot), GPT-4o-mini, Claude Haiku via proxy, Together, Fireworks.

## Status & limitations

- Pipeline is single-tenant by design — one config, one output JSON. Multi-tenant or per-user weights are out of scope.
- LLM importance scoring is forced into a distribution but still depends on model quality; smaller models (≤7B) have struggled with the constraint in testing — Kimi-K2.6 / GPT-4o-mini / Claude-3.5-Haiku work well.
- The 24h window is strict for `national` and `cre`; `sunbelt` / `btr` / `institutional` fall back to 7d when the 24h pool is dry. Items from the 7d fallback are tagged `extended_window: true` and rendered with a visible `[ext]` badge.
- No tests. The pipeline is a personal-tool-grown-into-a-shareable-thing, not a production system.

## Roadmap

Ideas if anyone wants to PR:

- Email / Telegram / Slack push of the daily digest
- Per-user weight learning from frontend click-through data
- A second vertical config (e.g. `config/sources.crypto.json`) so one repo can serve multiple topic streams
- Better evaluation: a small ground-truth set of "these 5 items were the day's biggest news" labeled by a human, so we can A/B-test scoring tweaks

## Contributing

Issues and PRs welcome. There is no test suite — verify changes by running `npm run build` locally and inspecting `data/latest.json`. Avoid committing `.env` (it's gitignored anyway). For substantive changes (a new section, a new region), open an issue first to discuss.

## License

[Apache License 2.0](LICENSE) — free to use, modify, and redistribute, with patent grant.
