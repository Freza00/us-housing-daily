# Deployment Guide

This guide walks you through running US Housing Daily as a continuously updating site on free tiers. End state:

- Static dashboard hosted on Vercel
- GitHub Actions cron updates `data/latest.json` daily at **08:57 Beijing time** (UTC 00:57)
- Vercel auto-redeploys on every push to `main`
- Total cost: under $1/month

Estimated time: **15–20 minutes**.

## Prerequisites

- A GitHub account (free)
- A Vercel account (hobby tier, free)
- An LLM API key — any OpenAI-compatible endpoint works. Tested:
  - OpenAI (`gpt-4o-mini`, `gpt-5-mini`)
  - Moonshot Kimi (`kimi-k2-turbo-preview`, `Kimi-K2.6` via proxy)
  - Anthropic Claude via OpenAI-compatible proxy (`claude-haiku-4-5`)
  - Together / Fireworks / Groq / self-hosted vLLM

## 1. Fork or push the repo

**Fork on GitHub web UI** (easiest), or push from local:

```bash
# After cloning + customizing
cd us-housing-daily
git remote set-url origin git@github.com:<your-username>/us-housing-daily.git
git push -u origin main
```

## 2. Configure GitHub Secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**. Add four secrets:

| Secret | Value | Example |
|---|---|---|
| `LLM_API_KEY` | Your provider API key | `sk-...` |
| `LLM_ENDPOINT` | Chat-completions URL | `https://api.openai.com/v1/chat/completions` |
| `LLM_MODEL` | Model name | `gpt-4o-mini` |
| `SEC_CONTACT_EMAIL` *(optional)* | Your email | `you@example.com` |

> ⚠️ Never commit your API key. The `.env` file is in `.gitignore`. GitHub Secrets are encrypted at rest and only decrypted into the runner during workflow execution.
>
> The SEC EDGAR fair-use policy requires fetcher User-Agent strings to include real contact info. If you skip `SEC_CONTACT_EMAIL`, the fallback `contact@example.com` will still get responses but you should configure your own to be a good citizen.

## 3. Trigger the first build

Repo → **Actions tab** → **Daily News Build** workflow → **Run workflow** (manual `workflow_dispatch`).

It takes 60–90 seconds. The action will:

1. Fetch all 30 RSS sources in parallel
2. Run scoring, deduplication, and section selection
3. Call the LLM once with the top-20 batch
4. Commit `data/latest.json` and `data/YYYY-MM-DD.json` back to `main`

When it finishes, you should see a new commit `chore: daily build for YYYY-MM-DD` on `main`.

## 4. Connect Vercel

Go to **[vercel.com/new](https://vercel.com/new) → Import Git Repository → select your fork → Deploy**.

Vercel auto-detects `vercel.json`. Key settings (no need to change):

- **Build Command**: `mkdir -p public/data && cp -r data/* public/data/ 2>/dev/null || true`
- **Output Directory**: `public`
- **Framework**: None (static site)

The build copies `data/` into `public/data/` so the static dashboard can fetch JSON from `/data/latest.json`. About 30 seconds to deploy.

After deploy, visit `https://<your-project>.vercel.app` to see the dashboard.

## 5. Verify the daily cron

The workflow (`.github/workflows/daily.yml`) runs daily at **UTC 00:57 (Beijing 08:57)**:

```yaml
on:
  schedule:
    - cron: '57 0 * * *'
  workflow_dispatch:    # also allow manual trigger
```

Each daily run produces a new commit. Vercel watches the `main` branch and redeploys automatically — typically the new content is live by **09:00 Beijing time**.

The time window is `[yesterday 08:57, today 08:57)` (absolute boundaries), so news cleanly chains across days with no overlap or gap.

## Local development

```bash
# Skip LLM, just verify the fetching pipeline (~12s)
LLM_SKIP=1 node scripts/build.mjs

# Full pipeline with LLM (~60–90s, depends on LLM provider latency)
npm run build              # reads .env

# Local preview server (auto-symlinks data/ into public/data/)
npm run preview            # http://localhost:8080
```

## Cost breakdown

| Component | Free-tier limit | Daily usage | Monthly cost |
|---|---|---|---|
| GitHub Actions | 2,000 minutes/month | ~1.5 min/day = 45 min/month | $0 |
| Vercel hobby | 100 GB-hr execution / 100 GB bandwidth | < 1 GB | $0 |
| LLM API | varies | ~3–5K tokens/day batch | $0.50–1 |
| **Total** | — | — | **< $1/month** |

## Static API endpoints

| Path | Description |
|---|---|
| `/` | Frontend dashboard (with zh / en toggle) |
| `/data/latest.json` | Latest run |
| `/data/YYYY-MM-DD.json` | Specific date |
| `/data/dates.json` | Index of available dates (last 90 days) |

Anyone can `curl` these — they're plain static files.

## Customizing without redeploy

Most knobs are in two files:

**`config/sources.json`** — add / remove / reweight RSS sources. After editing, `git push` triggers the next cron to use the new config.

**`scripts/build.mjs`** — scoring weights, classification regex, LLM prompt, section quotas. Specifically:

- Source weights — `weight` field (1–10) per source in `sources.json`
- Time decay — `scoreItem()` near line 232: `ageH < 6 → +6`, `< 24 → +4`, `< 48 → +2`
- Keyword multipliers — `HOT_CORE` / `HOT_REGIONAL` / `HOT_MACRO` / `HOT_INST` / `HOT_TREND` arrays
- Section quotas / extended-window policy — `SECTIONS` array
- Classification rules — `classify()` plus `RE_RES`, `RE_SUNBELT`, `RE_MULTIFAMILY_ASSET`, `RE_NON_HOUSING_MARKET`
- LLM prompt + importance distribution targets — `summarizeBatch()`

Push to `main`, the next cron picks up the change. No Vercel redeploy needed (it's data-driven, not code-driven for the frontend).

## FAQ

**The first push didn't trigger Actions.**
Check Actions tab. If disabled, click "I understand my workflows, go ahead and enable them."

**Vercel deployed but the dashboard is blank.**
Check Vercel build logs. Common cause: `vercel.json` `outputDirectory` mismatch. Verify `public/index.html` exists and `public/data/latest.json` was copied during build.

**Data isn't updating.**
Check whether `main` has a new `chore: daily build for ...` commit. If not, the cron failed — read the failed Actions run log. Most common cause: `LLM_API_KEY` missing or invalid.

**`seen.json` is growing.**
The pipeline auto-prunes entries older than 21 days. Each entry is ~150 bytes; max size is ~60 KB.

**A source returns HTTP 403 from GitHub Actions.**
Add an `alternates: []` field to that source in `sources.json`. Default fallback is Google News RSS — see `config/sources.json` for `inman` / `multi-housing-news` / `lance-lambert` examples.

**A whole section is missing or under-quota.**
The 24-hour pool was empty for that section. Either:
1. Add more sources (most common — see `config/sources.json` and how Sun Belt coverage was expanded with `phoenix-agent` / `atlanta-agent` / `miami-agent` / `google-news-sunbelt`)
2. Set `extendedWindow: true` on the section in `SECTIONS`, so it falls back to a 7-day window when 24h is dry.

**Want to switch from US housing to a different topic.**
Replace `config/sources.json` with feeds for your topic, then update:
- `SECTIONS` (the 5 buckets)
- `classify()` (routing rules)
- `RE_*` regex patterns (keyword detection)
- LLM `systemPrompt` (the persona / language)

The pipeline is topic-agnostic — only the configuration is housing-specific.
