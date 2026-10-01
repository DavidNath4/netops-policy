# Implementation Plan — ACL & Route via n8n + Audit

## Overview

This is the current feature-development task list. It builds the ACL and Route
operations (show / add / delete) on top of the existing identity + RBAC
foundation, per the revised main spec (`netops-policy-manager`: Req 4, 6, 7, 8, 9)
and this **n8n Integration** sub-spec.

Model: the app is the **interface + audit/logging layer**; execution is delegated
to **n8n** (per-operation webhooks `<base>/<module>/<action>`, header
`X-NetOps-Internal-Key`). Add/delete show a **redacted command preview**, then
execute on explicit confirmation; read (show/list/search/detail) is read-only and
runs immediately, fetching live from n8n. One **correlation id** links request →
n8n → device → response. There are **no ACL/route configuration-state tables**
(`acl_policies`/`routes`) — the app persists no device config. The DB does hold
`audit_logs` (the master trail for all modules) plus the `acl_logs`/`route_logs`
**audit-detail** tables that complement it for ACL/ROUTE execution inspection
(see Task 9).

Read operations use **Device Session Credentials**: the engineer enters device
user/password once on the show page; they are held AES-256-GCM-encrypted on the
session row (TTL 30 min), auto-filled by the server for reads, revealed only to
the owner, cleared on manual clear or logout/expiry. Add/delete take credentials
per operation (not auto-filled).

Progress note: much of the backend (Tasks 1–7 below) was already implemented in
an earlier pass; the device-credentials feature (Task 5) and the show-schema
adjustment are the new work, plus the frontend (Tasks 7–8).

### Working rules

- **Run one task at a time**, discussing between tasks.
- **The operator runs all DB/build commands.** Migrations are *generate-only* here
  (`npm run db:generate`); the operator runs `npm run db:migrate`, `npm run
  typecheck`, and `npm run build`.
- **Never persist or log the execution credentials or the n8n API key.** They are
  redacted to `***` before any preview, response, or audit write.

## Tasks

- [x] 1. **DB audit layer.** `database/schema/audit-logs.ts` — `audit_logs` (fixed columns id, user_id, username, user_role, module, action, status, source_ip, user_agent, change_ticket, correlation_id, created_at + four JSONB payloads + the `audit_module`/`audit_action`/`audit_status` enums + indexes). Re-exported; migration generated and applied (verified in the dev DB).
  - _Requirements: main 8.1, 8.2, 8.3, 8.5, 8.7, 10.1, 10.2, 10.7, 15.1, 15.2_

- [x] 2. **Shared Zod contracts + n8n config.** `shared/schemas/` network/common/n8n/acl/route/audit; `EnvSchema` + `N8N_BASE_URL`/`N8N_API_KEY`/`N8N_TIMEOUT_MS`; `.env.example`. (Adjusted in Task 5: the show schemas drop `ExecCredentials` — filter only.)
  - _Requirements: main 4.3–4.7, 5, 6.3–6.5, 11.2, 11.4, 12, 14.1, 14.2, 14.4; n8n 4, 10_

- [x] 3. **n8n client + preview + redaction** (`server/network/`). `n8n-client.ts` (single caller; per-operation URL `<base>/<module>/<action>`; header `X-NetOps-Internal-Key`; correlationId; `N8N_TIMEOUT_MS`; normalize → `N8nResult`; mismatch → FAILED), `command-templates.ts` (4 static), `preview.ts`, `redact.ts`.
  - _Requirements: main 7.1–7.7; n8n 1, 3, 5, 8, 9, NFR Security_

- [x] 4. **Audit service + repository.** `audit.repository.ts` (insert + paginated query + getById; no delete/mutate) and `audit.service.ts` (`record()` redacts before insert; `list`/`getById`/`export`).
  - _Requirements: main 8.3, 8.4, 8.6, 8.7, 8.8, 8.9, 8.10, 8.12; n8n 6, 7_

- [x] 5. **Device Session Credentials.** `sessions` +`device_cred_encrypted`/`device_cred_expires_at` (migration generated + applied, verified in DB). Shared AES-256-GCM in `server/utils/crypto.ts` (mfa.service re-exports it). `device-credential.service.ts` (`set`/`get`/`status`/`clear`, TTL 30 min, session-scoped by token hash). Endpoints `POST`/`GET`/`DELETE /api/session/device-credentials` + `GET .../reveal` (owner only). `DEVICE_CREDENTIALS_REQUIRED` added. Logout clears them (session row deleted).
  - _Requirements: main 7.8, 7.9; n8n 11, NFR Security_

