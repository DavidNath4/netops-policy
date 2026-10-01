# Implementation Plan — Log Trail backend (ACL/ROUTE detail tables + master search)

Scope: backend + DB only. NO `app/` (frontend) changes. The user runs ALL CLI
commands (`db:generate`, `db:migrate`, `npm run typecheck`, `npm run lint`,
`npm test`) — the coder must NOT execute them; stop and ask the user to run them,
then continue from the result.

## Architecture (already decided — do not relitigate)

`audit_logs` stays the single master system of record and keeps recording ALL
modules (incl. ACL/ROUTE) exactly as today; the master Log Trail reads only
`audit_logs`. We ADD two COMPLEMENT tables, `acl_logs` and `route_logs`, that hold
deeper execution-inspection detail for the sensitive ACL/ROUTE operations. Each
detail row is written in the SAME DB transaction as its audit row and links back
via `auditId` (FK → `audit_logs.id`, cascade) and `correlationId`. This
intentionally deviates from the AGENTS.md "no acl/route tables" note; the user
accepted it and will update specs later. Every other project rule still applies
(layering, Zod source of truth, redaction, envelope, Drizzle only in repos).

## Verified facts from the codebase (do not re-derive)

- `database/schema/users.ts` columns: PK `userId` → `user_id` (uuid);
  `displayName` → `display_name` (varchar 150, NOT NULL); `email` → `email`
  (varchar 255, NOT NULL); `username` → `username` (varchar 300, nullable).
  Join master search on `auditLogs.userId = users.userId`.
- `database/schema/audit-logs.ts` style: imports `{ index, jsonb, pgEnum,
  pgTable, timestamp, uuid, varchar }` from `drizzle-orm/pg-core`; PK
  `uuid('id').defaultRandom().primaryKey()`; `timestamp(name,{ withTimezone:
  true }).notNull().defaultNow()`; FK via `.references(() => users.userId,
  { onDelete: ... })`; table-callback returns an ARRAY of `index('name').on(...)`.
- `audit.service.ts record()` currently returns `Promise<void>` and calls
  `insertAudit(db, {...})` which ALREADY returns the inserted `AuditRow`.
- `redactPayload` masks keys `execUsername/execPassword/password/pass/user/
  apiKey/apiToken` deeply; `redactText` masks values in strings.
- `preview.command` is a `string[]` of already-redacted command lines.
- `N8nResult` carries optional `device?: string` and `execution?:
  N8nExecutionMeta`. Services already read `result.execution` and `result.status`.
- API envelope: `ok(data)`, `apiError(400,'VALIDATION_ERROR',msg)`. Audit
  endpoints use `requireAuthenticatedUser(event)` (no `requirePermission`).
- `useDatabase()` returns the shared `Database`. `Paginated<T>` lives in
  `shared/schemas/common.schema.ts`; `PaginationQuerySchema` has `page/limit/
  search`; `CorrelationIdSchema = z.string().uuid()`.
- No migrations dir and no test files exist yet; `npm test` is
  `vitest run --passWithNoTests`. Primary verification is `typecheck` + `lint`.

---

## Items

- [ ] 1. Create `acl_logs` schema table.
      Create `database/schema/acl-logs.ts` mirroring `audit-logs.ts` style. Define
      TWO shared enums here (exported, reused by route-logs — import them there,
      do NOT redefine): `export const execLogActionEnum = pgEnum('exec_log_action',
      ['SHOW','ADD','DELETE'])` and `export const execLogStatusEnum =
      pgEnum('exec_log_status', ['SUCCESS','FAILED'])`. Columns:
      `id uuid defaultRandom primaryKey`;
      `auditId uuid('audit_id').references(() => auditLogs.id, { onDelete:
      'cascade' }).notNull()`;
      `correlationId uuid('correlation_id').notNull()`;
      `action execLogActionEnum('action').notNull()`;
      `status execLogStatusEnum('status').notNull()`;
      `device varchar('device', { length: 255 })`;
      `source varchar('source', { length: 255 })`;
      `destination varchar('destination', { length: 255 })`;
      `commandPreview jsonb('command_preview')`;
      `executionMeta jsonb('execution_meta')`;
      `responseSummary jsonb('response_summary')`;
      `createdAt timestamp('created_at', { withTimezone: true }).notNull().defaultNow()`.
      Indexes array: `index('acl_logs_created_at_idx').on(table.createdAt)`,
      `index('acl_logs_correlation_id_idx').on(table.correlationId)`,
      `index('acl_logs_audit_id_idx').on(table.auditId)`.
      Import `auditLogs` from `./audit-logs`.
      Files: database/schema/acl-logs.ts
      Verify: part of item 4's `npm run typecheck`.

