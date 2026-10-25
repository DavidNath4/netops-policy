# Requirements Document — Notifications (Bell + Email) · PLANNING / DRAFT

> **STATUS: DRAFT — UNDER DISCUSSION, NOT SCHEDULED FOR NEAR-TERM DEVELOPMENT.**
>
> This document is a **planning capture only**. It records the agreed assessment
> and the recommended direction so the idea is not lost, NOT an approved build.
> Nothing here is implemented, and no code, schema, migration, or env variable in
> this spec exists yet in the codebase.
>
> Before any implementation starts, this draft MUST be reviewed and explicitly
> approved, the open questions in the final section MUST be resolved, and the
> acceptance criteria MUST be re-confirmed against the then-current code. Treat
> every "SHALL" below as a *proposed* requirement pending that approval.
>
> Current reality at the time of writing (do not mistake for delivered behavior):
> - The header **bell** (`app/components/layout/AppHeader.vue` +
>   `NotificationModal.vue`) shows **hardcoded dummy data**; `notificationCount`
>   is a fixed `ref(3)`. The code comments say it is out of scope for the current
>   phase.
> - The profile **"Notification to email" toggle** (`ProfileModal.vue`) is a
>   **UI-only `ref(true)`** that is never persisted.
> - There is **no** notifications table, **no** notifications service/endpoint,
>   and **no** email/SMTP infrastructure anywhere in the repo.

## Introduction

This spec plans two related, currently-placeholder features:

1. **In-app notification bell** in the top navigation bar — a feed of recent,
   relevant activity with an unread indicator.
2. **Email notifications** — an opt-in switch in the profile box that, when a
   backend exists, would send selected high-value events to the user's email.

The application is already the **audit system of record**: every
security- and configuration-relevant event is recorded in `audit_logs`
(modules `AUTH`, `USER`, `ACL`, `ROUTE`, `TIME_RANGE`), each with an actor
snapshot, status, correlation id, and timestamp. The recommended design treats
notifications as a **derived view of that existing audit trail**, mirroring how
the Dashboard is derived from `audit_logs` — so the bell needs no new event
source, only a way to present events safely and track "seen".

Related specs:

