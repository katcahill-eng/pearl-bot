# PRD: Sage v2 — Channel-Native Marketing Request Intake

## Introduction

Sage v2 is the Slack-native intake and lifecycle layer for every Pearl Marketing ask. Each requesting division has its own `#mktg_{division}_requests` channel; staff @mention Sage in their division channel to start a request, ask a brand question, or run a light on-brand QC check. Sage parses the message, opens a modal pre-filled with request details and director-brain recommendations, creates a Monday item on submit, and uses the original channel thread as the running record for that request's lifecycle.

A single marketing-internal alerts channel — `#mktg_incoming_requests` — receives a one-line notification from Sage on every new request and on follow-up activity. Marketing uses the reply threads on those alerts as their own internal coordination space (capacity questions, ownership decisions, side comments). Sage **ignores** anything in the alerts channel that isn't an explicit `@Sage` mention, so marketing-internal chatter and Sage's lifecycle replies stay separate by construction.

This is an evolution of the existing Sage codebase. Intake, QC, Monday integration, brand-info, quick-info, and daily-digest are already built; v2 reorganizes them around **one place per division** and **one place for marketing alerts**, replacing the prior multi-channel + DM model. Per the 2026-05-05 architecture decisions, all staff-facing interaction happens in-channel with explicit `@Sage` mention required. DMs are reserved for two specific cases: 48-hour approver nudges with a deep-link back to the channel thread, and the maintainer weekly digest. The original DM-first plan (in earlier drafts) was rejected because allowing both DMs and channels to accept requests would fragment the request stream — staff would put some requests in DM, some in channel, and the team would lose visibility. Channel-only forces a single surface. Monday remains the source of truth for state and structured data; the channel thread is the human-readable lifecycle record.

## Goals

- Each requesting division has **one channel** (`#mktg_{division}_requests`) where every marketing ask, QC check, and brand-info question lives — staff don't learn a second tool
- `@Sage` is the only trigger for any Sage action; nothing happens implicitly on channel chatter
- Director-brain coaching is preserved as pre-checked recommendations in a modal, not back-and-forth conversation
- Every request becomes a structured Monday item on the existing `00.` board with full attribution (requester, requested date, approvers, division, request type, additional divisions impacted)
- Each Monday status or column change posts back as a reply on the original channel thread, so the thread is a complete lifecycle record visible to the whole division
- Approvals happen as in-thread buttons; if an approver hasn't acted within 48 hours, Sage DMs them a deep-link back to the thread (the only DM use case for staff approvers)
- Confirmation replies on submission are explicit about next steps and how the requester can interact with their request (add a doc, change scope, schedule a call) — Sage acts as a customer-service surface, not just a forwarder
- A "Schedule a call with marketing" link (the existing `marketingLeadCalendarUrl` config) appears in the submission confirmation and is re-surfaced when a request enters `Under Review` or `Stuck` — not on every status change
- Marketing has one alerts channel (`#mktg_incoming_requests`) where every new request and every follow-up surfaces as a one-line notification. Marketing uses the reply threads for internal coordination; Sage ignores those replies.
- Each AI-generated response carries the disclaimer: "AI-generated based on the most recent marketing resource documents. If human review is needed, @mention me to submit a request."
- Each intake channel has a pinned message linking to a filtered Monday view (view-only) so the division can self-serve a list of their open and recent requests
- Analytics captured across the lifecycle (modal-open, submission, abandonment, recommendation acceptance, turnaround) so director-brain rules and team operations can be tuned

## User Stories

### US-001: Channel @mention router (role-aware)

**Description:** As Pearl staff, when I @mention Sage in my division's `#mktg_{division}_requests` channel or in `#mktg_incoming_requests`, I want my message routed to the right handler based on the channel's role.