- [ ] 2. Create `route_logs` schema table.
      Create `database/schema/route-logs.ts` mirroring item 1. Import
      `{ execLogActionEnum, execLogStatusEnum }` from `./acl-logs` (do NOT create
      new enums — Postgres enums are global; redefining collides). Same shared
      columns as item 1 (id, auditId cascade FK, correlationId, action, status,
      device, commandPreview, executionMeta, responseSummary, createdAt) PLUS:
      `destination varchar('destination', { length: 255 })` and
      `changeTicket varchar('change_ticket', { length: 64 })`. (No `source`.)
      Indexes: `route_logs_created_at_idx`, `route_logs_correlation_id_idx`,
      `route_logs_audit_id_idx`, and `route_logs_change_ticket_idx` on
      `table.changeTicket`.
      Files: database/schema/route-logs.ts
      Verify: part of item 4's `npm run typecheck`.

- [ ] 3. Register both tables in the schema barrel.
      Append `export * from './acl-logs'` and `export * from './route-logs'` to
      `database/schema/index.ts` (after `audit-logs`). Update the top comment to
      note the two new complement tables. This makes them part of the drizzle
      `schema` object passed in `database/index.ts` (so `db.query.aclLogs` /
      `db.query.routeLogs` work).
      Files: database/schema/index.ts
      Verify: part of item 4's `npm run typecheck`.

