# Sage — Slack App Descriptions

Copy/paste these into the Slack app dashboard fields. Keep this file updated when capabilities change.

---

## Short description

**Use in:** Basic Information → Display Information → Short description (140 char max)

```
Pearl marketing's Slack helper. @Sage in your marketing-requests channel to file a request, ask a brand question, or check status.
```

(132 characters)

---

## Long description

**Use in:** Basic Information → Display Information → Long description (4000 char max)

```
Sage is Pearl marketing's Slack-native intake helper. @mention Sage in your division's #mktg_*_requests channel to file a request, ask a brand question, or check status on something in flight. Every request becomes a tracked Monday item, and Sage posts lifecycle updates back to the same thread as work progresses. Type @Sage help in any channel to see the full list of what I can do.
```

(395 characters — still scannable, with a clear pointer to the help command for anyone who wants more.)

---

## Notes for future updates

- These descriptions reflect the Sage v2 channel-native architecture (per `tasks/prd-sage-v2.md`). If features change materially (new channels added, capabilities shipped or retired), update both blocks here AND in the Slack app dashboard.
- Slack does not render markdown in the long description field — keep it plain text with line breaks. The plain bullets (`•`) above render correctly in Slack's app directory; markdown asterisks would not.
- App name field separately: `Sage` (35 char max — well under).
- App Home → Bot Name field separately: `Sage` (also has its own field).