**Acceptance Criteria:**
- [ ] Handler `src/handlers/channel-router.ts` listens for `app_mention` events scoped to channels listed in `src/config/channels.yaml`
- [ ] Channels carry a `role` field: `intake`, `alerts`, or `test`
- [ ] In `intake` channels, recognized intents from the @mentioned text: `info_lookup`, `work_request`, `status_query`, `light_qc`, `unclear`
- [ ] In `alerts` channels, only `status_query` and `info_lookup` are valid. `work_request` from an alerts channel returns: "Requests come from division channels — try `#mktg_{your-division}_requests`."
- [ ] In `test` channels, all intents work but Sage operates in dev mode: skips Monday writes, skips real approver DM nudges, prefixes confirmations with `[TEST]`
- [ ] Sage ignores `message.channels` events that are not `app_mention` events. No ambient listening.
- [ ] If `@Sage` arrives in a thread already linked to a Sage-owned request, the router treats the message as a follow-up to that request (US-016) instead of opening a new modal
- [ ] If `@Sage` is mentioned in a non-configured channel, Sage replies once: "I'm not set up for this channel yet. Try `#mktg_{your-division}_requests` for new requests."
- [ ] Classification uses Anthropic Claude Haiku
- [ ] Unit tests cover each role + intent combination, follow-up routing, non-configured-channel rejection, and the test-mode prefix
- [ ] Typecheck passes
- [ ] Tests pass

### US-002: AI disclaimer on every AI-generated response

**Description:** As Pearl staff, when I receive an AI answer from Sage, I want to see it's AI-generated with a clear path to a human review.

**Acceptance Criteria:**
- [ ] Helper `src/lib/disclaimer.ts` exports `withDisclaimer(message: string): string` and `withDisclaimerBlocks(blocks: Block[]): Block[]`
- [ ] Disclaimer text: "This is AI-generated based on the most recent marketing resource documents. If human review is needed, @mention me to submit a request."
- [ ] Applied to all `info_lookup` and `light_qc` responses
- [ ] NOT applied to: Monday-sourced facts (status, item lists), modal forms, confirmation messages, deliverable links, lifecycle thread replies, alert-channel notifications
- [ ] Unit test: every AI-authored response includes the disclaimer; structured/Monday-sourced responses do not
- [ ] Typecheck passes / tests pass

### US-003: Parse plain-language ask → open modal

**Description:** As Pearl staff, when I @Sage with a plain-language request in my division channel, I want Sage to parse what I said and open a pre-filled modal so I don't re-enter what I already told it.

**Acceptance Criteria:**
- [ ] Module `src/handlers/intake-modal.ts` with entry function `openRequestModalFromAppMention(userId, channelId, threadTs, text, triggerId)`
- [ ] Parsing uses Claude Sonnet to extract: Request Type, Deliverable Description, Audience (if mentioned), Deadline (if mentioned), Event/Project context (if mentioned), Additional Divisions Impacted (if mentioned)
- [ ] Sage applies director-brain rules (US-004) for suggested recommendations
- [ ] Calls `views.open` via Slack Bolt within 3 seconds (Slack `trigger_id` timeout); on timeout, opens modal with original text in Deliverable field and other fields blank
- [ ] Modal carries `private_metadata` JSON with `{ channelId, threadTs }` so submission knows where to post the confirmation reply
- [ ] Unit tests cover: parsed webinar ask, parsed email edit, parsed campaign brief, parse-timeout fallback, metadata round-trip
- [ ] Typecheck passes / tests pass

### US-004: Request modal schema + director-brain recommendations

**Description:** As Pearl staff, when the request modal opens, I want to see the main fields pre-filled, plus Sage's proactively-suggested related work as optional checkboxes.

**Acceptance Criteria:**
- [ ] Modal schema in `src/lib/modals/request-modal.ts`, callable with (parsedFields, recommendations, metadata)
- [ ] Primary sections:
  - **Request Details:** Request Type (select), Deliverable (textarea), Audience (text), Event/Project (text, optional), Deadline (date picker), Approvals (Slack users multi-select), Additional Divisions Impacted (multi-select: BD | P2 | CX/Core | Corporate | Product | Marketing — optional, multi), Requesting for (single Slack user, optional)
  - **Sage also flagged these — check any that apply:** zero-to-many checkboxes from director-brain rules with one-line rationale each
- [ ] Director-brain rules in `src/config/request-patterns.yaml` — schema: `{ trigger: keyword|[keywords], suggest: [RecommendationName], reasoning: string }`
- [ ] Loader `src/lib/director-rules.ts` exports `matchRecommendations(parsedFields): Recommendation[]`
- [ ] Seed rules: webinar → registration email + social promo + graphics kit + post-event follow-up; conference/event → pre-event social + on-site graphics + booth collateral + post-event recap; product launch → press release + social series + sales enablement + landing page update
- [ ] Single Submit button; submission triggers US-005
- [ ] Unit tests: modal renders with various parsed-field combinations; seed rules produce expected recommendations
- [ ] Typecheck passes / tests pass

