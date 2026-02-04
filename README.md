# MarcomsBot

Slack bot for Pearl marketing intake — handles requests via conversation or form, generates briefs, creates Google Drive folders, and sets up Monday.com tasks.

## Architecture

```
┌─────────────────┐     ┌──────────────┐
│   Slack Events   │     │  Webhook API  │
│ @mention / DM    │     │ POST /intake  │
└────────┬────────┘     └──────┬───────┘
         │                     │
         ▼                     ▼
┌──────────────────────────────────────┐
│            MarcomsBot Core            │
│                                      │
│  Intent Detection → Conversation     │
│  State Machine → Claude NLP          │
│  Knowledge Base → Follow-up Engine   │
│  Brief Generation → Workflow Engine  │
└──┬──────────┬──────────┬────────────┘
   │          │          │
   ▼          ▼          ▼
┌──────┐ ┌────────┐ ┌──────────┐
│Claude│ │ Google │ │Monday.com│
│ API  │ │ Drive  │ │  API     │
└──────┘ └────────┘ └──────────┘
   │          │          │
   └──────────┼──────────┘
              ▼
     ┌────────────────┐
     │ Slack Channel   │
     │ Notification    │
     │ #marketing-     │
     │  requests       │
     └────────────────┘
```

## Prerequisites

- **Node.js** 18+ (uses native `fetch`)
- **npm**
- A **Slack workspace** with permission to install apps
- **Anthropic API key** for Claude
- **Google Cloud** service account with Drive API enabled
- **Monday.com** API token

## Slack App Setup

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**
2. Choose **From scratch**, name it `MarcomsBot`, select your workspace

### 2. Enable Socket Mode

1. Go to **Settings → Socket Mode** and enable it
2. Generate an **App-Level Token** with `connections:write` scope — this is your `SLACK_APP_TOKEN`

### 3. Bot Token Scopes

Under **OAuth & Permissions → Scopes → Bot Token Scopes**, add:

| Scope | Purpose |
|-------|---------|
| `app_mentions:read` | Receive @MarcomsBot mentions |
| `chat:write` | Send messages and replies |
| `im:read` | Receive direct messages |
| `im:write` | Send direct messages |
| `channels:read` | Read channel info |
| `reactions:read` | Read emoji reactions |

### 4. Event Subscriptions

Under **Event Subscriptions → Subscribe to Bot Events**, add:

| Event | Purpose |
|-------|---------|
| `app_mention` | Trigger on @MarcomsBot in channels |
| `message.im` | Trigger on direct messages to bot |

### 5. Install to Workspace

1. Go to **Install App** and click **Install to Workspace**
2. Copy the **Bot User OAuth Token** — this is your `SLACK_BOT_TOKEN`
3. Copy the **Signing Secret** from **Basic Information** — this is your `SLACK_SIGNING_SECRET`

## Google Service Account Setup

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use existing) and enable the **Google Drive API**
3. Go to **IAM & Admin → Service Accounts** and create a service account
4. Create a JSON key for the service account
5. Share the target Google Drive folders with the service account email address (as Editor)
6. Copy the full JSON key — this is your `GOOGLE_SERVICE_ACCOUNT_JSON`
7. Note the folder IDs from the Drive folder URLs:
   - Full projects parent folder → `GOOGLE_PROJECTS_FOLDER_ID`
   - Quick requests folder → `GOOGLE_QUICK_REQUESTS_FOLDER_ID`

## Monday.com API Setup

1. Go to **Monday.com → Profile → Developers → My Access Tokens**
2. Generate a personal API token — this is your `MONDAY_API_TOKEN`
3. Note the board IDs from the Monday.com board URLs:
   - Quick requests board → `MONDAY_QUICK_BOARD_ID`
   - Full projects board → `MONDAY_FULL_BOARD_ID`

## Environment Variables

Copy `.env.example` to `.env` and fill in all values:

```bash
cp .env.example .env
```

