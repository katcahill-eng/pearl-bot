# Sage Help Message Drafts (v2, role-aware)

Refreshed copy for the `getHelpMessage()` function in `src/handlers/intent.ts`. Per PRD US-015, the help response is role-aware — different copy in intake channels vs. the alerts channel.

These use Slack mrkdwn formatting (single asterisks for bold, single underscores for italic). Wire up when US-015 is in active build.

---

## Intake channels (`#mktg_bd_requests`, `#mktg_p2_requests`, etc.)

```
Hey — I'm Sage, the marketing team's intake helper. In this channel:

• *@Sage I need [a thing]* — I'll open a pre-filled request modal and turn it into a tracked Monday item.
• *@Sage what's our logo / tagline / brand colors?* — quick brand info from our resource docs.
• *@Sage is this on-brand: [paste]* — light QC against brand guidelines.
• *@Sage where's my request?* — status lookup from Monday.
• *In an existing request thread:* `@Sage here's the supporting doc` or `@Sage move the deadline to May 20` — I'll update the Monday item.

I only respond when you @mention me — channel chatter without @Sage is ignored. See the pinned message for your division's Monday view.
```

---

## Alerts channel (`#mktg_incoming_requests`)

```
Hey — I'm Sage. This is the marketing alerts channel — I post here when new requests come in and reply with status updates as they progress.

• *Marketing's reply threads here are private to the team* — I don't listen to anything that isn't @-mentioned. Use those threads for internal coordination.
• *@Sage what's BD working on?* or *@Sage show me open Product requests* — cross-division status reports.
• *@Sage what's our logo URL?* — brand info works here too.

To *file* a new request, head to your division's `#mktg_{division}_requests` channel. This channel is alerts-only.
```

---

## Implementation note

`getHelpMessage()` currently takes no arguments. To make it role-aware, change the signature to:

```ts
export function getHelpMessage(channelRole: 'intake' | 'alerts' | 'test' = 'intake'): string
```

The caller (channel-router in v2) passes the role from `channels.yaml`. Default to `'intake'` so any code path that doesn't pass a role gets the most common case.