### US-005: Modal submission → Monday item + thread confirmation + alerts notification

**Description:** As Pearl staff, when I submit the request modal, I want Sage to (a) create a Monday item plus linked sub-items for any recommendations I checked, (b) post a customer-service-style confirmation reply on my original channel thread with clear next steps, and (c) post a one-line notification to `#mktg_incoming_requests` so marketing knows it landed.

**Acceptance Criteria:**
- [ ] Handler `src/handlers/view-submission.ts` receives `view_submission` events
- [ ] Reads `private_metadata` to recover `channelId` + `threadTs`
- [ ] Creates parent Monday item on the `00.` board with: Request Type, Deliverable, Audience, Deadline, Requester (Slack → Monday user via `slack-users.ts`), Requested Date (auto), Approvals (mapped to `multiple_person_mm2qzpq` People column), Additional Divisions Impacted (mapped to `dropdown_mm32cr4w`), Requesting For (optional), Division (from channel ID via `channels.yaml`), Status = "Not Started", Source = "Sage v2 (channel)"
- [ ] For each checked recommendation, creates a linked Monday sub-item with same Requester/Approvals/Division/Additional Divisions Impacted as parent
- [ ] On success: Sage posts a thread reply on the originating channel message in this format:
  ```
  Got it — tracking your request as REQ-{id}: <Monday link>

  *What happens next:*
  • Marketing will triage this and assign an owner. You'll see status updates posted here as it progresses.
  • Need to add a supporting doc or change something? Just @Sage in this thread.
  • Want to walk through it with marketing? <Schedule a call> ({marketingLeadCalendarUrl})

  @{approvers} — please review when you have a moment.
    [✅ Approve]   [✏️ Request changes]
  ```
  - The "Schedule a call" link is omitted gracefully if `marketingLeadCalendarUrl` is unset
  - The Approve / Request changes buttons trigger US-005's approval handlers (approval logic carries over from current `approval.ts`)
- [ ] **Also posts to `#mktg_incoming_requests`** (resolved from `channels.yaml` role=alerts) as a single top-level message:
  ```
  📥 New {Request Type} from {Requester} ({Division}): {Deliverable summary}
  • Due: {Deadline if set}
  • Approvers: {names}
  • <Monday link> · <Original thread>
  ```
  - This message is the root of marketing's coordination thread for this request (subsequent follow-ups post replies here, US-016)
  - Stores the alert message's `channel_id` + `ts` on the request record so US-016 can post follow-up replies to the same thread
- [ ] Stores `originating channel_id` + `originating thread_ts` + `alert channel_id` + `alert message ts` on the request record
- [ ] On Monday API failure: Sage posts an apology reply on the originating thread with the error ID, logs to `error-tracker.ts`, flags for retry. Alert message is not posted on failure.
- [ ] Unit tests stub Monday client; assert parent + sub-items created with correct field values, thread confirmation posted with the correct format, alert message posted with the correct format, persistence of channel/thread/alert metadata
- [ ] Typecheck passes / tests pass

### US-006: Requester-attribution helper used everywhere

**Description:** As any user querying Sage for Monday data, I want every item to show who requested it and when.

**Acceptance Criteria:**
- [ ] Helper `src/lib/format-monday-item.ts` exports `formatItemAttribution(item): string` → "Requested by [Name] on [Date]" with optional "requesting for [Name]" suffix
- [ ] Applied in: status.ts, search.ts, weekly-digest.ts, visibility-query.ts, lifecycle thread-reply composer (US-016)
- [ ] Handles unknown requesters gracefully ("Requested Apr 23 · requester not on file")
- [ ] Unit tests: normal case, proxy case, missing-requester case
- [ ] Typecheck passes / tests pass

### US-007: Channel → division lookup

**Description:** As Sage, I need to know each request's division so I can stamp the Monday item correctly and run division-scoped queries.

**Acceptance Criteria:**
- [ ] Module `src/lib/division-lookup.ts` exports `divisionForChannel(channelId): Division | null` reading from `src/config/channels.yaml`
- [ ] `Division` type union: `'BD' | 'P2' | 'CX/Core' | 'Corporate' | 'Product' | 'Marketing'`
- [ ] If `@Sage` arrives from a non-configured channel, US-001 rejects before this module is called
- [ ] Cached at process start; reload on file change in dev, on deploy in prod
- [ ] Unit tests: configured channel hit, missing channel returns null
- [ ] Typecheck passes / tests pass

