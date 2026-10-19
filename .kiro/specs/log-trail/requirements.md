# Requirements Document — Log Trail (Audit System of Record)

## Introduction

This spec is the authoritative document for the **audit / Log Trail** subsystem:
the `audit_logs` master table that records every security- and
configuration-relevant event in the application, the `acl_logs` / `route_logs`
execution-inspection detail tables that complement it, and the `/logs` page that
presents them. The audit trail is the operational **system of record** — the
application stores no ACL/route device configuration, so these tables are the
durable record of who did what, when, and with what outcome.

Log Trail is **common access**: any authenticated user reaches `/logs` with no
feature permission. The read endpoints are auth-only; there is no endpoint that
mutates or deletes an audit row.

Related specs:

- **general/** — system overview, the API envelope, and the Correlation_Id concept.
- **authentication/** — the two-row AUTH logging model (first factor + MFA).
- **user-management/** — the USER/UPDATE audit emitted by role/status changes.
- **n8n-integration/** — the ACL/ROUTE execution that produces the detail rows (this spec is the authoritative source for the detail-table schema; n8n-integration cross-links here).
- **netops-policy-manager/** — the ACL/ROUTE operations whose outcomes are recorded.

### Scope

In scope: the `audit_logs` master schema and its enums, the `acl_logs` /
`route_logs` detail schema, the AUTH two-row model, the USER/UPDATE model, the
redaction and best-effort write rules, the six read endpoints, and the `/logs`
UI (columns, filters, pagination, detail modal, execution inspection). Out of
scope: writing device configuration (there is none), authentication and MFA
mechanics (see authentication/), and the n8n webhook contract (see
n8n-integration/).

## Glossary

- **Audit_Service**: The server component (`server/services/audit.service.ts`) that writes and reads audit rows; it redacts every JSONB payload before insert and exposes no update/delete path.
- **Audit_Log**: One row in `audit_logs` — the master record of a single event (`module` + `action` + `status` + actor snapshot + Correlation_Id + four JSONB payloads).
- **Exec_Detail_Log**: One row in `acl_logs` or `route_logs` — the deeper execution-inspection detail for a sensitive ACL/ROUTE operation, linked to its master `Audit_Log`.
- **Correlation_Id**: The UUID that links one operation across the Web request, the n8n execution, and the device response; it joins a master row to its detail rows. Defined in the general/ glossary.
- **Audit_Context**: The actor + request snapshot (`userId`, `username`, `userRole`, `sourceIp`, `userAgent`) captured at action time; `username`/`userRole` are snapshots so the trail survives later user/role changes.

## Requirements

### Requirement 1: Common access to the Log Trail

**User Story:** As any authenticated operator, I want to read the activity history, so that I can review what happened without needing a special permission.

#### Acceptance Criteria

1. THE `/logs` page SHALL be reachable by every authenticated user WITHOUT any feature permission (common access, like the Dashboard).
2. THE audit read endpoints SHALL require only an authenticated session (`requireAuthenticatedUser`) and SHALL NOT require a feature permission.
3. THE Log Trail SHALL expose NO endpoint that creates, updates, or deletes an audit row from client input; audit rows are written only as a side effect of the operations they record.

### Requirement 2: The `audit_logs` master schema

**User Story:** As a compliance auditor, I want a fixed, queryable master record of every event, so that the trail is complete and consistent.

#### Acceptance Criteria

1. THE `audit_logs` table SHALL have the fixed columns: `id` (uuid PK), `user_id` (uuid, nullable, FK → `users.user_id` ON DELETE SET NULL), `username` (snapshot), `user_role` (snapshot), `module`, `action`, `status`, `source_ip`, `user_agent`, `change_ticket` (nullable, indexed), `correlation_id` (uuid, NOT NULL), and `created_at` (timestamptz, default now).
2. THE `audit_logs` table SHALL have four flexible JSONB payload columns — `request_payload`, `command_payload`, `execution_payload`, `response_payload` — each nullable.
3. THE `module` column SHALL be constrained to the `audit_module` enum: `AUTH`, `USER`, `ACL`, `ROUTE`, `N8N`.
4. THE `action` column SHALL be constrained to the `audit_action` enum IN THIS ORDER: `LOGIN`, `SHOW`, `ADD`, `DELETE`, `UPDATE`, `LOGOUT`, `MFA_VERIFY`.
5. THE `status` column SHALL be constrained to the `audit_status` enum: `SUCCESS`, `FAILED`.
6. THE `user_id` FK SHALL use ON DELETE SET NULL so an audit row survives the removal of its user, and `username`/`user_role` SHALL remain as point-in-time snapshots.
7. THE `audit_logs` table SHALL carry indexes on `created_at`, `user_id`, `module`, `action`, `status`, `change_ticket`, and `correlation_id` to support the Log Trail filters.

### Requirement 3: Redaction and best-effort writes

**User Story:** As a security owner, I want every stored payload scrubbed and audit writes to never break the operation, so that no secret is persisted and auditing never changes a result.

#### Acceptance Criteria

1. WHEN the Audit_Service writes any of the four JSONB payloads, THE Audit_Service SHALL pass the value through `redactPayload` first, so device execution credentials, the n8n API key, session tokens, and any secret appear only as `***` and are never persisted.
2. THE Audit_Service SHALL NEVER store a user password, a TOTP code, or any raw credential in any column or payload.
3. WHERE an audit write is best-effort (AUTH and USER mutations), THE Audit_Service SHALL swallow a write failure so it never alters the HTTP response or the outcome of the recorded operation.

### Requirement 4: The `acl_logs` / `route_logs` detail tables

**User Story:** As an operator inspecting a sensitive change, I want deeper execution detail linked to the master row, so that I can see exactly what was previewed and what the device returned.

#### Acceptance Criteria

1. THE `acl_logs` and `route_logs` tables SHALL COMPLEMENT `audit_logs` — they add execution-inspection detail for ACL/ROUTE operations and SHALL NOT replace the master row.
2. EACH detail row SHALL reference its master row via `audit_id` (uuid FK → `audit_logs.id`, ON DELETE CASCADE, NOT NULL) and SHALL carry the shared `correlation_id` (uuid, NOT NULL).
3. WHEN an ACL/ROUTE operation is recorded, THE Audit_Service SHALL write the master row and its detail row in the SAME database transaction (`recordWithDetail`), so master and detail never diverge.
3a. WHEN a bidirectional ACL ADD is executed (netops-policy-manager spec, Req 10), THE Audit_Service SHALL record TWO independent `ACL`/`ADD` entries — one per direction (forward Source→Destination, then reverse Destination→Source) — each its own master `audit_logs` row plus its own `acl_logs` detail row, linked by its OWN Correlation_Id. The two directions SHALL NOT share a Correlation_Id and SHALL NOT be collapsed into one audit row.
4. THE detail tables SHALL share the enums `exec_log_action` (`SHOW`, `ADD`, `DELETE`) and `exec_log_status` (`SUCCESS`, `FAILED`); the enum names are global in PostgreSQL and declared once (in `acl-logs.ts`, imported by `route-logs.ts`).
5. THE `acl_logs` table SHALL carry `device`, `source`, `destination` (human-readable, non-secret address inputs) plus the redacted JSONB `command_preview`, `execution_meta`, `response_summary`; `command_preview` SHALL be null for SHOW.
6. THE `route_logs` table SHALL mirror `acl_logs` but SHALL replace `source` with `change_ticket` (indexed) and keep `destination` as the human-readable "IP MASK" input.
7. THE three JSONB columns on each detail row SHALL be redacted before write, and the detail tables SHALL expose NO update or delete path.

### Requirement 5: The AUTH two-row logging model

**User Story:** As a security auditor, I want each authentication step recorded distinctly, so that I can see whether a login failed at the password or the MFA step.

#### Acceptance Criteria

1. WHEN a user completes a full login, THE Audit_Service SHALL record TWO AUTH rows: `LOGIN`/`SUCCESS` for the first factor and `MFA_VERIFY`/`SUCCESS` for the second factor.
2. WHEN first-factor verification fails, THE Audit_Service SHALL record `LOGIN`/`FAILED` only.
3. WHEN MFA verification fails, THE Audit_Service SHALL record `MFA_VERIFY`/`FAILED` and `LOGIN`/`FAILED`.
4. WHEN a user logs out, THE Audit_Service SHALL record `LOGOUT`/`SUCCESS`.
5. THE AUTH logging SHALL apply to every account origin (LOCAL and AD) and every role, INCLUDING a user with `role_id = null`.
6. WHEN an authentication attempt fails, THE failed-login `request_payload` SHALL contain only non-secret context such as `{ identifier, provider?, reason }` and SHALL NEVER contain the submitted password or code.

### Requirement 6: The USER/UPDATE audit model

**User Story:** As a compliance auditor, I want administration changes to users recorded, so that role and status changes are attributable.

#### Acceptance Criteria

1. WHEN an admin changes a user's role or status, THE Audit_Service SHALL record a `USER`/`UPDATE` row (reusing the `UPDATE` action; no new enum value is added).
2. THE `request_payload` SHALL carry a `kind` discriminator — `ROLE_CHANGE` or `STATUS_CHANGE` — distinguishing the two mutation types.
3. THE acting admin SHALL be the audit actor (actor snapshot in `username`/`user_role`), and the TARGET user SHALL appear only inside the payload (`targetUserId`, `targetUsername`, and `fromRole`/`toRole` or `isActive`).
4. THE USER/UPDATE write SHALL be best-effort and SHALL record a `FAILED` row for a rejected mutation (unknown user/role or a refused self-disable) without altering the HTTP response. *(The `/logs` UI Module → Action map currently offers only `UPDATE` under the USER module.)*

### Requirement 7: Audit read endpoints

**User Story:** As a developer, I want stable read endpoints for the trail and its detail, so that the UI can list, filter, and inspect records.

#### Acceptance Criteria

1. THE API_Layer SHALL expose `GET /api/audit` — a server-side paginated, filtered list of audit rows mapped to the safe `AuditResponse` shape.
2. THE API_Layer SHALL expose `GET /api/audit/:id` — one audit row, or a NOT_FOUND response.
3. THE API_Layer SHALL expose `GET /api/acl-logs` and `GET /api/route-logs` — paginated, filtered detail lists.
4. THE API_Layer SHALL expose `GET /api/acl-logs/correlation/:id` and `GET /api/route-logs/correlation/:id` — all detail rows for one Correlation_Id for the inspection panel; an empty array SHALL be a valid `200` (not a `404`).
5. EVERY audit/detail read endpoint SHALL require only an authenticated session and SHALL return results through the standard `{ success, data }` envelope. *(A `GET /api/audit/export` endpoint also exists, returning the filtered rows for export.)*
6. THE `AuditQuerySchema` SHALL accept `page`, `limit`, `search`, `module`, `action`, `status`, `changeTicket`, `correlationId`, `from`, and `to`; the detail-log query schemas SHALL accept `action`, `status`, `correlationId`, `from`, `to`, and (route only) `changeTicket`.

### Requirement 8: The `/logs` user interface

**User Story:** As an operator, I want a filterable table and a rich detail view, so that I can find and inspect any recorded event.

#### Acceptance Criteria

1. THE `/logs` master table SHALL show the columns: Time, User, Source IP, Module, Action, Status.
2. THE filter set SHALL be: a search box (username / display name / email, applied on submit), Module, a dependent Action whose options depend on the selected Module, Status, and a From/To date range.
3. WHEN the selected Module changes, THE page SHALL drop any Action value that is not valid for the new Module (resetting it to "All").
4. THE list SHALL use server-side pagination. *(The current page requests `limit = 20` per page.)*
5. THE table SHALL render inside a fixed-height, sticky-header scroll container so the page itself does not grow with the row count.
6. WHEN a row is activated (click or Enter/Space), THE page SHALL open a detail modal showing the full audit record and each non-null JSONB payload (Request, Command, Execution, Response) pretty-printed.
7. WHERE the selected row's Module is `ACL` or `ROUTE`, THE modal SHALL fetch the matching execution-inspection detail rows by Correlation_Id and render them as an "Execution Inspection" section, with its own loading / error / empty states.
8. THE page SHALL render loading, empty, and error states via the shared `LoadingState` / `EmptyState` / `ErrorState` components. *(The Module filter deliberately omits `N8N`; n8n activity is folded into the ACL/ROUTE rows.)*

## Non-Functional Requirements

### Security

1. THE Log Trail SHALL surface only pre-redacted payloads; because redaction happens at write time, the stored JSONB is already safe to return.
2. THE audit read responses SHALL exclude SQL, stack traces, filesystem paths, and secrets (see general/).

### Integrity

1. THE audit and detail tables SHALL be append-only in normal operation — there is no update/delete path, and detail rows cascade-delete only with their (never-deleted) master row.
