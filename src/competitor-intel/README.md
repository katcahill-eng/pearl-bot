# Competitor Intelligence Spoke

A weekly, autonomous competitor-monitoring pipeline for Pearl. It researches,
analyzes, and synthesizes the competitive landscape, then delivers a board-ready
drop every **Monday morning** to a marketing-staff-only Slack channel — backed by
a Google Sheet (system of record) and a generated Google Slides deck.

Co-located with Sage (pearl-bot) to reuse its Anthropic key, Google service
account, and Slack app. Runs as a separate Railway **cron service**, so it never
touches Sage's always-on intake runtime.

## Data flow

```
watchlist (competitors.yaml)
        │
        ▼
1. COLLECT   Perplexity sweeps — competitor news, standing themes, new entrants
2. QUANT     SEMrush snapshots (keywords/traffic) + AI-answer visibility probes
        │
        ▼
3. SYNTHESIZE  Claude → analyst take, movements, threats, opportunities,
               5-pillar read, suggested watchlist additions
        │
        ├──► 4. PERSIST   append the week to the Google Sheet (time-series)
        ├──► 5. RENDER    dated board deck in the Drive folder
        └──► 6. DELIVER   post the drop to the marketing Slack channel
```

The **Sheet** is the asset that compounds (week-over-week / month / quarter
comparisons). The **deck** is the weekly board artifact (archived per week).
Slack is the headline + links.

## Where each signal comes from

| Signal | Source | Status |
|---|---|---|
| Competitor news, funding, M&A, launches, pricing | **Perplexity** (`sonar-pro`) | ✅ Phase 1 |
| New-entrant scouting (suggested additions) | **Perplexity** | ✅ Phase 1 |
| AI-answer visibility / share of voice | **Perplexity** probes (multi-engine in Phase 2) | ✅ Phase 1 |
| Organic keywords, positions, traffic | **SEMrush** Analytics API | ✅ Phase 1 |
| Synthesis / board narrative | **Claude** (`@anthropic-ai/sdk`) | ✅ Phase 1 |
| Competitor ads (creative, spend signal) | Meta Ad Library API | 🔜 Phase 2 |
| Social follower/engagement | Sprout / platform APIs / scrape | 🔜 Phase 3 |
| **Our own** product + site behavior | PostHog, GA4, HubSpot | ➖ internal only — not competitor data |

> PostHog, GA4, and HubSpot measure *our* app, site, and pipeline — useful for
> reading our own response to competitive moves, but they don't see competitors.
> The one exception worth wiring later: HubSpot **closed-lost-by-competitor** as
> a win/loss signal.

## Environment variables (Railway secrets)

Required:
- `SEMRUSH_API_KEY`
- `PERPLEXITY_API_KEY`
- `COMPETITOR_INTEL_FOLDER_ID` — Drive folder for the Sheet + decks
- `COMPETITOR_INTEL_SLACK_CHANNEL_ID` — marketing-staff-only channel

Reused from Sage (already set): `ANTHROPIC_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`,
`SLACK_BOT_TOKEN`.

Optional:
- `COMPETITOR_INTEL_SHEET_ID` — set after first run to reuse the same Sheet
- `COMPETITOR_INTEL_MODEL` — defaults to `claude-sonnet-4-20250514`; bump to
  `claude-opus-4-8` for higher-grade synthesis
- `SEMRUSH_DATABASE` — defaults to `us`
- `GEMINI_API_KEY` — second AI-visibility engine (Phase 2)

## One-time setup (before first run)

1. **Share the Drive folder** with the service account (Editor). Its email is the
   `client_email` in `GOOGLE_SERVICE_ACCOUNT_JSON`.
2. **Invite Sage's bot** to the marketing-staff-only Slack channel; set its ID in
   `COMPETITOR_INTEL_SLACK_CHANNEL_ID`.
3. Add `SEMRUSH_API_KEY` + `PERPLEXITY_API_KEY` as Railway secrets.
4. First run auto-creates the Sheet and logs its id — add it back as
   `COMPETITOR_INTEL_SHEET_ID` to reuse it.

## Two cadences

| Cadence | Entry | When | Output |
|---|---|---|---|
| **Monday briefing** | `run.ts` | Mondays ~9am ET | Full synthesis → Sheet + dated board deck + Slack post |
| **Daily pulse** | `pulse.ts` | Mon–Fri AM | Material-change detection → lightweight Slack heads-up only |

The pulse exists so you never get insight a week late. It detects **material moves**
(funding, M&A, product/pricing launches, major partnerships, big coverage) and
**ranking/AI-visibility shifts**, dedupes against the Sheet's `Events` tab (so the
same item never alerts twice), and posts a compact heads-up to the same channel.
Full analysis still rolls up into Monday's briefing.

## Running

```bash
npm run competitor-intel:dev          # weekly briefing — local, live keys
npm run competitor-intel              # weekly briefing — built (dist)
npm run competitor-intel:pulse:dev    # daily pulse — local, live keys
npm run competitor-intel:pulse        # daily pulse — built (dist)
```

## Railway cron (two services, both sharing the env vars)

1. **Weekly briefing** — start: `npm run competitor-intel` · schedule: `0 13 * * 1`
   (Mondays 13:00 UTC ≈ 9am ET)
2. **Daily pulse** — start: `npm run competitor-intel:pulse` · schedule: `0 12 * * 1-5`
   (Mon–Fri 12:00 UTC ≈ 8am ET)

Adjust the UTC hours for EST/EDT as needed.

## Editing the watchlist

`src/config/competitors.yaml` — add/edit competitors, watch categories, standing
threads, and AI-visibility probe prompts. The spoke's weekly "Suggested to add"
list lands in the Sheet's **Suggested** tab for your approval; promote winners
into `competitors:`.

## Roadmap

- **Phase 1 (this scaffold):** Perplexity + SEMrush + Claude → Sheet + deck + Slack.
- **Phase 2:** Meta/LinkedIn Ad Library connectors; multi-engine AI visibility
  (Gemini + ChatGPT); HubSpot closed-lost-by-competitor.
- **Phase 3:** scrapers for competitor pricing/changelog pages and social.