### US-008: Status + visibility query handler (intake + alerts channels)

**Description:** As Pearl staff in a division channel, or as marketing leads in `#mktg_incoming_requests`, when I @Sage with "where's my request" or "what's open", I want a formatted reply in the same channel.

**Acceptance Criteria:**
- [ ] Handler `src/handlers/visibility-query.ts` covers intents: `my_open_requests`, `division_open_requests`, `recent_completions`, `find_deliverable`
- [ ] Query spec extracted via Claude Haiku: `{ scope: 'self' | 'division' | 'pearl-wide', division?: string, statusFilter?: string[], dateRange?: {start, end}, searchTerm?: string }`
- [ ] In a division channel, `scope: 'division'` defaults to that channel's division
- [ ] In the alerts channel, `scope: 'pearl-wide'` is the default — marketing leads need the cross-division view
- [ ] Calls `monday.ts` and formats with `formatItemAttribution` (US-006)
- [ ] For "show me everything" queries, the reply is short and points to the pinned Monday view link rather than dumping the full list
- [ ] Returns up to 10 items inline; "show more" button reveals up to 20 total
- [ ] Unit tests cover each intent + attribution + deliverable search + channel-scoped division default + alerts-channel-default-pearl-wide
- [ ] Typecheck passes / tests pass

### US-009: Request lifecycle event logging

**Description:** As Kat and maintainers, I need every modal-open, submission, abandonment, and lifecycle event logged so we can compute analytics.