- [x] 6. **ACL & Route backend + wire reads to session credentials.** `acl.service.ts`/`route.service.ts` (`show`/`preview`/`execute`) + handlers. `AclShowSchema`/`RouteShowSchema` now `{ search }` only (search-only); show handlers resolve `getDeviceCredentials`, return `DEVICE_CREDENTIALS_REQUIRED` when absent/expired, else inject into the n8n payload. Add/delete unchanged.
  - _Requirements: main 4.1–4.3, 4.8–4.15, 6.1–6.3, 6.6–6.12, 7, 12; n8n 1, 2, 3, 5, 7, 8, 11_

- [x] 7. **Frontend — ACL & Route pages.** `acl/index.vue` + `routes/index.vue` are search-only (IP search bar + Search, result in terminal box), gated by an on-demand `DeviceCredentialsModal` (`useDeviceCredentials` composable; set once/session, eye-toggle, Clear, auto-fill after). `acl/add.vue` + `routes/add.vue`: Generate → redacted preview → Execute Command → ConfirmDialog → result. Permission-gated; follows `ui-conventions.md`.
  - _Requirements: main 2.7, 4.1, 4.8, 4.9, 6.1, 6.6, 6.7, 13.1–13.4, 13.12–13.15; n8n 11_

- [x] 8. **Dashboard + Log Trail from audit.** `dashboard.service.ts` + `GET /api/dashboard/summary`; `GET /api/audit`, `/api/audit/:id`, `/api/audit/export`. Dashboard page shows execution totals/success/failed/per-module/recent from audit; `/logs` page filters by module/action/status/date/search with a detail view of the 4 JSONB payloads + JSON export. Leftover mock removed (`mock-data.ts` deleted; `useApi` real-only; `api-types.ts` slimmed to re-export shared types). Operator runs `npm run typecheck` + `npm run build`.
  - _Requirements: main 8.8, 8.9, 8.10, 8.11, 9.1–9.7, 12.6, 17.17_

- [x] 9. **ACL/Route audit-detail tables (complement `audit_logs`).** Added two
  detail tables that hold deeper execution-inspection detail for the sensitive
  ACL/ROUTE operations, written in the SAME transaction as the master audit row
  and linked by `audit_id` (FK → `audit_logs.id`, ON DELETE CASCADE) +
  `correlation_id`. They do NOT replace `audit_logs` — the master trail still
  records all ACL/ROUTE operations.
  - `database/schema/acl-logs.ts` — `acl_logs` (id uuid pk, `audit_id` fk,
    `correlation_id`, `action` SHOW/ADD/DELETE, `status` SUCCESS/FAILED, `device`,
    `source`, `destination`, `command_preview` jsonb, `execution_meta` jsonb,
    `response_summary` jsonb, `created_at`; indexes on `audit_id`,
    `correlation_id`, `created_at`).
  - `database/schema/route-logs.ts` — `route_logs` (same shape, but `change_ticket`
    in place of `source`, keeping `destination`; extra index on `change_ticket`).
  - Registered in `database/schema/index.ts`; shared enums `exec_log_action`
    (SHOW/ADD/DELETE) and `exec_log_status` (SUCCESS/FAILED); client Zod shapes in
    `shared/schemas/exec-log.schema.ts`.
  - Repositories `server/repositories/acl-log.repository.ts` +
    `route-log.repository.ts`; read services `server/services/acl-log.service.ts`
    + `route-log.service.ts`.
  - Read-only endpoints (authenticated, no feature permission, mirroring
    `/api/audit`): `GET /api/acl-logs`, `/api/acl-logs/correlation/:id`,
    `/api/route-logs`, `/api/route-logs/correlation/:id`.
  - All persisted JSONB passes through `redactPayload`; NO credential/password is
    ever stored. Migration generated + applied (verified in the dev DB).
  - _Requirements: main 8.1, 8.3, 8.4, 8.5, 8.12; n8n 3, 6, 7, NFR Security_