- [ ] 4. Generate + apply the migration (USER RUNS CLI).
      Stop and ask the user to run `npm run db:generate` then `npm run db:migrate`
      against the dev DB. Do NOT run these yourself. After the user confirms,
      verify a new SQL file appeared under `database/migrations/` and that the two
      enums + two tables + indexes are in it.
      Files: database/migrations/* (generated — do not hand-edit)
      Verify: user confirms `db:generate` created the migration and `db:migrate`
      applied it with no error; `npm run typecheck` passes (schema compiles).

- [ ] 5. Add exec-log Zod schemas (source of truth for shapes).
      Create `shared/schemas/exec-log.schema.ts`. Define:
      `ExecLogActionSchema = z.enum(['SHOW','ADD','DELETE'])`;
      `ExecLogStatusSchema = z.enum(['SUCCESS','FAILED'])`;
      shared response fields object, then `AclLogResponseSchema` and
      `RouteLogResponseSchema`. Both responses: `id z.string().uuid()`,
      `auditId z.string().uuid()`, `correlationId z.string().uuid()`,
      `action ExecLogActionSchema`, `status ExecLogStatusSchema`,
      `device z.string().nullable()`,
      `commandPreview z.unknown().nullable()`,
      `executionMeta z.unknown().nullable()`,
      `responseSummary z.unknown().nullable()`,
      `createdAt z.string()` (ISO). ACL adds `source z.string().nullable()` and
      `destination z.string().nullable()`. ROUTE adds `destination
      z.string().nullable()` and `changeTicket z.string().nullable()`.
      Query schemas extend `PaginationQuerySchema`:
      `AclLogQuerySchema = PaginationQuerySchema.extend({ action:
      ExecLogActionSchema.optional(), status: ExecLogStatusSchema.optional(),
      correlationId: CorrelationIdSchema.optional(), from: z.string().trim()
      .optional(), to: z.string().trim().optional() })`;
      `RouteLogQuerySchema` = same + `changeTicket: z.string().trim().max(64)
      .optional()`. Export `z.infer` types for all (AclLogResponse,
      RouteLogResponse, AclLogQuery, RouteLogQuery). Import `CorrelationIdSchema,
      PaginationQuerySchema` from `./common.schema`. Mirror `audit.schema.ts`.
      Files: shared/schemas/exec-log.schema.ts
      Verify: part of item 10's `npm run typecheck`.

- [ ] 6. Create the ACL-log repository (Drizzle only).
      Create `server/repositories/acl-log.repository.ts` mirroring
      `audit.repository.ts`. Export `type AclLogRow = typeof aclLogs.$inferSelect`
      and `type InsertAclLog = typeof aclLogs.$inferInsert`. Functions:
      `insertAclLog(db, input: InsertAclLog): Promise<AclLogRow>` — accept an
      optional transaction handle by typing the db param as `Database` (the tx
      object is assignment-compatible for `.insert`); use
      `db.insert(aclLogs).values(input).returning()`, throw if no row.
      `interface AclLogListFilter { page; limit; action?; status?; correlationId?;
      from?: Date; to?: Date }`;
      `listAclLog(db, filter): Promise<{ items: AclLogRow[], total: number }>` —
      build `conditions` with `eq`/`gte`/`lte` on action/status/correlationId/
      createdAt (same count+select+orderBy desc(createdAt)+limit/offset pattern as
      listAudit; no `search` text match needed);
      `findAclLogByCorrelationId(db, correlationId): Promise<AclLogRow[]>` —
      `db.select().from(aclLogs).where(eq(aclLogs.correlationId, id))
      .orderBy(desc(aclLogs.createdAt))`.
      Import `aclLogs` from `~~/database/schema/acl-logs`.
      Files: server/repositories/acl-log.repository.ts
      Verify: part of item 10's `npm run typecheck`.

- [ ] 7. Create the ROUTE-log repository (Drizzle only).
      Create `server/repositories/route-log.repository.ts` mirroring item 6 for
      `routeLogs`: `RouteLogRow`, `InsertRouteLog`, `insertRouteLog`,
      `RouteLogListFilter` (same fields PLUS `changeTicket?: string`, matched with
      `eq(routeLogs.changeTicket, ...)`), `listRouteLog`,
      `findRouteLogByCorrelationId`. Import `routeLogs` from
      `~~/database/schema/route-logs`.
      Files: server/repositories/route-log.repository.ts
      Verify: part of item 10's `npm run typecheck`.

- [ ] 8. Create the exec-log services (map rows → safe Zod shapes, list, by-correlation).
      Create `server/services/acl-log.service.ts` and
      `server/services/route-log.service.ts` mirroring `audit.service.ts`'s read
      path. Each exports: a `toResponse(row)` mapper returning the Zod response
      shape (convert `createdAt` via `.toISOString()`; pass JSONB through as-is —
      already redacted at write time; coalesce nullable columns with `?? null`);
      `list(db, query): Promise<Paginated<AclLogResponse>>` (build filter from
      query, `from/to` → `new Date(...)` when present, map items, return
      `{ items, page: query.page, limit: query.limit, total }`);
      `getByCorrelationId(db, correlationId): Promise<AclLogResponse[]>` (call the
      repo finder, map each). Route service mirrors with `changeTicket` in its
      filter. Import response/query types from `#shared/schemas/exec-log.schema`
      and `Paginated` from `#shared/schemas/common.schema`.
      Files: server/services/acl-log.service.ts, server/services/route-log.service.ts
      Verify: part of item 10's `npm run typecheck`.

- [ ] 9. Refactor `audit.service.record()` to return the inserted row, and add a
      transaction-aware write path used by ACL/ROUTE detail writes.
      In `server/services/audit.service.ts`: change `record()` signature to
      `Promise<AuditRow>` and `return await insertAudit(db, {...})` (import
      `AuditRow` type is already imported). Existing void callers (`AUTH`, `USER`,
      `N8N` paths) ignore the return — no change needed there. Add
      `recordWithDetail<T>(db, input: RecordAuditInput, writeDetail: (tx:
      Database, auditId: string) => Promise<T>): Promise<{ audit: AuditRow,
      detail: T }>` that runs `db.transaction(async (tx) => { const audit = await
      record(tx, input); const detail = await writeDetail(tx, audit.id); return {
      audit, detail } })`. `record()` already redacts the 4 audit payloads; the
      detail writer is responsible for redacting its own payloads (item 10/11).
      This keeps the audit insert + detail insert atomic.
      Files: server/services/audit.service.ts
      Verify: part of item 10's `npm run typecheck`; existing audit read endpoints
      still return the same shape.

- [ ] 10. Write ACL detail rows inside the audit transaction (acl.service.ts).
      In `server/services/acl.service.ts`, replace the two `await record(db,
      {...})` calls (in `aclShow` and `aclExecute`) with `await
      recordWithDetail(db, {...sameAuditInput}, async (tx, auditId) => await
      insertAclLog(tx, {...}))`. The ACL detail row values:
      - `auditId` (from callback), `correlationId`, `action` (`'SHOW'` for
        aclShow, `input.operation` for aclExecute), `status: result.status`,
        `device: result.device ?? null`,
      - `commandPreview`: SHOW → `null`; EXECUTE → `redactPayload(preview.command)`
        (array of already-redacted lines; pass through redactPayload for
        defense-in-depth per the security rule),
      - `executionMeta: redactPayload(result.execution ?? null)`,
      - `responseSummary: redactPayload({ total: result.total ?? null, message:
        result.message ?? null, output: result.output ?? null, error: result.error
        ?? null })` (SHOW has no `output`; omit it or pass null — match the audit
        responsePayload fields already built in each function),
      - ACL SHOW: `source: input.search`, `destination: null`.
      - ACL EXECUTE: `source: input.source`, `destination: input.destination`
        (the human-readable input values, pre-join; add a one-line comment that
        these are the raw address inputs, not the joined "IP MASK" strings, and
        contain no secrets). NEVER persist execUsername/execPassword/user/pass.
      Import `insertAclLog` from `../repositories/acl-log.repository` and
      `recordWithDetail` from `./audit.service`.
      Files: server/services/acl.service.ts
      Verify: `npm run typecheck` passes; `npm run lint` clean. Confirm no
      credential keys are passed into the acl_logs insert.

- [ ] 11. Write ROUTE detail rows inside the audit transaction (route.service.ts).
      Same pattern as item 10 in `server/services/route.service.ts` for
      `routeShow` and `routeExecute`, using `insertRouteLog`:
      - `action`: `'SHOW'` for routeShow, `input.operation` for routeExecute;
        `status`, `device`, `executionMeta`, `responseSummary` as in item 10.
      - `commandPreview`: SHOW → `null`; EXECUTE → `redactPayload(preview.command)`.
      - ROUTE SHOW: `destination: null`, `changeTicket: null`.
      - ROUTE EXECUTE: `destination: joinAddr(input.routeIp, input.routeMask)`
        (reuse the existing local `joinAddr`; it is the "IP MASK" the user sees)
        and `changeTicket: input.changeTicket ?? null`.
      Keep the existing audit input (route execute already passes
      `changeTicket: input.changeTicket ?? null` to the audit row — keep it).
      Import `insertRouteLog` from `../repositories/route-log.repository` and
      `recordWithDetail` from `./audit.service`.
      Files: server/services/route.service.ts
      Verify: `npm run typecheck` passes; `npm run lint` clean.

- [ ] 12. Add read-only API endpoints for ACL logs.
      Create `server/api/acl-logs/index.get.ts` (paginated list) and
      `server/api/acl-logs/correlation/[id].get.ts` (detail rows by
      correlationId). Mirror `server/api/audit/index.get.ts` and `[id].get.ts`
      exactly: `await requireAuthenticatedUser(event)` (NO requirePermission —
      available to every authenticated user like /api/audit);
      list → `AclLogQuerySchema.safeParse(getQuery(event))` → 400 VALIDATION_ERROR
      on failure → `ok(await list(useDatabase(), parsed.data))`;
      correlation → `getRouterParam(event,'id')`, validate with
      `CorrelationIdSchema.safeParse(id)` → 400 if invalid, then `ok(await
      getByCorrelationId(useDatabase(), id))` (returns array; empty array is a
      valid 200, not 404). Import `list`/`getByCorrelationId` from
      `../../services/acl-log.service` (adjust relative depth for the nested
      correlation handler).
      Files: server/api/acl-logs/index.get.ts,
      server/api/acl-logs/correlation/[id].get.ts
      Verify: `npm run typecheck` + `npm run lint`; routes resolve under
      `/api/acl-logs` and `/api/acl-logs/correlation/:id`.

- [ ] 13. Add read-only API endpoints for ROUTE logs.
      Create `server/api/route-logs/index.get.ts` and
      `server/api/route-logs/correlation/[id].get.ts`, mirroring item 12 but using
      `RouteLogQuerySchema` and the route-log service. The route list query
      accepts `changeTicket` (already in the schema).
      Files: server/api/route-logs/index.get.ts,
      server/api/route-logs/correlation/[id].get.ts
      Verify: `npm run typecheck` + `npm run lint`.

- [ ] 14. Extend master audit search to match username, display name, and email.
      In `server/repositories/audit.repository.ts`, add `import { users } from
      '~~/database/schema/users'`. In `listAudit`, when `search` is present, the
      OR condition must also match the joined user's display name and email. Both
      the count and the select queries must apply the SAME LEFT JOIN and WHERE:
      `.from(auditLogs).leftJoin(users, eq(auditLogs.userId, users.userId))`.
      LEFT JOIN because `auditLogs.userId` is nullable (failed logins). Extend the
      search OR to: `or(ilike(auditLogs.username, like), ilike(auditLogs.changeTicket,
      like), ilike(users.displayName, like), ilike(users.email, like))`. Keep all
      existing filters (module/action/status/changeTicket/correlationId/from/to).
      IMPORTANT: with a join, `db.select()` returns `{ audit_logs, users }`
      nested rows — select ONLY audit columns so the return type stays `AuditRow`:
      use `.select({ ...explicit auditLogs columns })` OR
      `.select().from(auditLogs).leftJoin(...)` then map `r => r.audit_logs`.
      Prefer `db.select(getTableColumns(auditLogs))` (import `getTableColumns`
      from `drizzle-orm`) so the row shape remains exactly `AuditRow` and
      `toAuditResponse` is unchanged. Apply the join unconditionally (it does not
      change counts/rows when search is absent since it is a LEFT join and no
      users filter is added), OR only when `search` is set — either is fine;
      document the choice in a comment. The count query uses
      `db.select({ value: count() }).from(auditLogs).leftJoin(users, ...).where(where)`.
      Files: server/repositories/audit.repository.ts
      Verify: `npm run typecheck` passes; `toAuditResponse` and the audit response
      shape are unchanged (no edit to audit.service.ts read path or audit.schema.ts);
      a search string now matches on display name / email in addition to
      username / change ticket.

- [ ] 15. Full verification pass (USER RUNS CLI where noted).
      Ask the user to run, in order: `npm run typecheck`, `npm run lint`,
      `npm test`. Fix any reported errors in the files above. (`npm test` passes
      with no tests via `--passWithNoTests`; there is no existing test harness, so
      do not scaffold one unless the user asks.)
      Files: none (verification only)
      Verify: typecheck + lint clean; test command exits 0.

## Implementation status (iteration 1)

All code/files are written. The following were NOT verified by running commands
(the user runs ALL CLI; the coder must not execute them):

- `npm run db:generate` + `npm run db:migrate` — USER'S RESPONSIBILITY. The two
  new tables (`acl_logs`, `route_logs`), the two shared enums (`exec_log_action`,
  `exec_log_status`), and all indexes exist only in the Drizzle schema; no
  migration SQL has been generated or applied yet.
- `npm run typecheck` — USER'S RESPONSIBILITY. One point to watch: inside
  `recordWithDetail`, the `tx` handle is passed to `record` / `insertAclLog` /
  `insertRouteLog` whose `db` param is typed `Database`. This is the Drizzle
  postgres-js transaction pattern and should typecheck; if TS complains about
  the tx vs Database type, widen the repo/service `db` param to also accept the
  transaction type (fallback noted in the enum note below).
- `npm run lint` and `npm test` — USER'S RESPONSIBILITY.

What changed, by file:
- `database/schema/acl-logs.ts`, `database/schema/route-logs.ts` (new tables +
  shared enums declared once in acl-logs, imported by route-logs).
- `database/schema/index.ts` (barrel exports the two new tables).
- `shared/schemas/exec-log.schema.ts` (Zod response + query schemas, z.infer types).
- `server/repositories/acl-log.repository.ts`, `route-log.repository.ts`
  (insert, paginated/filtered list, findByCorrelationId — Drizzle only).
- `server/services/acl-log.service.ts`, `route-log.service.ts` (toResponse
  mapper, list → Paginated<T>, getByCorrelationId — read path).
- `server/services/audit.service.ts` (`record()` now returns `AuditRow`; added
  `recordWithDetail()` wrapping audit + detail insert in one `db.transaction`).
- `server/services/acl.service.ts`, `route.service.ts` (aclShow/aclExecute,
  routeShow/routeExecute now write the detail row via `recordWithDetail`, all
  JSONB redacted via `redactPayload`; never persist exec creds).
- `server/api/acl-logs/index.get.ts` + `correlation/[id].get.ts`;
  `server/api/route-logs/index.get.ts` + `correlation/[id].get.ts` (read-only,
  authenticated, no requirePermission — mirrors /api/audit).
- `server/repositories/audit.repository.ts` (master search LEFT JOINs users and
  also matches displayName/email; same join+where on count and select; row
  shape unchanged via `getTableColumns`).

## Notes / assumptions

- Shared enums `exec_log_action` / `exec_log_status` are declared once in
  `acl-logs.ts` and imported by `route-logs.ts`; Postgres enum names are global
  so they must not be redefined. If drizzle-kit complains about enum ownership
  across files, move both enums to a tiny `database/schema/exec-log-enums.ts` and
  import from there in both tables — note this fallback for the coder.
- `recordWithDetail` uses `db.transaction` (supported by the postgres-js drizzle
  driver). The detail writer receives the `tx` handle so both inserts commit
  atomically; the audit payloads are redacted inside `record()`, the detail
  payloads are redacted at the call site (items 10/11).
- Detail-row redaction is defense-in-depth: `commandPreview` lines are already
  credential-free, but still pass through `redactPayload`; `executionMeta` and
  `responseSummary` MUST pass through `redactPayload`.
- Review loop stop contract unchanged: reviewer writes
  `.agents/tasks/log-trail-backend/log-trail-review.json` with `verdict`
  = `APPROVED` to stop.
