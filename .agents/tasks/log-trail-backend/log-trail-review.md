# Log Trail backend: ACL/ROUTE detail tables + master search

The change adds two complement detail tables (`acl_logs`, `route_logs`) that hang off the existing `audit_logs` master record, writes each detail row in the same transaction as its audit row, and extends the master Log Trail search to also match a user's display name and email. `audit_logs` stays the single system of record; the new tables carry the deeper execution-inspection detail for the two sensitive modules. Read-only, authenticated endpoints expose list + by-correlation views mirroring `/api/audit`. The implementation follows the plan item-for-item and respects the project's layering, redaction, Zod-source-of-truth, and envelope rules.

Watch for: (1) **confirmed** — the diff bundles two unrelated behavioral changes (disabling `POST /api/users` and `POST /api/users/:id/reset-password`, and the matching admin-page UI removal) that are outside the log-trail scope and touch `app/`, which the task says should have no changes; (2) **confirmed** — several `.kiro/specs/*` files are modified, also out of scope for a backend/DB change. Neither affects log-trail correctness, but both widen the diff beyond the plan.

**Verdict**: APPROVED

## High-level view

The two new schema tables mirror `audit-logs.ts` precisely: `defaultRandom` uuid PK, `timestamptz` created_at with `defaultNow`, a not-null cascade FK to `audit_logs.id`, and an array-style index callback. The shared `exec_log_action` / `exec_log_status` pgEnums are declared once in `acl-logs.ts` and imported by `route-logs.ts`, avoiding the global-enum collision; `auditActionEnum` is correctly not reused. Column set, types, nullability, and the index names (including `route_logs_change_ticket_idx`) all match the plan, and both tables are registered in the schema barrel.

The write path is atomic. `audit.service.record()` now returns the inserted `AuditRow`, and a new `recordWithDetail` wraps `record(tx, …)` plus the detail insert in one `db.transaction`, so audit and detail commit together with the real `auditId` FK threaded through the callback. Per-action mapping is correct: SHOW rows carry `commandPreview: null`; ACL SHOW sets `source` to the search term and `destination` null; ROUTE SHOW sets both destination and changeTicket null; execute rows use the human-readable address inputs, not the credential-joined n8n body.

Redaction holds. `commandPreview`, `executionMeta`, and `responseSummary` all pass through `redactPayload` before persistence, and no credential key (`execUsername`/`execPassword`/`user`/`pass`) is ever placed into the detail inserts — only non-secret `source`/`destination`/`device`/`changeTicket` columns and redacted JSONB.

Layering and the read path are clean: handlers are thin (`requireAuthenticatedUser`, Zod `safeParse` → 400 `VALIDATION_ERROR`, `ok` envelope, no `requirePermission`, matching `/api/audit`), repositories are the only Drizzle touch point, services map rows to Zod response shapes, and the query/response schemas are the source of truth with JSONB typed `z.unknown().nullable()`.

Master search uses a `LEFT JOIN users` on `userId` and `ilike`-matches `username`, `displayName`, and `email` with the exact column names from `users.ts`; the same join + where is applied to both the count and the select, and `getTableColumns(auditLogs)` keeps the row shape exactly `AuditRow` so `toAuditResponse` is untouched. Existing filters are preserved.

The only blemish is scope: unrelated user-management disabling (server + `app/` UI) and spec edits ride along in the same diff.

<details>
<summary>Issues (2)</summary>

1. **Out-of-scope user-management changes** — `POST /api/users` and `POST /api/users/:id/reset-password` are turned into 403 stubs and the admin page drops its Add-User/Reset-Password UI. These are unrelated to Log Trail and violate the plan's "no `app/` changes / keep changes scoped" constraint. Non-blocking for log-trail correctness, but should be split into their own change (confirmed).
2. **Out-of-scope spec edits** — several `.kiro/specs/*` files are modified in the same diff for a backend/DB task. Confirm these are intended; otherwise split them out (confirmed).

</details>

<details>
<summary>Details</summary>

## Schema parity with audit-logs.ts

`acl-logs.ts` and `route-logs.ts` match the reference style exactly: imports from `drizzle-orm/pg-core`, `uuid('id').defaultRandom().primaryKey()`, `timestamp('created_at', { withTimezone: true }).notNull().defaultNow()`, FK via `.references(() => auditLogs.id, { onDelete: 'cascade' }).notNull()`, and a table callback returning an array of `index(...).on(...)`. The two shared enums are declared once in `acl-logs.ts` (`exec_log_action` = `['SHOW','ADD','DELETE']`, `exec_log_status` = `['SUCCESS','FAILED']`) and imported by `route-logs.ts`, which is the correct way to avoid redefining a Postgres-global enum. `auditActionEnum` is not reused, as required.

Columns and nullability are correct. `acl_logs` carries `source` + `destination`; `route_logs` carries `destination` + `changeTicket` (no `source`). Both have the three nullable JSONB columns and the not-null `auditId`/`correlationId`/`action`/`status`/`createdAt`. Indexes present: `created_at`, `correlation_id`, `audit_id` on both, plus `route_logs_change_ticket_idx`. Both tables are exported from `database/schema/index.ts`.

The migration SQL does not exist yet — `db:generate`/`db:migrate` are the user's job per the task, so there is no committed migration to inspect; the two tables/enums/indexes live only in the Drizzle schema until the user runs those commands.

## Atomic write path