**Acceptance Criteria:**
- [ ] Table `request_events` in Postgres (via `db.ts`): `id, user_id, channel_id, channel_role, event_type, intent, parsed_fields_json, recommendations_offered_json, recommendations_accepted_json, monday_item_id?, created_at`
- [ ] Events logged: `modal_opened`, `modal_submitted`, `modal_cancelled` (1-hour stale-modal sweep if Slack doesn't send the event), `clarifying_question_asked`, `clarifying_question_answered`, `lifecycle_reply_posted` (US-016), `alert_posted` (US-005), `approver_nudged_dm` (US-017), `calendar_link_offered`, `follow_up_received` (post-submission @mention)
- [ ] Helper `src/lib/event-log.ts` exports `logRequestEvent(event)` — non-throwing
- [ ] Unit tests: events written correctly; logging failure doesn't break the caller
- [ ] Typecheck passes / tests pass

### US-010: Weekly analytics digest (DM to maintainers)

**Description:** As Kat and Grant, I want a weekly Monday-morning DM with request analytics so I can see volume, turnaround, abandonment, and rule acceptance.

**Acceptance Criteria:**
- [ ] Composer `src/lib/weekly-digest.ts` building on existing `daily-digest.ts` patterns
- [ ] Sections: volume by type and division; turnaround per type (4-week rolling); abandonment % by type; recommendation acceptance rate per rule; top requesters; open-load by division; calendar-link click rate (proxy: how often the link surfaces); follow-up activity per request (avg follow-ups per request)
- [ ] Scheduled via existing cron to fire Monday 8am ET
- [ ] Delivered as DM to Kat AND Grant (internal maintainer reporting — distinct from the no-DM-for-staff rule)
- [ ] Recipient list is a config constant
- [ ] Dry-run: `npm run weekly-digest -- --dry-run` prints to stdout
- [ ] Unit tests with fixture data: each section renders correctly
- [ ] Typecheck passes / tests pass

### US-011: Light QC via channel @mention (intake channels only)

**Description:** As Pearl staff, when I @Sage with a short draft in my division channel asking "is this on-brand", I want the QC result back in the same thread with the AI disclaimer.

**Acceptance Criteria:**
- [ ] Existing `qc-runner.ts` runs when `channel-router.ts` classifies an intake-channel mention as `light_qc`
- [ ] Light QC is NOT available in the alerts channel — that channel is for marketing-side coordination, not content review
- [ ] Result returned as a thread reply on the original message: formatted grade + issue list + suggestions + AI disclaimer (US-002)
- [ ] For pub-bound content (user explicitly says "for publication" or LLM detects it), Sage instead opens the request modal routing to the triage-approval flow — pub-bound QC goes to triage, never back to the requester as self-service
- [ ] Unit tests: self-service QC returns result with disclaimer; pub-bound QC opens modal to triage flow; alerts-channel QC request is rejected with a redirect message
- [ ] Typecheck passes / tests pass

### US-012: Quick info via channel @mention (intake channels only)

**Description:** As Pearl staff, when I @Sage with a simple info question (logo, tagline, brand fact) in my division channel, I want the answer instantly with the disclaimer.

**Acceptance Criteria:**
- [ ] Existing `quick-info.ts` runs when `channel-router.ts` classifies an intake-channel mention as `info_lookup`
- [ ] Response wrapped with `withDisclaimer` (US-002)
- [ ] Quick info IS allowed in the alerts channel — marketing leads asking "what's our current logo URL" is a legitimate use case
- [ ] Disclaimer's "submit a request" line guides the user to their division channel: "@Sage with what you need in `#mktg_{your-division}_requests` and I'll open a request"
- [ ] Unit test: quick-info responses include disclaimer; alerts-channel quick-info works
- [ ] Typecheck passes / tests pass

### US-013: [DROPPED — replaced by channel-first architecture]

The original v1 channel intake was only in test (no production migration needed) and the prior v2 draft proposed DM intake. Both are superseded by US-001's channel @mention model. The existing `src/handlers/intake.ts` and tightly-coupled `conversation.ts` multi-turn state can be removed or left dormant; either way they're not wired to user-facing behavior after v2 ships.

### US-014: Proxy / "requesting for" submissions

**Description:** As Kat or anyone managing someone else's request, I want to submit on behalf of another staff member so the ticket reflects who actually needs the work.

**Acceptance Criteria:**
- [ ] Modal (US-004) has optional "Requesting for" field (Slack user single-select)
- [ ] On submit: if Requesting For is filled, Monday item's Requester field = that person; "Submitted by" = the actual submitter. Both render in attribution formatting (US-006).
- [ ] Visibility queries (US-008) group by Requester by default; filter for Submitted By
- [ ] Unit test: proxy submission creates item with correct Requester + Submitted By
- [ ] Typecheck passes / tests pass

### US-015: Channel pinned messages + topics

**Description:** As anyone joining a Sage-active channel, I want pinned context that explains how to use Sage there.

**Acceptance Criteria:**
- [ ] Each `#mktg_{division}_requests` channel has a pinned message (set manually) with: name (Sage), how to use it ("@Sage with what you need"), example prompts ("@Sage I need a webinar email", "@Sage where's my request from last week", "@Sage what's our logo URL"), AI disclaimer note, division-filtered Monday view link, calendar link
- [ ] `#mktg_incoming_requests` has a pinned message describing its role: "Sage posts new request alerts here. Marketing replies in the alert threads for internal coordination — Sage ignores anything that isn't @Sage. To run reports, @Sage with 'show me open BD requests', etc."
- [ ] Channel topic is set programmatically on Sage startup where the bot has `channels:manage` permission. Fallback: manual topic.
- [ ] If a user types `@Sage help` or `@Sage what can you do`, Sage replies in-thread with the detailed capabilities list (different copy per channel role)
- [ ] No first-touch tracking — pinned message + topic carry the orientation, not per-user state
- [ ] Unit tests: help command works; produces role-appropriate copy
- [ ] Typecheck passes / tests pass

### US-016: Lifecycle replies + free-form post-submission follow-ups

**Description:** As the requester (and the whole division watching the channel), when a Monday item changes status or gets a deliverable attached, I want Sage to post a reply on the original channel thread. As the requester, when I @Sage in my original thread with a follow-up (add a doc, change scope, request a call), I want Sage to forward it to the Monday item and confirm — without buttons.

**Acceptance Criteria:**
- [ ] Handler `src/handlers/monday-webhook.ts` receives Monday webhook events for status changes, column updates (deliverable, due date, owner, additional divisions), and update-comments on items in the `00.` board
- [ ] If the Monday plan does not support webhooks, fallback module `src/lib/monday-poller.ts` polls every 5 minutes for changed items in the last 6 minutes
- [ ] **Monday-driven replies (Sage → channel):** for each event, Sage looks up the request's stored `originating channel_id` + `originating thread_ts` and posts a reply formatted by event type:
  - Status change: "Status: Not Started → In Progress · {owner} assigned"
  - Deliverable attached: "Deliverable ready: {link}"
  - Due date change: "Due date moved to {new date}"
  - Owner change: "Reassigned to {owner}"
  - Additional divisions impacted updated: "Cross-division impact updated: {list}"
- [ ] **Calendar link re-surfacing:** if a status change moves the item to `Under Review` or `Stuck`, the lifecycle reply additionally includes: "If you'd like to walk through it with marketing: <Schedule a call> ({marketingLeadCalendarUrl})". No calendar link on Working/Completed/other transitions.
- [ ] **Alert-thread mirror replies:** for every Monday-driven reply posted on the originating thread, Sage also posts a one-line summary as a reply on the alert message in `#mktg_incoming_requests` (e.g., "Status → In Progress (April assigned)"). Keeps marketing's coordination thread current.
- [ ] **Free-form requester follow-ups:** when the requester @mentions Sage in the originating thread (US-001 detected it as a follow-up), Sage:
  - Parses the message + any attached files via Claude Haiku
  - Decides: `add_info` (default — text or file becomes a Monday update), `change_scope` (text rewrites a structured field on the Monday item, e.g., due date or deliverable description), `schedule_call` (offer the calendar link), or `status_question` (route to US-008)
  - For `add_info`: appends to the Monday item via `addMondayItemUpdate()`; if a file is attached, also adds the file URL to the Supporting Documents column. Replies in-thread: "Got it — added {summary} to your request."
  - For `change_scope`: confirms the change in-thread before applying it ("You want to move the due date from May 5 to May 12 — confirm?"), updates the Monday column on confirmation, posts a structured note to the Monday activity log
  - For `schedule_call`: replies with the calendar link inline. Logs `calendar_link_offered`.
  - For `status_question`: hands off to US-008 visibility-query handler scoped to that single Monday item
- [ ] **No Withdraw flow.** Withdraw is dropped from v2 — per Kat 2026-05-05, it doesn't happen in practice. Cancellation, when needed, is a marketing-side decision recorded on the Monday item; Sage does not offer self-service withdraw.
- [ ] **No buttons in the post-submission flow.** All requester follow-ups are free-form @mentions parsed by intent. Buttons exist only in the initial submission confirmation (Approve / Request changes for the approver flow) — not as a post-submission picker.
- [ ] If the originating message was deleted or the thread is no longer reachable, log to `error-tracker.ts` and skip; do not error
- [ ] Per-event de-dup: don't repost identical Monday events within 30 seconds (handles webhook retries)
- [ ] Unit tests: status change replies posted with correct copy; calendar link surfaces only on Under Review/Stuck; alert-thread mirror replies; free-form follow-up parses and routes correctly to each of the four handlers; missing thread skipped gracefully; de-dup works
- [ ] Typecheck passes / tests pass

### US-017: 48-hour approver nudge via DM

**Description:** As an approver, if I haven't acted on an approval request after 48 hours, I want a DM nudge with a deep-link back to the channel thread so I can approve from there.

**Acceptance Criteria:**
- [ ] Scheduler runs hourly, checks all requests in `pending_approval` status with approvers who haven't clicked Approve/Request changes
- [ ] For each approver still pending after 48 hours, Sage sends a single DM: "Reminder: {Requester} is waiting on your approval for {Request Type}: {Deliverable summary}. Approve in <thread permalink>."
- [ ] DM is sent at most once per approver per request — tracked in DB via `approver_nudged_at` timestamp
- [ ] Deep-link uses Slack's permalink format
- [ ] DM does NOT carry the AI disclaimer (notification, not AI inference)
- [ ] Logs `approver_nudged_dm` event (US-009)
- [ ] Unit tests: nudge fires after 48 hours, doesn't double-fire, deep-link correct, doesn't fire for already-approved/rejected
- [ ] Typecheck passes / tests pass

## Functional Requirements

- FR-1: All staff-facing Sage interaction is in-channel and requires `@Sage` mention. No ambient channel listening; no DM-based intake, info, or QC. The only DM use cases are (a) 48-hour approver nudges and (b) the maintainer weekly digest.
- FR-2: Multi-step data collection happens in modals, not message sequences. The only stateful exception is the bounded clarifying-question case (5-min TTL, single question) for genuinely unclear @mentions in intake channels.
- FR-3: The Monday `00.` board has an "Additional Divisions Impacted" multi-select dropdown column (created 2026-05-05, column ID `dropdown_mm32cr4w`) with labels: BD, P2, CX/Core, Corporate, Marketing, Product. The "Requesting Division" status column (`color_mm2q52zc`) likewise carries all six division labels. Sage writes to both columns on item creation. If either column is missing or a label is removed, Sage logs an error and falls back to omitting the affected field.
- FR-4: Every AI-authored response carries the disclaimer (US-002). Monday-sourced facts and lifecycle replies (US-016) do not.
- FR-5: Every modal submission produces a Monday item. Monday API failures are surfaced in-thread, not swallowed.
- FR-6: Every Monday item Sage creates has a non-null Requester field. Items without a resolvable requester are rejected at creation time.
- FR-7: Cross-user data isolation: `my` queries scope to the requester's Slack user ID; `division` queries scope to the channel's division.
- FR-8: Director-brain rules live in YAML, editable without a deploy.
- FR-9: Event logging (US-009) never blocks the main request flow — failures are swallowed and reported to error-tracker.
- FR-10: Every external API call (Slack, Monday, Anthropic) retries with exponential backoff, max 3 attempts.
- FR-11: All v2 intake lands on the `00.` board. Division is set as a column based on channel mapping (US-007). No per-division board routing.
- FR-12: Channel-to-division-and-role config (`src/config/channels.yaml`) is the source of truth for which channels Sage listens to and what role each plays. Adding a channel = config change + Slack-side channel creation; no code change.
- FR-13: The Withdraw flow is removed from the post-submission UX. There is no requester-facing self-service path to cancel a request.
- FR-14: The "Schedule a call with marketing" link surfaces only at submission confirmation and on Under Review / Stuck status transitions — not on every status change. Set via `marketingLeadCalendarUrl` config.
- FR-15: The marketing alerts channel (`#mktg_incoming_requests`) receives a one-line top-level message per new request and one-line replies on each follow-up. Marketing's own conversation in those reply threads is invisible to Sage (no @mention = no listening).

## Non-Goals (Out of Scope)

- **DM-based request intake or QC or info lookups** — superseded by channel-only model
- **Ambient channel listening (no @mention)** — Sage only acts on explicit `@Sage` mention
- **Per-division Monday boards** — all v2 intake on the `00.` board
- **Creating or restructuring Monday boards** — Sage works with existing boards
- **True multi-turn conversational intake** — multi-step collection happens in modals only
- **Non-Pearl users** — Sage only responds to Pearl Slack workspace members in configured channels
- **Per-user OAuth for Google/Monday** — everything runs with org-level credentials
- **A web dashboard** — analytics via weekly digest DM and Monday boards themselves
- **Auto-assignment of Monday items** — triage stays a human decision
- **Cross-posting requests across channels** — a request lives in one channel; cross-division impact is captured as a Monday column
- **Self-service withdraw** — removed; no requester-facing cancellation flow
- **Buttons for post-submission follow-ups** — free-form @mention only
- **A Marketing intake channel** — marketing-internal asks stay in marketing's existing channels for v1 (see Still Open)

## Technical Considerations

- **Stack:** TypeScript, Slack Bolt (socket mode), Anthropic SDK, Postgres, Railway. Matches current Sage.
- **Reuse:** `monday.ts`, `claude.ts`, `quick-info.ts`, `brand-info.ts`, `qc-runner.ts`, `status.ts`, `slack-users.ts`, `notifications.ts`, `error-tracker.ts`, `daily-digest.ts`, `approval.ts` (Approve/Request-changes button handlers carry over).
- **Avoid for channel handler:** `conversation.ts` multi-turn state — single-shot intent classification + modal for any multi-step collection.
- **LLM cost:** Classification on Haiku (~$0.25/Mtok); modal pre-fill parsing on Sonnet (~$3/Mtok). Per-request cost well under $0.01.
- **Slack constraints:** `trigger_id` valid 3s; modal max 25 blocks (recommendation list capped at 8 with overflow); `view_submission` payload size limit on large field values.
- **Monday webhook capability:** verify Pearl's plan supports webhooks for the events in US-016. If not, polling fallback ships at a 5-minute lag.
- **Channel-config hot reload:** dev = watch `channels.yaml`; prod = reload on deploy.
- **Calendar link config:** `marketingLeadCalendarUrl` in env. If unset, Sage gracefully omits the "Schedule a call" line.
- **Deploy safety:** per `CLAUDE.md`, no pushes during business hours unless critical.
- **Observability:** every request flows through the event log (US-009); errors → `error-tracker.ts`.

## Success Metrics

- 80%+ of Pearl staff who submit any marketing request do so via Sage v2 within 30 days of launch
- Modal abandonment rate below 15% after 4 weeks of calibration
- Director-brain recommendation acceptance rate ≥ 30%; rules below 10% get pruned
- Every Monday item created by Sage has a non-null Requester field (FR-6)
- Time from @mention to modal-open under 5 seconds at p95
- Zero cross-channel data leaks in visibility queries
- Visibility queries return in under 3 seconds at p95
- Lifecycle replies post within 60 seconds of the Monday change at p95 (webhook) or within 6 minutes (polling)
- Alert-channel notifications post within 10 seconds of Monday item creation at p95
- 48-hour approver nudges deliver on-time ≥ 95%
- Weekly digest delivers on schedule ≥ 95% of weeks
- Free-form post-submission follow-ups route to the correct handler ≥ 90% of the time (measured against a manually-labeled sample of 50)

## Resolved Decisions

- **Architecture:** channel-first, not DM-first. Each requesting division has its own `#mktg_{division}_requests` channel + a single `#mktg_incoming_requests` alerts channel for marketing-internal coordination. Decided 2026-05-05.
- **Channel naming:** `#mktg_{division}_requests` (underscores). Created channels: `mktg_bd_requests`, `mktg_p2_requests`, `mktg_core_requests`, `mktg_corporate_requests`, `mktg_product_requests`, `mktg_incoming_requests`.
- **Trigger model:** explicit `@Sage` mention required for every action — no ambient listening; additions to existing requests require @mention again.
- **Divisions (v2):** BD, P2, CX/Core, Corporate, Product, Marketing. Five have intake channels; Marketing does not (deferred — see Still Open).
- **Intake board:** existing `00.` board.
- **Approvals:** in-thread Approve / Request changes buttons in the submission confirmation. 48-hour DM nudge to non-responsive approvers (US-017).
- **Withdraw:** dropped from v2. No requester-facing self-service cancel.
- **Lifecycle visibility:** Monday → channel thread replies (US-016) for the requester; alert-thread mirror replies for marketing.
- **Calendar link:** `marketingLeadCalendarUrl` surfaces in submission confirmation and on Under Review / Stuck status transitions.
- **Confirmation reply tone:** explicit next-steps + how to interact ("Just @Sage in this thread"). Customer-service framing, not just receipt.
- **Pinned channel orientation:** each channel gets a pinned message + topic. Different copy for intake vs. alerts roles.
- **Weekly digest recipients:** Kat + Grant via DM. Internal maintainer reporting; distinct from the no-DM-for-staff rule.
- **DMs are restricted to:** (a) 48-hour approver nudges, (b) maintainer weekly digest. Nothing else.
- **Triage thread per request:** dropped. Marketing coordinates via reply threads on the alerts-channel notification (where Sage doesn't listen) and via Monday item updates.
- **Post-submission follow-up UX:** free-form @mention parsing, no buttons. Four routed intents: add_info, change_scope, schedule_call, status_question.

## Still Open

- **Marketing intake channel — deferred.** Marketing-internal tasks currently live in random per-staff lists. A future `#mktg_marketing_requests` channel could capture them through the same intake flow, giving the team consolidated visibility. Revisit after v2 has been running for a quarter.
- **Privacy escape valve for sensitive request types** (HR-adjacent, exec comms, personnel-related). Channel-first means every request is visible to the division. A future private intake path may be needed; revisit if a request type comes up that obviously needs it.
- **Notification preferences** — opt-out command for the weekly digest (likely v1.1, not v1).
- **Light QC vs. pub-bound QC detection** — LLM classification may need a user override ("this is for publication") to avoid false negatives.
- **Rule pruning UX** — who reviews the weekly recommendation-acceptance report and prunes? Probably Kat; automate the report but not the pruning.
- **Webhook vs. polling for Monday lifecycle events** — verify webhook capability on the current Monday plan; if absent, the 5-minute polling fallback ships in v1 and webhook upgrade is a v1.1 task.
