# Implementation Plan — ACL & Route via n8n + Audit

## Overview

This is the current feature-development task list. It builds the ACL and Route
operations (show / add / delete) on top of the existing identity + RBAC
foundation, per the revised main spec (`netops-policy-manager`: Req 4, 6, 7, 8, 9)
and this **n8n Integration** sub-spec.

Model: the app is the **interface + audit/logging layer**; execution is delegated
to **n8n** (which reaches devices via an SSH jump host). Add/delete show a
**redacted command preview**, then execute on explicit confirmation; `show` is
read-only and runs immediately. One **correlation id** links request → n8n →
device → response. There are **no `acl_policies`/`routes` tables** — the database
stores audit logs only.

### Working rules

- **Run one task at a time**, discussing between tasks.
- **The operator runs all DB/build commands.** Migrations are *generate-only* here
  (`npm run db:generate`); the operator runs `npm run db:migrate`, `npm run
  typecheck`, and `npm run build`.
- **Never persist or log the execution credentials or the n8n API key.** They are
  redacted to `***` before any preview, response, or audit write.

## Tasks

- [ ] 1. **DB audit layer.** `database/schema/audit-logs.ts` — `audit_logs` with the fixed columns (id, user_id, username, user_role, module, action, status, source_ip, user_agent, correlation_id, created_at) + four JSONB payloads (request/command/execution/response) + the `audit_module`/`audit_action`/`audit_status` enums + indexes (created_at, user_id, module, action, status, correlation_id). Re-export from the schema index. **Generate the migration only** — the operator runs `npm run db:migrate`.
  - _Requirements: main 8.1, 8.2, 8.3, 8.5, 8.7, 10.1, 10.2, 10.7, 15.1, 15.2_

- [ ] 2. **Shared Zod contracts + n8n config.** `shared/schemas/`: network primitives (reuse/extend), `acl.ts` & `route.ts` (show filter + add/delete field payloads + `ExecCredentials`), `n8n.ts` (`OperationResult`, n8n result contract), audit query/response (module/action/status/correlationId filters + 4 JSONB), `common.ts` correlationId helper. Extend `EnvSchema` with `N8N_BASE_URL`/`N8N_API_KEY`/`N8N_TIMEOUT_MS` and add placeholders to `.env.example` (never in `runtimeConfig.public`).
  - _Requirements: main 4.3–4.7, 5, 6.3–6.5, 11.2, 11.4, 12, 14.1, 14.2, 14.4; n8n 4, 10_

- [ ] 3. **n8n client + preview + redaction** (`server/network/`). `n8n-client.ts` (the single caller of n8n: API-key header + correlationId + field payload, `N8N_TIMEOUT_MS`, normalize response → `N8nResult`, correlationId-mismatch → FAILED), `command-templates.ts` (4 static templates), `preview.ts` (render + redact), `redact.ts` (`***`). Unit-testable with `fetch`/client mocked; no DB, no real n8n.
  - _Requirements: main 7.1–7.7; n8n 1, 3, 5, 8, 9, NFR Security_

- [ ] 4. **Audit service + repository.** `server/repositories/audit.repository.ts` (parameterized insert + paginated query + getById; no delete/mutate) and `server/services/audit.service.ts` (`record()` redacts creds/secrets before insert, plus `list`/`getById`/`export`). Reused by every module.
  - _Requirements: main 8.3, 8.4, 8.6, 8.7, 8.8, 8.9, 8.10, 8.12; n8n 6, 7_

- [ ] 5. **ACL & Route backend.** `server/services/acl.service.ts` & `route.service.ts` (`show`/`preview`/`execute`: validate → generate correlationId → preview via templates+redact / call `N8N_Client` → record one audit log SUCCESS/FAILED, safe errors). Handlers `server/api/{acl,routes}/{show,preview,execute}.post.ts` — thin, `requirePermission` resolved from `operation` (SHOW→`*_SHOW`, ADD→`*_ADD`, DELETE→`*_DELETE`), envelope-wrapped.
  - _Requirements: main 4.1, 4.2, 4.8–4.15, 6.1, 6.2, 6.6–6.12, 7, 12; n8n 1, 2, 3, 5, 7, 8_

- [ ] 6. **Frontend wiring — ACL & Route.** Wire the mock ACL/Route pages to the new endpoints: form (with exec credentials) → "Generate" (POST preview) → redacted terminal box → button becomes "Execute Command" → ConfirmDialog → POST execute → show raw output + SUCCESS/FAILED. Show pages: filter → submit → raw output (no confirm). Permission-gated menus/buttons. Follows `ui-conventions.md`.
  - _Requirements: main 2.7, 4.1, 4.8, 4.9, 6.1, 6.6, 6.7, 13.1–13.4, 13.12–13.15_

- [ ] 7. **Dashboard + Log Trail from audit.** `server/services/dashboard.service.ts` + `GET /api/dashboard/summary` (totals, success/failed, per-module, recent, error summary from `audit_logs`); `GET /api/audit`, `/api/audit/:id`, `/api/audit/export`. Wire the dashboard and `/logs` pages (filters: module/action/status/date/search + a detail view of the 4 JSONB payloads). Then run the verification gate (`npm run typecheck`, `npm run build`).
  - _Requirements: main 8.8, 8.9, 8.10, 8.11, 9.1–9.7, 12.6, 17.17_

## Notes

- **RBAC is already in place.** The `ACL_POLICIES_*` and `ROUTES_*` permissions and
  the role mapping are seeded in the dev DB, so tasks only consume `requirePermission`.
- **No ACL/route tables.** The only new table is `audit_logs`; all ACL/route state
  lives on devices and is reached through n8n.
- **Task 1 first.** Every later task records audit logs, so the audit table + its
  service land before the ACL/Route/dashboard work.
- **Payload/response shapes are flexible.** They live in JSONB and may be tuned to
  n8n without a migration to the fixed audit columns.