- **log-trail/** — the `audit_logs` master trail that is the source of every
  notification; the two-row AUTH model and the redaction rules.
- **rbac-permissions/** — the data-driven permissions that MUST filter which
  events a given user may see in the bell.
- **dashboard/** — the precedent for a read-only, permission-aware view derived
  from `audit_logs` (e.g. the Recent Config Changes widget's safe projection).
- **general/** — the API envelope, config/`EnvSchema` validation posture (email
  config would follow the optional-iTop all-or-nothing pattern), and the
  secret-exclusion rules.
- **authentication/** — the self-scoped AUTH events (new sign-in, MFA change)
  that a user should see about their own account regardless of role.

### Scope (proposed)

In scope (when approved): the bell feed and its unread tracking, the
permission-aware filtering of events per role, the persisted email-preference
toggle, and — as a later, optional phase — the actual email delivery of
high-value events. Out of scope: real-time push/websockets, per-device push
notifications, SMS/Slack/Teams channels, and any notification that exposes
device configuration detail or a credential.

## Glossary (proposed)

- **Notification_Feed**: The list of recent, permission-filtered events shown in
  the header bell. In the recommended model it is derived live from `audit_logs`,
  not a stored per-user copy.
- **Last_Seen**: A per-user timestamp marking when the user last opened the bell;
  the unread count is the number of relevant events newer than it.
- **Email_Preference**: A per-user boolean (the profile toggle) controlling
  whether that user receives email notifications; persisted, default off.
- **Relevant_Event**: An `audit_logs` row a given user is permitted to see in
  their feed, decided by that user's effective permissions (see Requirement 4).
- **Notification_Service**: The proposed server component that would read the
  audit trail, apply the permission filter, map to a safe shape, and (later)
  dispatch emails. It would own no new source of truth beyond the small
  preference/seen state.

## Design decision: two candidate models

The single most important open decision. It determines whether any new table is
needed. **Recommendation: start with Model A.**

### Model A — Derived feed (RECOMMENDED, minimal schema)

The bell shows the N most recent `Relevant_Event`s read straight from
`audit_logs`, filtered per permission and mapped to a safe shape. "Unread" is a
single `Last_Seen` timestamp per user; the count is the number of relevant
events with `created_at > last_seen_at`.

- Pros: cheapest; no data duplication; consistent with the Dashboard's
  audit-derived approach; needs at most a tiny amount of new per-user state.
- Cons: no per-item "mark as read"/dismiss; cannot represent a non-audit
  notification (e.g. a system maintenance notice).

### Model B — Materialized notifications (fan-out, full table)

Each event writes one `notifications` row per recipient, supporting per-item
read/dismiss, non-audit notices, and per-notification email delivery state.

- Pros: fully flexible and future-proof.
- Cons: fan-out writes (one operation → many rows); more code and more failure
  surface; must be careful never to copy sensitive detail into a second table.

This draft is written against **Model A**; the Model-B schema is captured in
Requirement 7 only as the fallback if per-item read or reliable email later
proves necessary.

## Requirements (proposed — pending approval)

### Requirement 1: In-app notification bell (replace the dummy feed)

**User Story:** As an operator, I want the header bell to show real recent
activity I'm allowed to see, so that I can notice relevant changes without
opening the Log Trail.

#### Acceptance Criteria

1. THE API_Layer SHALL expose `GET /api/notifications` (auth-only, no feature
   permission) returning the most recent `Relevant_Event`s mapped to a safe
   shape plus an `unreadCount`, through the standard `{ success, data }` envelope.
2. THE Notification_Service SHALL derive the feed from `audit_logs` only (no new
   event source) and SHALL map each row to a safe projection — never a raw row,
   never a JSONB payload, never a credential — exactly as the Dashboard's Recent
   Config Changes widget does.
3. THE Frontend SHALL replace the hardcoded `NotificationModal.vue` list and the
   `AppHeader.vue` `notificationCount = ref(3)` with values from this endpoint.
4. THE feed SHALL be ordered newest-first and bounded to a small server-side
   limit (e.g. the latest ~15), with server-side pagination if a longer list is
   ever shown.

### Requirement 2: Unread tracking (Last_Seen)

**User Story:** As an operator, I want the unread badge to clear when I open the
bell, so that it reflects only activity I haven't looked at.

#### Acceptance Criteria

1. THE unread count SHALL be the number of `Relevant_Event`s whose `created_at`
   is newer than the user's `Last_Seen` timestamp.
2. THE API_Layer SHALL expose `POST /api/notifications/seen` (auth-only) that
   sets the caller's `Last_Seen` to now, driving the unread count to zero.
3. WHERE the user has never opened the bell (`Last_Seen` is null), THE unread
   count SHALL be computed against a sensible default window rather than counting
   the entire history.

### Requirement 3: Email preference toggle (persisted)

**User Story:** As a user, I want my "Notification to email" choice remembered,
so that the switch reflects my real preference instead of resetting each visit.

#### Acceptance Criteria

1. THE API_Layer SHALL expose `GET /api/notifications/prefs` and
   `PATCH /api/notifications/prefs` (auth-only) reading/writing the caller's
   `Email_Preference`; the toggle in `ProfileModal.vue` SHALL be wired to these
   instead of the current local `ref(true)`.
2. THE `Email_Preference` SHALL default to **off** and SHALL be scoped to the
   caller's own account only.
3. Persisting the preference SHALL NOT, by itself, send any email — delivery is
   a separate, later phase (Requirement 6) and is independently gated by server
   configuration.

### Requirement 4: Permission-aware filtering per role

**User Story:** As a security owner, I want the bell to show each user only what
their role permits, so that notifications never become a side channel that leaks
activity a user cannot otherwise see.

The filter MUST be enforced on the SERVER from the user's effective permissions
(rbac-permissions/), never on the client, and never by branching on a role id.

#### Acceptance Criteria

1. THE Notification_Service SHALL include an `ACL` / `ROUTE` / `TIME_RANGE` event
   in a user's feed ONLY WHERE that user holds the matching module `*_SHOW`
   permission.
2. THE Notification_Service SHALL include a `USER` / administration event ONLY
   WHERE the user holds `ADMINISTRATION_SHOW`.
3. THE Notification_Service SHALL include an `AUTH` event that concerns the
   user's OWN account (e.g. a new sign-in, an MFA change) for that user,
   regardless of role — including a user with `role_id = null`.
4. A user with `role_id = null` (common access) SHALL see only self-account
   events (criterion 3) and SHALL NOT see other users' ACL/ROUTE/USER activity.
5. THE per-role outcome SHALL be:
   - **NOC** (`ACL/ROUTE _SHOW,_ADD`): ACL/ROUTE/TIME_RANGE activity + own AUTH.
   - **L2_ENGINEER** (`ACL/ROUTE _SHOW,_ADD,_DELETE`): ACL/ROUTE/TIME_RANGE
     activity + own AUTH.
   - **ADMINISTRATOR** (all + `ADMINISTRATION_*`): the above + USER/admin events.
   - **role_id = null**: own AUTH events only.

### Requirement 5: Safety and non-leakage

**User Story:** As a security administrator, I want notifications to be as safe
as the audit trail they come from, so that no secret or device detail is exposed.

#### Acceptance Criteria

1. THE notification feed and any email SHALL use a safe projection (title +
   short, non-secret summary); they SHALL NOT include a raw `audit_logs` row, any
   JSONB payload, a rendered device command with addresses beyond what the Log
   Trail already shows, or any credential.
2. THE server SHALL enforce every permission filter (Requirement 4) regardless of
   what the client requests or displays.
3. THE feature SHALL add no endpoint that creates, edits, or deletes an audit
   row; it only reads the trail and writes the small `Last_Seen` /
   `Email_Preference` state.

### Requirement 6: Email delivery (LATER / OPTIONAL phase)

**User Story:** As a user who opted in, I want selected high-value events emailed
to me, so that I'm informed even when I'm not in the app.

> This requirement is the **most deferred** part of the plan. Recommendation:
> build Requirements 1–4 first; treat email as a separate opt-in phase, or drop
> it entirely if in-app notifications prove sufficient for an internal tool.

#### Acceptance Criteria (proposed)

1. THE email feature SHALL be gated by server configuration validated in the Zod
   `EnvSchema` (e.g. `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`,
   `SMTP_FROM`), following the **all-or-nothing, optional** posture of the iTop
   config: fully unset means the feature is off and the app still boots; a
   partial configuration SHALL halt startup. No SMTP secret SHALL appear in
   `runtimeConfig.public`.
2. WHERE email is configured AND a user's `Email_Preference` is on, THE
   Notification_Service SHALL send email ONLY for a small, agreed set of
   high-value events (candidates: repeated failed logins, a user's role/status
   change, an MFA device change) — NOT for every ACL/ROUTE operation.
3. THE email send SHALL be **best-effort**: a delivery failure or timeout SHALL
   NOT fail or alter the originating operation (the same posture as best-effort
   audit writes), and SHALL be bounded by a timeout.
4. THE email body SHALL be minimal and free of secrets/device detail (e.g.
   "Role on account X changed by Y at Z"), honoring Requirement 5.
5. THE application SHALL never log SMTP credentials.

### Requirement 7: Data model (proposed — depends on the chosen model)

**User Story:** As a developer, I want the smallest schema that supports the
chosen model, so that we don't over-build before the feature is approved.

Any new table/column here is a PROPOSAL and MUST go through the committed
migration flow (`db:generate` → `db:migrate`) and be reflected in the dev
database — never mutated out of band (AGENTS.md).

#### Acceptance Criteria (proposed)

1. **Model A (recommended):** THE schema SHALL add one small table
   `user_notification_prefs` — `user_id` (uuid PK, FK → `users.user_id`,
   ON DELETE CASCADE), `last_seen_at` (timestamptz, nullable — unread tracking),
   `email_enabled` (boolean, not null, default false — the profile toggle),
   `updated_at` (timestamptz, not null, default now). No per-notification row is
   stored; the feed is derived from `audit_logs`. *(Alternative A1: a single
   `notifications_last_seen_at` column on `users` plus an `email_enabled` column,
   if a separate table is judged unnecessary.)*
2. **Model B (fallback only, if per-item read or reliable email is later
   required):** THE schema SHALL add a `notifications` table — `id` (uuid PK),
   `user_id` (recipient FK → `users`, ON DELETE CASCADE), `category`
   (`ACL`/`ROUTE`/`TIME_RANGE`/`USER`/`AUTH`/`SYSTEM`), `title`, `body`
   (non-secret), `correlation_id` (nullable), `audit_id` (nullable FK →
   `audit_logs.id`, ON DELETE SET NULL), `read_at` (nullable), `created_at` —
   with indexes on `(user_id, created_at)` and `(user_id, read_at)` — PLUS the
   `user_notification_prefs` table from criterion 1 for email preference. Model B
   writes one row per recipient per event (fan-out) and MUST still obey
   Requirement 5 (no sensitive detail copied into the row).
3. Whichever model is chosen, THE schema change SHALL be the smallest that
   satisfies the approved requirements; Model B SHALL NOT be built unless a
   concrete need (per-item read / reliable email) is confirmed.

## Non-Functional Requirements (proposed)

### Security

1. THE feature SHALL enforce all permission filtering on the server and SHALL
   exclude secrets, credentials, SQL, stack traces, and device-config detail from
   every notification and email.
2. THE feature SHALL keep all SMTP secrets server-side only.

### Reliability

1. Email delivery (if built) SHALL be best-effort and time-bounded and SHALL
   never block or fail the originating operation.

### Maintainability

1. THE feed SHALL reuse the existing audit read/projection path where possible
   rather than duplicating event logic, and SHALL derive types from shared Zod
   schemas (no parallel hand-written interfaces).

## Open questions to resolve before development

1. **Model A or Model B?** (Recommendation: A.) Is per-item "mark as read" or a
   non-audit "system notice" actually needed? If not, A is enough.
2. **Is email in scope at all?** For an internal tool with active UI users, the
   bell may suffice. If email stays, which exact events warrant it?
3. **role_id = null behavior:** confirm that common-access users should see only
   their own AUTH events and nothing else.
4. **Feed window/limit:** how many recent events, and what default window for a
   never-opened bell?
5. **Delete-event visibility for NOC:** NOC lacks `*_DELETE` but holds `*_SHOW`
   — should delete events still appear in its feed as information? (Default
   proposal: yes, because it can already SHOW them in the Log Trail.)

## Out of Scope (for this plan)

1. Real-time push / websockets / server-sent events (the feed is pull-on-open).
2. Channels other than in-app + email (no SMS, Slack, Teams, webhooks).
3. Any notification that exposes device configuration state or a credential.
4. Admin-authored broadcast/system notices (would require Model B; not planned).