`record()` returns `insertAudit(...)`'s `AuditRow` (void callers simply ignore it, so AUTH/USER/N8N paths are unaffected). `recordWithDetail` runs `db.transaction(async (tx) => { const audit = await record(tx, input); const detail = await writeDetail(tx, audit.id); … })`, so the audit row and detail row commit together and the detail's `auditId` is the real inserted id. The repository `insert*Log` functions type their `db` param as `Database`, accepting the transaction handle — the one typecheck risk the plan itself flagged; it is the standard drizzle postgres-js pattern and the user's `typecheck` run is the gate for it.

Per-action detail mapping is correct in both services:
- ACL SHOW: `action 'SHOW'`, `commandPreview: null`, `source: input.search`, `destination: null`.
- ACL EXECUTE: `action input.operation`, `commandPreview: redactPayload(preview.command)`, `source: input.source`, `destination: input.destination` (the raw inputs, not the `joinAddr`-joined "IP MASK" sent to n8n).
- ROUTE SHOW: `commandPreview: null`, `destination: null`, `changeTicket: null`.
- ROUTE EXECUTE: `destination: joinAddr(input.routeIp, input.routeMask)`, `changeTicket: input.changeTicket ?? null`.

## Redaction and credential handling

`commandPreview`, `executionMeta`, and `responseSummary` are each wrapped in `redactPayload(...)` at the call site before the insert (SHOW passes `null` for commandPreview). The detail inserts never reference `execUsername`/`execPassword`/`user`/`pass`; the only scalar columns written are `device`, `source`, `destination`, `changeTicket` — all non-secret. `redactPayload` masks the credential key set deeply, so even if n8n execution metadata echoed a credential key it would be masked before persistence.

## Read path, layering, endpoints

Repositories are the sole Drizzle layer; `listAclLog`/`listRouteLog` build conditions with `eq`/`gte`/`lte`, apply the same where to count and select, order by `desc(createdAt)`, and paginate — mirroring `listAudit`. `findByCorrelationId` returns an array ordered newest-first. Services map rows to the Zod response shapes (coalescing nullables, `createdAt.toISOString()`) and never return raw rows. The four endpoints mirror `/api/audit`: `requireAuthenticatedUser`, `safeParse` → 400 `VALIDATION_ERROR`, `ok(...)`, and no `requirePermission`. The correlation handlers validate the id with `CorrelationIdSchema` and return an array (empty = 200), as specified. Query/response schemas in `exec-log.schema.ts` are the source of truth; JSONB fields are `z.unknown().nullable()`.

## Master search extension

`audit.repository.ts` imports `users` and `getTableColumns`, adds `.leftJoin(users, eq(auditLogs.userId, users.userId))` to both the count and select queries, and extends the search OR to `ilike(auditLogs.username, like)`, `ilike(auditLogs.changeTicket, like)`, `ilike(users.displayName, like)`, `ilike(users.email, like)`. Column names match `users.ts` (`displayName`→`display_name`, `email`, `username`). Selecting `getTableColumns(auditLogs)` keeps the row type exactly `AuditRow`, so `toAuditResponse` and `audit.schema.ts` are untouched. The join is applied unconditionally; being a LEFT join with no users-side filter, it does not change row counts when search is absent. All prior filters (module/action/status/changeTicket/correlationId/from/to) are preserved.

## Scope creep

`server/api/users/index.post.ts` and `server/api/users/[id]/reset-password.post.ts` are rewritten to reject with 403 (keeping origin + `ADMINISTRATION_MANAGE` checks), and `app/pages/administration/index.vue` removes the Add-User button and the entire reset-password flow. These are coherent on their own but unrelated to Log Trail, and the `app/` edit contradicts the task's "no frontend/app changes." Several `.kiro/specs/*` files are also modified. None of this affects log-trail behavior, so it is non-blocking, but it should ideally land as a separate change.

</details>

<details>
<summary>File map</summary>

New (untracked):
- `database/schema/acl-logs.ts` — acl_logs table + shared exec-log enums.
- `database/schema/route-logs.ts` — route_logs table (imports shared enums).
- `shared/schemas/exec-log.schema.ts` — Zod response + query schemas and types.
- `server/repositories/acl-log.repository.ts` / `route-log.repository.ts` — insert, filtered list, by-correlation (Drizzle only).
- `server/services/acl-log.service.ts` / `route-log.service.ts` — row→response mappers, list, by-correlation.
- `server/api/acl-logs/index.get.ts` + `correlation/[id].get.ts`; `server/api/route-logs/index.get.ts` + `correlation/[id].get.ts` — read-only authenticated endpoints.

Modified (in scope):
- `database/schema/index.ts` — barrel exports the two new tables.
- `server/services/audit.service.ts` — `record()` returns AuditRow; adds `recordWithDetail`.
- `server/services/acl.service.ts` / `route.service.ts` — write detail rows via `recordWithDetail`.
- `server/repositories/audit.repository.ts` — master search LEFT JOINs users, matches displayName/email.

Modified (OUT of scope — flagged):
- `server/api/users/index.post.ts`, `server/api/users/[id]/reset-password.post.ts` — disabled (403 stubs).
- `app/pages/administration/index.vue` — removed Add-User + reset-password UI.
- `.kiro/specs/n8n-integration/*`, `.kiro/specs/netops-policy-manager/requirements.md`, `.kiro/specs/rbac-permissions/design.md`.

Full diff: `git diff main` + untracked files via `git status`.

</details>
