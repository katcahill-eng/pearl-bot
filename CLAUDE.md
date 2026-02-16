# Pearl Bot — Claude Instructions

## Session Startup

At the start of every session involving pearl-bot, run these checks in order:

1. **Check for errors:**
```
curl -s https://pearl-bot-production.up.railway.app/debug/errors
```
If errors exist, investigate and fix them.

2. **Check for pending improvements:**
```
curl -s https://pearl-bot-production.up.railway.app/debug/improvements
```
If pending improvements exist, review each one and apply the suggested fix as a real code change. After applying, mark as applied via the DB (or dismiss if not applicable).

3. **Check conversation metrics:**
```
curl -s https://pearl-bot-production.up.railway.app/debug/metrics
```
Look for concerning patterns (high cancel/timeout rates, spikes in unrecognized messages at specific steps).

4. After applying any changes: `npm test` → commit → push.

## Debug Endpoints

- **Health:** `https://pearl-bot-production.up.railway.app/health`
- **Errors:** `https://pearl-bot-production.up.railway.app/debug/errors`
- **Improvements:** `https://pearl-bot-production.up.railway.app/debug/improvements`
- **Metrics:** `https://pearl-bot-production.up.railway.app/debug/metrics`
- **Logs:** `https://pearl-bot-production.up.railway.app/debug/logs`
- **DB state:** `https://pearl-bot-production.up.railway.app/debug/db`

## Testing

Run `npm test` before committing changes. All 135+ tests must pass.

## Deployment

Pushes to `main` auto-deploy to Railway. The bot runs in socket mode (not HTTP).
Rolling deploys cause a brief dual-instance window — the SIGTERM handler and message dedup table handle this.
