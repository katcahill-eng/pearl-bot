# MarcomsBot v3 — Knowledge Base, Smart Follow-ups, Post-Submission Handling

**Date:** 2026-02-03
**Status:** Implemented

---

## What Changed

### 1. Marketing Knowledge Base (`src/lib/knowledge-base.md`)

A structured markdown file loaded at startup that gives Claude context about Pearl's marketing operations. Contains:

- **Request types** with what marketing does/doesn't handle: Conferences, Pearl Insider Dinners, Webinars (live/pre-recorded/recurring), Emails, Graphic Design
- **Tools reference:** GoTo, Zoom Webinars, HubSpot, Craft CMS, Canva, Google Slides, Google Drive
- **Social platforms:** LinkedIn/X (B2B), Meta/Bluesky (B2C), Instagram (recruitment only)
- **Workflow boundaries:** Marketing vs CX vs requesting department vs EA responsibilities
- **General notes:** Brainstorm option, presentation timelines, capacity (1.5 people)

### 2. Smart Follow-up Questions

After the 6 required intake fields are collected, the bot now:

1. Classifies the request type (conference, webinar, email, graphic_design, insider_dinner, general)
2. Generates 3-7 tailored follow-up questions using the knowledge base
3. Asks them one at a time with progress indicators ("Just 2 more", "Last one!")
4. Naturally includes expectation-setting (e.g., "printed materials are charged back to your department")

**User controls:**
- `skip` — skips the current question
- `submit as-is` / `done` — skips all remaining follow-ups, goes to confirmation
- Multi-field answers are interpreted by Claude and can auto-skip upcoming questions

**Data model:** Follow-up answers stored in `collected_data.additional_details` (a key-value record). Request type stored in `collected_data.request_type`. No new DB status — follow-ups stay within `gathering` using `currentStep = 'follow_up:N'`.

### 3. Monday.com Item Created at Submission (Not Approval)

Previously, Monday.com items were created when the triage panel was set to "In Progress." Now:

- Item is created immediately when the requester confirms ("yes") — status set to "Under Review"
- Monday.com link shown on the triage panel from the start
- "In Progress" now runs the approval workflow (brief + Drive for full projects, status update for both) against the existing item
- If no Monday item exists when "In Progress" is clicked, a warning is posted to the triage thread

### 4. Withdrawn Status

New terminal status for requests that are pulled back.

- Available in the triage panel dropdown
- Can be triggered by the marketing team (from triage) or by the requester (from their thread)
- Sets conversation status to `withdrawn`, updates Monday.com to "Withdrawn"
- Triage panel locks with `:no_entry: Withdrawn by [name]`
- Requester gets notified

### 5. Triage Message Timestamp Storage

The triage panel message's `ts` and `channel_id` are now stored in the database when posted. This enables post-submission features to post replies in the triage thread.

- New DB columns: `triage_message_ts`, `triage_channel_id`
- Stored via `updateTriageInfo()` after `sendApprovalRequest()` completes

### 6. Post-Submission Thread Handling

When a requester posts in a thread with a `pending_approval` or `complete` conversation, the bot now shows three action buttons:

| Button | Flow |
|--------|------|
| **Additional Information** | Prompts for info → forwards to triage thread + Monday.com update |
| **Change to Request** | Prompts for change → posts `[Scope Change]` to triage thread + Monday.com |
| **Withdraw Request** | Confirms → sets status to withdrawn, updates Monday.com + triage panel |

Monday.com updates use the `create_update` mutation (adds a comment to the item's activity log).

### 7. Message Routing Update

`messages.ts` now routes `pending_approval` and `complete` status threads to the intake handler (instead of ignoring them), enabling the post-submission button flow.

---

## Files Modified

| File | Summary |
|------|---------|
| `src/lib/knowledge-base.md` | **New** — Marketing knowledge base |
| `src/lib/db.ts` | Added `triage_message_ts`, `triage_channel_id` columns; `withdrawn` status; `updateTriageInfo()` |
| `src/lib/conversation.ts` | Extended `CollectedData` (request_type, additional_details, conference/presenter fields); follow-up methods; triage getters |
| `src/lib/claude.ts` | Added `classifyRequestType()`, `generateFollowUpQuestions()`, `interpretFollowUpAnswer()`; loads knowledge base |
| `src/lib/monday.ts` | Added `addMondayItemUpdate()` — posts comments via `create_update` mutation |
| `src/lib/webhook.ts` | Updated for new `CollectedData` fields |
| `src/handlers/intake.ts` | Follow-up phase; Monday at submission; post-submission buttons + handlers; `registerPostSubmissionActions()` |
| `src/handlers/approval.ts` | Withdrawn status; triage ts capture; Monday link in panel; simplified In Progress |
| `src/handlers/messages.ts` | Routes `pending_approval`/`complete` threads to intake |
| `src/index.ts` | Registers post-submission actions; version marker v3 |
| `README.md` | Updated architecture and file listing |

---

## Conversation State Machine (Updated)

```
gathering → follow_up:0..N → confirming → pending_approval → complete
                                        → cancelled
                                        → withdrawn

Post-submission sub-flows (within pending_approval/complete):
  post_sub:awaiting_info
  post_sub:awaiting_change
  post_sub:awaiting_withdraw_confirm
```

---

## Database Schema Changes

```sql
ALTER TABLE conversations ADD COLUMN triage_message_ts TEXT;
ALTER TABLE conversations ADD COLUMN triage_channel_id TEXT;
-- Status CHECK now includes 'withdrawn'
```