- [x] 10. **AUTH audit logging + `LOGOUT` enum value.** Every authentication
  activity is now recorded to `audit_logs` for ALL user types (LOCAL and AD) and
  ALL roles (including `role_id = null`); previously the audit enums existed but
  no auth endpoint wrote a row.
  - `AUTH/LOGIN/SUCCESS` at both MFA session-creation points (`mfa/verify`,
    `mfa/setup/verify`).
  - `AUTH/LOGIN/FAILED` on every non-success login path (invalid body,
    disabled-account gate, no-provider, bad credentials, AD unreachable). The
    failed-login audit stores only `{ identifier, provider?, reason }` and NEVER
    a password.
  - `AUTH/LOGOUT/SUCCESS` on logout (actor resolved before the session is revoked).
  - Audit writes are best-effort (isolated) so they never change the HTTP response.
  - Appended `LOGOUT` to `auditActionEnum` (`database/schema/audit-logs.ts`) and
    `AuditActionSchema` (`shared/schemas/audit.schema.ts`); migration generated +
    applied. The dev DB `audit_action` enum is now LOGIN, SHOW, ADD, DELETE,
    UPDATE, LOGOUT.
  - Master search (`GET /api/audit`) was extended: `audit.repository.listAudit`
    now LEFT JOINs `users` to also match `display_name` and `email`, not just the
    username snapshot.
  - _Requirements: main 1.11, 1.13, 1.15, 8.1; ad-authentication 8.5_

## Notes

- **RBAC is already in place.** The `ACL_POLICIES_*` and `ROUTES_*` permissions and
  the role mapping are seeded in the dev DB, so tasks only consume `requirePermission`.
- **No ACL/route config-state tables.** The app persists no `acl_policies`/`routes`
  configuration rows; all ACL/route *state* lives on devices and is reached through
  n8n. The app tables are the identity/RBAC/session set + `audit_logs` + the
  `acl_logs`/`route_logs` audit-detail tables (Task 9), which record execution
  inspection detail, not device configuration state.
- **Audit-detail tables complement `audit_logs`.** `acl_logs`/`route_logs` do NOT
  replace the master audit trail; `audit_logs` still records every ACL/ROUTE
  operation. Each detail row is written in the SAME transaction as its master
  audit row and links back via `audit_id` (FK → `audit_logs.id`, ON DELETE CASCADE)
  + `correlation_id`. All persisted JSONB is redacted — no credential/password.
- **Migrations in this phase, all generate-only:** `audit_logs` (Task 1, done),
  the `sessions` device-credential columns (Task 5), the `acl_logs`/`route_logs`
  detail tables (Task 9), and the `LOGOUT` value appended to the `audit_action`
  enum (Task 10). The operator runs `npm run db:generate` then `npm run db:migrate`.
- **Read auto-fill, add/delete manual.** Device Session Credentials auto-fill only
  show/list/search/detail; add/delete keep per-operation credentials.
- **Payload/response shapes are flexible.** They live in JSONB and may be tuned to
  n8n without a migration to the fixed audit columns.

## Follow-ups & Open Items (hand-off for a new session)

Status: Tasks 1–8 are implemented and the project passes `npm run typecheck` and
`npm run build`. The code is complete; what remains is wiring to the real n8n and
confirming contract details. Captured so a new session can continue.

### A. Required for the feature to actually run

1. **n8n workflows + 6 webhooks must exist.** The app POSTs to
   `https://cloudn8n.mov.co.id/webhook/{acl,route}/{show,add,delete}`. Until those
   workflows exist, every operation returns FAILED (unreachable/404). Owned on the
   n8n side.
2. **Auth header must match.** The app sends `X-NetOps-Internal-Key: <N8N_API_KEY>`.
   The n8n webhook must validate that exact header name + the same value as `.env`.
3. **Test user needs an RBAC role.** The logged-in user must have a role with the
   `ACL_POLICIES_*` / `ROUTES_*` permissions (NOC / L2_ENGINEER / ADMINISTRATOR are
   seeded). A user with `role_id = null` sees the menus gated off.

### B. n8n contract — CONFIRMED and wired (ACL + route, show/add/delete)

4. **Request body field names (confirmed).** All calls send credentials as
   `user`/`pass`; correlation id is the `x-correlation-id` header, not the body.
   - acl/show: `{ user, pass, source }`
   - acl/add, acl/delete: `{ user, pass, source, destination }` (joined `"IP MASK"`)
   - route/show: `{ user, pass }` (show-all)
   - route/add, route/delete: `{ user, pass, destination }` (joined `"IP MASK"`)
   The forms collect masks separately + an optional changeTicket (audited only).
   Schemas: `shared/schemas/{acl,route}.schema.ts`; mapping in
   `server/services/{acl,route}.service.ts` (`joinAddr`).