### Required

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | App-Level Token (`xapp-...`) |
| `SLACK_SIGNING_SECRET` | App signing secret |
| `SLACK_MARKETING_CHANNEL_ID` | Channel where requests come IN (intake channel) |
| `MARKETING_LEAD_SLACK_ID` | Slack user ID of the marketing lead (receives triage DMs) |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full JSON key for Google service account |
| `GOOGLE_PROJECTS_FOLDER_ID` | Google Drive folder ID for full projects (`1nUtz1xcr8tkmr_dvQ3HM6U64FxOCHNnH`) |
| `GOOGLE_QUICK_REQUESTS_FOLDER_ID` | Google Drive folder ID for quick requests |
| `MONDAY_API_TOKEN` | Monday.com personal API token |
| `MONDAY_QUICK_BOARD_ID` | Monday.com quick requests board ID |
| `MONDAY_FULL_BOARD_ID` | Monday.com full projects board ID |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `SLACK_NOTIFICATION_CHANNEL_ID` | Same as `SLACK_MARKETING_CHANNEL_ID` | Separate channel where marketing team gets notified of new requests |
| `ALLOWED_CHANNEL_ID` | `""` | Restrict bot to only respond in this channel (leave empty for all channels) |
| `INTAKE_FORM_URL` | `""` | URL to intake form (shown in error fallbacks) |
| `WEBHOOK_PORT` | `3100` | Port for the webhook HTTP server |

### Finding Slack Channel and User IDs

**Channel IDs:**
1. Open Slack, go to the channel
2. Click the channel name at the top to open channel details
3. Scroll to the bottom of the details panel — the Channel ID is shown there (starts with `C`)

**User IDs:**
1. Click on a person's name in Slack to view their profile
2. Click the **three dots (⋯)** menu
3. Select **Copy member ID** — this is their Slack User ID (starts with `U`)

## Local Development

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your credentials

# Start in development mode (hot-reload)
npm run dev

# Typecheck
npm run typecheck

# Build
npm run build

# Start production
npm start
```

## Project Structure

```
pearl-bot/
├── src/
│   ├── index.ts                  # App entry point, Bolt init, timeout scheduler
│   ├── handlers/
│   │   ├── mentions.ts           # @mention event handler
│   │   ├── messages.ts           # DM event handler
│   │   ├── intent.ts             # Intent detection (greeting, help, status, search, intake)
│   │   ├── intake.ts             # Conversational intake, follow-ups, post-submission actions
│   │   ├── approval.ts           # Triage control panel, status workflow, withdrawn handling
│   │   ├── status.ts             # Status check handler
│   │   ├── search.ts             # Search/retrieval handler
│   │   └── timeout.ts            # Conversation timeout scheduler
│   └── lib/
│       ├── config.ts             # Environment validation and typed config
│       ├── db.ts                 # SQLite database (better-sqlite3)
│       ├── conversation.ts       # ConversationManager state machine
│       ├── claude.ts             # Claude API — NLP, classification, follow-up generation
│       ├── knowledge-base.md     # Marketing knowledge base (request types, tools, boundaries)
│       ├── brief-generator.ts    # Brief generation via Claude
│       ├── google-drive.ts       # Google Drive folder/doc creation
│       ├── monday.ts             # Monday.com GraphQL API
│       ├── workflow.ts           # Post-confirmation workflow orchestrator
│       ├── notifications.ts      # Slack channel notification formatting
│       └── webhook.ts            # HTTP webhook server for form submissions
├── data/                         # SQLite database (auto-created, gitignored)
├── dist/                         # Compiled output (gitignored)
├── .env.example                  # Environment variable template
├── package.json
└── tsconfig.json
```

## Deployment

MarcomsBot uses Slack Socket Mode, so it does not need a public URL for Slack events. The webhook endpoint (for form submissions) does require a reachable URL if used externally.

### Railway

1. Connect your repo to [Railway](https://railway.app)
2. Set all environment variables in the Railway dashboard
3. Build command: `npm run build`
4. Start command: `npm start`

### Render

1. Create a new **Web Service** on [Render](https://render.com)
2. Set build command: `npm install && npm run build`
3. Set start command: `npm start`
4. Add all environment variables in the Render dashboard

### Fly.io

1. Install the [Fly CLI](https://fly.io/docs/getting-started/installing-flyctl/)
2. Run `fly launch` in the `pearl-bot/` directory
3. Set secrets: `fly secrets set SLACK_BOT_TOKEN=xoxb-... ANTHROPIC_API_KEY=sk-ant-...` (repeat for all vars)
4. Deploy: `fly deploy`

### Docker (generic)

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/
CMD ["node", "dist/index.js"]
```

Build and run:
```bash
npm run build
docker build -t marcomsbot .
docker run --env-file .env marcomsbot
```
