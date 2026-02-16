# Pearl Bot — Claude Instructions

## Session Startup

At the start of every session involving pearl-bot, check for production errors:
```
curl -s https://pearl-bot-production.up.railway.app/debug/errors
```
If errors exist, mention them to the user and offer to investigate/fix.

## Debug Endpoints

- **Health:** `https://pearl-bot-production.up.railway.app/health`
- **Errors:** `https://pearl-bot-production.up.railway.app/debug/errors`
- **Logs:** `https://pearl-bot-production.up.railway.app/debug/logs`
- **DB state:** `https://pearl-bot-production.up.railway.app/debug/db`

## Testing

Run `npm test` before committing changes. All 135+ tests must pass.

## Deployment

Pushes to `main` auto-deploy to Railway. The bot runs in socket mode (not HTTP).
Rolling deploys cause a brief dual-instance window — the SIGTERM handler and message dedup table handle this.