5. **Response shapes the app normalizes** (`server/network/n8n-client.ts` →
   `normalize()`): show `{ success, found?, total, data[], message }`;
   add/delete `{ success, operation, sshCode, reachedDevice, message, error }`.
   `success` drives SUCCESS/FAILED; `error` (fallback `message`) is surfaced on failure.
6. **Show output rendering (done).** ACL show renders a table (ACL Name / Action /
   Protocol / Source / Destination / Service). Route show renders Destination /
   Mask / Gateway + click-row → raw command box, filtered client-side.
7. **Command preview templates** (`server/network/command-templates.ts`) use
   generic Cisco-like syntax aligned to the joined IP MASK fields. Preview-only —
   not sent to n8n; refine to exact device syntax as needed.

### C. Optional / not blocking

8. **No Vitest tests yet** for this feature (not requested). Candidates: redaction
   (`server/network/redact.ts`), preview (`server/network/preview.ts`), n8n response
   normalization (`server/network/n8n-client.ts`), and the device-credential service.
9. **`.env`** must hold the real `N8N_API_KEY` (not the `netops_****` placeholder)
   before testing against the live n8n. `.env` is git-ignored and edited by the
   operator only.

### Adjustment applied (device credentials)

- Device Session Credentials now live for the **login session lifetime** (no separate
  30-min TTL); cleared on logout/expiry or manual clear. (`device_cred_expires_at`
  column is retained but unused.)
- Setting credentials **validates once** via `POST <N8N_BASE_URL>/user/validate`
  (`{ user, pass }` → `{ success, message }`, header `X-NetOps-Internal-Key`); only
  `success: true` stores them, otherwise the set is rejected with the message. Reads
  do not re-validate. Implemented in `server/network/n8n-client.ts`
  (`validateDeviceCredentials`) + `server/api/session/device-credentials.post.ts`.
- The `user/validate` endpoint is real and confirmed; the six ACL/route operation
  webhooks (item A.1) are still pending on the n8n side.

### acl/show contract wired (confirmed)

- Request body to n8n is exactly `{ user, pass, source }` (no module/action/correlationId
  in body; correlation id goes in the `x-correlation-id` header). Credentials use
  `user`/`pass` on ALL n8n calls (validate, show, add, delete). Show pulls them from
  the Device Session Credentials; add/delete take them per operation.
- Response `{ success, total, data[], message }` is normalized: `success`→status,
  `data[]`→`items`, and the ACL search page renders a table (ACL Name / Action /
  Protocol / Source / Destination / Service), raw text as fallback.
- **route/show confirmed (show-all)**: body `{ user, pass }` (no search); response
  `{ success, found, total, data[], message }` with rows `{ raw, interface,
  destination, mask, gateway, metric }`. Route page shows **Destination / Mask /
  Gateway** + click-row → raw command box, and filters the rows client-side.
- **ACL & route add/delete confirmed**: body `{ user, pass, source, destination }`
  (ACL) / `{ user, pass, destination }` (route), destination/source joined `"IP MASK"`.
  Response `{ success, operation, sshCode, reachedDevice, message, error }`.

### Added this phase (beyond the original n8n scope)

- **Existence pre-check** before add/delete (`app/composables/useOpsPrecheck.ts`):
  ADD blocks if the entry already exists; DELETE blocks if it does not. ACL matches
  source+destination; route matches the route IP against `destination`.
- **Locked IP / mask inputs** (`app/components/IpInput.vue`, `MaskInput.vue`):
  digits+dots only, ≤255 per octet, max 4 octets; IP shows a valid/invalid badge
  and blocks submit when invalid; mask shows a live `/CIDR` badge (`/?` when
  malformed). Helpers in `shared/schemas/network.schema.ts`
  (`isValidIpv4`, `maskToCidr`, `sanitizeIpv4Input`, `SUBNET_MASKS`).
- **ACL/route endpoints are singular**: `/api/acl/*` and `/api/route/*`.

### Suggested first steps next session

- Get one real request/response example for `acl/show` from n8n, align field names +
  `normalize()`, then test end-to-end (set device credentials → search → see output +
  audit log with correlation id).
- Then repeat for add/delete (preview → execute → audit), and for route operations.
