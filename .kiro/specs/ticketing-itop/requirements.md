# Requirements Document — iTop Ticketing Integration

## Introduction

This spec is the authoritative document for the **iTop ticket integration**: a
read-only lookup against an iTop ITSM database that gates every ACL/Route add and
delete behind a real, selected change ticket, and the two admin "Test Connection"
diagnostics (iTop and n8n).

iTop is a **foreign, read-only MariaDB** reached directly from the Nitro server
with the `mysql2` driver. It is **not** part of the Drizzle schema and the
application never writes to it. The engineer searches iTop, previews the matching
ticket, and selects it; the selected `ref` fills the required `changeTicket`
field on the ACL/Route form. On execute, the server re-verifies the ticket exists
before anything runs.

Related specs:

- **general/** — system overview, envelope + `ErrorCode` union, config/startup.
- **netops-policy-manager/** — the ACL/ROUTE add/delete forms this integration gates.
- **n8n-integration/** — the execute path and the Test n8n button that sits beside Test iTop.
- **user-management/** — the Administration page the two Test buttons live on.
- **rbac-permissions/** — `ADMINISTRATION_MANAGE`, which gates the test endpoints.

### Scope

In scope: iTop ticket search + preview, the required-change-ticket gate on the
four add/delete forms, the server-side ticket-existence guard on execute, the two
admin Test Connection endpoints, the read-only never-throw iTop client, and the
optional-config/boot posture. Out of scope: pushing config to devices, persisting
any iTop/ticket data in the application database, adding a new RBAC permission for
search/preview, and the Log Trail / `changeTicket` audit storage (unchanged).

## Glossary

- **Itop_Client**: The single server component that talks to iTop (`server/network/itop-client.ts`): a lazily-created `mysql2` pool, SELECT-only, parameterized, never-throwing.
- **Itop_Service**: The business layer (`server/services/itop.service.ts`) holding the `finalclass` resolver and the row → Zod-shape mappers; it never returns a raw DB row.
- **finalclass**: The iTop class-table-inheritance discriminator on the parent `ticket` row that names the concrete subclass (`UserRequest`, `Incident`, `Problem`, `Change`, `NormalChange`, `RoutineChange`, `EmergencyChange`).
- **changeTicket**: The required change-ticket reference on each ACL/Route add/delete, set to the selected ticket `ref` (e.g. `C-035919`). Validated by the shared `ChangeTicketSchema` (trimmed, 1..64 chars).
- **ItopUnreachableError**: The single error type the Itop_Client raises for any failure (unconfigured, unreachable, timeout, query error); it carries no SQL/connection detail.

## Requirements

### Requirement 1: iTop ticket search

**User Story:** As a network engineer, I want to search iTop tickets by ref or title before I generate a change, so that I can find the exact change ticket to attach.

#### Acceptance Criteria

1. WHEN an authenticated engineer submits a non-empty query on an ACL/Route add or delete page, THE Itop_Service SHALL search the parent `ticket` table by `ref` and `title` (case-insensitive substring, `%q%` bound as a parameter) across ALL ticket types and return at most `limit` summaries, without filtering by status.
2. THE search request body (`ItopTicketSearchSchema`) SHALL be `{ q, limit }` where `q` is trimmed, 1..64 chars, and `limit` is a positive integer coerced and capped at 50 (default 20).
3. THE search SHALL query only the parent `ticket` table (no joins) using `?` placeholders, bounded by the iTop timeout, and return `ItopTicketSummary[]` (`ref`, `title`, `type` from `finalclass`, `operationalStatus`, `startDate`, `endDate`).
4. IF the query is empty, longer than 64 chars, or missing, THEN THE API_Layer SHALL reject with `VALIDATION_ERROR` and SHALL NOT touch iTop.
5. IF iTop is unconfigured, unreachable, or times out, THEN THE `POST /api/itop/tickets/search` endpoint SHALL return `ITOP_UNREACHABLE` (HTTP 502) with a safe message and SHALL NOT surface SQL, stack, connection string, or credentials.

### Requirement 1a: My ongoing tickets quick-pick

**User Story:** As a network engineer, I want to see my own ongoing tickets under the search box, so that I can attach one directly without searching.

#### Acceptance Criteria

1. WHEN the ticket picker opens, THE client SHALL call `GET /api/itop/tickets/mine` and render the returned tickets as a quick-pick list under the search box; selecting one SHALL feed the SAME preview flow as a search result (including the ownership/status advisory warnings of Requirement 2a).
2. THE `GET /api/itop/tickets/mine` endpoint SHALL be auth-only (no new RBAC permission) and SHALL derive the iTop login SERVER-SIDE from the authenticated user's `username` (which equals `priv_user.login`); the client SHALL NOT supply the login.
3. THE Itop_Service SHALL return the engineer's tickets whose `operational_status = 'ongoing'` AND whose `ticket.agent_id` resolves (via `priv_user.contactid`) to a `priv_user.login` matching the username case-insensitively, ordered newest first (`start_date` desc, then `id` desc), capped at a safe limit, as `ItopTicketSummary[]`.
4. WHERE the authenticated user has no `username`, THE service SHALL return an empty list WITHOUT querying iTop; WHERE the engineer has no ongoing assigned tickets, it SHALL return an empty list.
5. THE client SHALL show at most ~3 rows before the list scrolls, and SHALL treat the list as a convenience: a load failure SHALL be silent and SHALL NOT block search (the quick-pick list is simply hidden/empty).
6. IF iTop is unconfigured, unreachable, or times out, THEN the endpoint SHALL return `ITOP_UNREACHABLE` (HTTP 502) with a safe message and SHALL NOT surface SQL, stack, connection string, or credentials.

### Requirement 2: iTop ticket preview

**User Story:** As a network engineer, I want to preview a selected ticket's detail before attaching it, so that I confirm it is the right change.

#### Acceptance Criteria

1. WHEN an engineer selects a ticket `ref` (`ItopTicketRefSchema`, `{ ref }` trimmed 1..64), THE Itop_Service SHALL fetch that single `ticket` row by its indexed `ref`, resolve the one type-specific detail table from `finalclass`, resolve caller/organization names via separate PK `IN (?)` lookups, resolve the assigned agent's login(s), and return an `ItopTicketDetail` (summary + resolved caller name/email + organization name + a per-type detail block + description + `ownerLogins`).
2. THE preview SHALL return only mapped, whitelisted fields — never a raw DB row.
3. THE preview SHALL pass every iTop-sourced string (title, description, caller/org names, every detail-block field) as plain text; the UI SHALL render ALL of them escaped (`{{ }}`), never via `v-html` or any raw-HTML sink, because iTop rich-text fields may contain HTML/script.
4. IF no ticket matches the `ref`, THEN THE `POST /api/itop/tickets/preview` endpoint SHALL return `NOT_FOUND`.
5. IF iTop is unconfigured, unreachable, or times out, THEN the preview endpoint SHALL return `ITOP_UNREACHABLE` (HTTP 502) with a safe message.

### Requirement 2a: Advisory ownership and status warnings on ticket select

**User Story:** As a network engineer, I want to be warned when I pick a ticket that is not assigned to me or that is no longer ongoing, so that I notice a likely mistake while still being able to proceed when I mean to.

These are **advisory warnings only**: they appear in the ticket preview before the engineer confirms "Use this ticket", and they NEVER block selection or the subsequent generate/execute. They apply uniformly to every feature that attaches a change ticket (ACL add, ACL delete, Route add, Route delete) because all four use the shared ticket picker.

#### Acceptance Criteria

1. THE Itop_Service SHALL resolve the ticket's assigned-agent login(s) from `ticket.agent_id` via `priv_user.contactid = agent_id` (selecting non-empty `priv_user.login`), returning ALL matching logins as `ownerLogins` (one contact may map to several `priv_user` rows). WHERE the ticket has no agent (`agent_id` null or `0`) or no linked account, `ownerLogins` SHALL be `[]`.
2. `ticket.agent_id` (the assigned engineer) — NOT `caller_id` (the requester/reporter) — SHALL be the owner compared for the ownership warning.
3. WHEN a ticket is previewed AND the signed-in user's `username` is set AND `ownerLogins` is non-empty AND no entry of `ownerLogins` equals that username compared case-insensitively (trimmed), THE ticket picker SHALL show an ownership warning naming the iTop owner(s). WHERE the username is absent or `ownerLogins` is empty, no ownership warning SHALL be shown (warn only on a positive mismatch).
4. WHEN a ticket is previewed AND its `operationalStatus` is any value other than `ongoing` (the valid iTop values are `closed`, `ongoing`, `resolved`), THE ticket picker SHALL show a status warning naming the current status. WHEN `operationalStatus` is `ongoing`, no status warning SHALL be shown.
5. THE warnings SHALL be informational (dismissible by proceeding): "Use this ticket" SHALL stay enabled regardless of either warning, and confirming SHALL attach the ticket exactly as before.

### Requirement 3: finalclass → detail-table mapping

**User Story:** As a developer, I want a single resolver from `finalclass` to the right detail table, so that each ticket type maps correctly without branching on the ref prefix.

The resolver (`resolveClass`) is driven by `finalclass`, not the ref prefix.

#### Acceptance Criteria

1. THE resolver SHALL map `UserRequest` → `ticket_request`, `Incident` → `ticket_incident`, `Problem` → `ticket_problem`, and `Change` / `NormalChange` / `RoutineChange` / `EmergencyChange` → the reserved-word table `` `change` `` (always backticked).
2. THE change-detail query SHALL read the base change row from `` `change` `` and LEFT JOIN `change_normal` so `acceptance_comment` resolves for `NormalChange` while the other change subtypes return a null `acceptance_comment`.
3. WHERE `finalclass` is unknown or unmatched, THE resolver SHALL return type `Unknown` with no detail table, and the preview SHALL still return the parent summary + description with an empty detail block (defensive, never failing).
4. THE caller shown in the preview header SHALL be `ticket.caller_id` for `UserRequest`/`Incident`/`Problem` and the change row's `requestor_id` for the change types, resolved through `contact.name` / `contact.email`.
5. THE parent `ticket.operational_status` (returned as `operationalStatus`) SHALL be distinct from the subtype `detail.status`; both SHALL be returned.

### Requirement 4: Per-type detail-block column mapping

**User Story:** As an auditor, I want each ticket type's relevant fields surfaced, so that the preview is informative across types.

The `ItopTicketDetailBlockSchema` fields map to iTop columns as below. The column
names were confirmed against the live iTop schema (the Itop_Client selects only
these columns); fields absent on a given table stay `undefined`.

#### Acceptance Criteria

1. FOR `UserRequest` (`ticket_request`) and `Incident` (`ticket_incident`), THE Itop_Service SHALL populate `status`, `impact`, `priority`, `urgency`, `origin`, `resolutionCode` (from `resolution_code`), and `solution`.
2. FOR `Problem` (`ticket_problem`), THE Itop_Service SHALL populate `status`, `impact`, `priority`, and `urgency` only (iTop's problem table has no `origin` / `resolution_code` / `solution`).
3. FOR the change types (`` `change` ``), THE Itop_Service SHALL populate `status`, `impact`, `reason`, `outage`, `fallback`, and `acceptanceComment` (the last from `change_normal` for `NormalChange`).
4. THE detail block SHALL be one optional-field object (not a discriminated union), so the UI renders whatever fields are present without per-type template branches.

> Note: The standard-iTop column names for additional change-subtype fields
> (supervisor/manager ids, acceptance_date for `RoutineChange`/`EmergencyChange`)
> are **(unverified against the live iTop schema)** and are intentionally not
> selected; only the columns listed above are read today.

### Requirement 5: Read-only, never-throwing iTop client

**User Story:** As a security administrator, I want all iTop access to be SELECT-only and bounded, so that it can never mutate iTop or hang the application.

#### Acceptance Criteria

1. THE Itop_Client SHALL lazily create a `mysql2` pool from `ITOP_DATABASE_URL`, returning no pool (and reporting "not configured") when the variable is unset.
2. THE Itop_Client SHALL issue SELECT statements only, bind every input as a `?` placeholder, and SHALL NOT enable `multipleStatements`.
3. THE Itop_Client SHALL bound every operation with an authoritative whole-operation `Promise.race` deadline (connection acquire + query) from `ITOP_TIMEOUT_MS`, not relying on the pool `connectTimeout` or the driver per-query timeout alone.
4. THE Itop_Client SHALL never throw a credential-bearing or SQL-bearing error upward; every failure SHALL normalize to `ItopUnreachableError`, and the server SHALL log only safe driver fields (name/code/errno/sqlState/message), never the connection string or password.
5. THE Itop_Client SHALL pass PK id arrays to `IN (?)` lookups WRAPPED as `[ids]` (for `connection.query` array expansion) and SHALL short-circuit to an empty result when the id array is empty (because `IN ()` is invalid SQL).

### Requirement 6: Required change ticket and button gating

**User Story:** As a security administrator, I want every ACL/Route change tied to a real ticket, so that no change can run without one.

#### Acceptance Criteria

1. THE `changeTicket` field SHALL be REQUIRED on ACL add/delete and Route add/delete (the shared `ChangeTicketSchema`, bounded 1..64), flowing through `AclAddSchema`/`AclDeleteSchema`/`AclPreviewSchema`/`AclExecuteSchema` and the Route equivalents.
2. WHEN an engineer selects a ticket in the picker, THE form SHALL set `changeTicket = ticket.ref`.
3. WHILE no ticket is selected, THE Generate and Execute buttons SHALL stay disabled on all four forms, so no preview or execute can run without a selected ticket.
4. THE existing `changeTicket` audit behavior SHALL remain unchanged (the selected `ref` flows into the already-audited field; Log Trail code is not touched).

### Requirement 7: Server-side ticket-existence guard on execute

**User Story:** As a security administrator, I want the server to confirm the supplied change ticket actually exists in iTop before any ACL/Route add or delete runs, so that a direct API call cannot execute against a fake but well-formed ticket ref.

This is defense-in-depth behind the UI gate: a direct API call could send a
well-formed but non-existent `ref` (format validation does not prove existence).
The check lives in `aclExecute` / `routeExecute` as the single chokepoint.

#### Acceptance Criteria

1. WHEN an engineer executes an ACL or ROUTE add/delete, THE service SHALL, as the FIRST step before building the preview, calling n8n, or writing any audit row, verify the `changeTicket` exists in iTop via `getTicketByRef`.
2. IF the ticket is not found, THEN THE service SHALL reject with `TICKET_NOT_FOUND` (HTTP 404) and SHALL NOT call n8n and SHALL NOT write any audit row.
3. IF iTop is unconfigured, unreachable, or times out so the ticket cannot be verified, THEN THE service SHALL reject with `ITOP_UNREACHABLE` (HTTP 503) and SHALL NOT call n8n and SHALL NOT write any audit row (block-total posture — no verification means no execution).
4. THE guard SHALL live in the service layer so it cannot be bypassed by a thin or alternate handler, and SHALL apply to EXECUTE only; `aclShow`/`routeShow` and `aclPreview`/`routePreview` SHALL be unchanged, and `changeTicket` SHALL remain required on add/delete.
5. THE rejection SHALL NOT leak SQL, stack, connection string, or any credential; a non-secret `console.warn` naming only the ticket `ref` is permitted.

### Requirement 8: Test Connection endpoints (iTop + n8n)

**User Story:** As an administrator, I want to test the iTop and n8n connections from the Administration page, so that I can diagnose connectivity without running a real operation.

#### Acceptance Criteria

1. WHEN an administrator triggers the iTop test (`POST /api/itop/test`), THE application SHALL run `pingItop` — a read-only `SELECT 1` bounded by `ITOP_TIMEOUT_MS` — and return a `ConnectionTestResult` `{ ok, message }` without throwing.
2. WHEN an administrator triggers the n8n test (`POST /api/n8n/test`), THE application SHALL run `pingN8n` — a `N8N_TIMEOUT_MS`-bounded GET of the n8n origin root with no API key on the wire — and report an HTTP status `>= 500` as degraded (`ok: false`); only a sub-500 response counts as reachable (n8n-integration spec).
3. THE two test endpoints SHALL require `assertSameOrigin` + `requirePermission(ADMINISTRATION_MANAGE)`, and their buttons SHALL be visible only when `canManage` is true.
4. BOTH test endpoints SHALL share the `ConnectionTestResultSchema` `{ ok, message }` shape and SHALL never leak a connection string, password, or API key.

### Requirement 9: Access and endpoints

**User Story:** As a developer, I want a clear endpoint and auth map for iTop, so that the contract is unambiguous.

#### Acceptance Criteria

1. THE API_Layer SHALL expose `POST /api/itop/tickets/search` and `POST /api/itop/tickets/preview`, each requiring a valid session only (no new feature permission — they are a sub-step of an add/delete the engineer is already permitted to do, and read-only).
2. THE API_Layer SHALL expose `POST /api/itop/test` and `POST /api/n8n/test`, each requiring `ADMINISTRATION_MANAGE`.
3. All four endpoints SHALL be POST to honor the `assertSameOrigin` CSRF posture.
4. THE application SHALL NOT expose any endpoint that writes to iTop.

### Requirement 10: Configuration and boot resilience

**User Story:** As an operator, I want the app to boot without iTop configured, so that iTop is an optional feature that fails gracefully.

#### Acceptance Criteria

1. THE iTop configuration SHALL be supplied as discrete parts (`ITOP_HOST`, `ITOP_PORT`, `ITOP_NAME`, `ITOP_USER`, `ITOP_PASSWORD`) and assembled into `ITOP_DATABASE_URL`; it is all-or-nothing — none set (feature off) or all set, and a partial configuration SHALL halt startup (general spec, Req 7).
2. THE `ITOP_TIMEOUT_MS` SHALL have a default (10000) and bound every iTop operation.
3. WHEN iTop is unconfigured, THE application SHALL boot successfully; search/preview SHALL surface the missing config only at call time as `ITOP_UNREACHABLE`, and the Test iTop button SHALL report "not configured" (`{ ok: false }`), never throwing or blocking boot.

## Non-Functional Requirements

### Security

1. iTop access SHALL be READ-ONLY (SELECT only); no write or DDL SHALL ever be issued.
2. No secret (connection string, password, API key) SHALL be logged or returned.
3. Every iTop-sourced string SHALL be rendered escaped in the UI (XSS boundary, Requirement 2.3).

### Reliability

1. Every iTop call SHALL be bounded by `ITOP_TIMEOUT_MS` and SHALL never block the request thread.

## Out of Scope

1. Changing Log Trail code or the `changeTicket` audit storage (unchanged).
2. Pushing configuration to devices or persisting any iTop/ticket data in the application database.
3. Adding a new RBAC permission for ticket search/preview (they are auth-only).
4. Writing to iTop in any form.
