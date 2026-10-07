# iTop Ticket Integration — Requirements & Technical Design

Status: for review (feeds reviewer → planner).
Scope: a read-only iTop (MariaDB) ticket search/preview flow that gates
ACL/Route add + delete behind a selected ticket, plus two admin "Test
Connection" buttons (iTop + n8n). The User-Mapping page-size change is already
applied and only needs verification.

All file paths are absolute from the repo root
`e:\Work\CLOUD PROJECTS\Netops-policy`. The authoritative facts (iTop schema,
decisions already made) come from `.agents/tasks/itop-ticket-integration/investigation.md`
and `admin-investigation.md`; this document does not re-litigate them.

---

## 1. Requirements (EARS)

### 1.1 iTop ticket search

- R1 — WHEN an authenticated engineer submits a non-empty query on an ACL/Route
  add or delete page, THE system SHALL search the iTop `ticket` parent table by
  `ref` and `title` (case-insensitive, substring) across ALL ticket types and
  return at most `limit` (default 20, max 50) summaries, without filtering by
  status.
- R2 — THE search SHALL query only the parent `ticket` table (no joins, no heavy
  `ORDER BY`) using parameterized placeholders, bounded by a query timeout.
- R3 — IF the query is empty, longer than 64 chars, or missing, THEN THE system
  SHALL reject the request with `VALIDATION_ERROR` and not touch iTop.
- R4 — IF iTop is unconfigured, unreachable, or times out, THEN THE system SHALL
  return `ITOP_UNREACHABLE` with a safe message and SHALL NOT surface SQL,
  stack, connection string, or credentials.

### 1.2 iTop ticket preview

- R5 — WHEN an engineer selects a ticket `ref`, THE system SHALL fetch that
  single ticket row by its indexed `ref`, join only the one type-specific detail
  table resolved from `finalclass`, resolve contact/organization names via
  separate PK `IN (...)` lookups, and return a detail object (summary + resolved
  caller name/email + organization name + a per-type detail block + description).
- R6 — THE preview SHALL pass all iTop-sourced strings (`description` and every
  `detail`-block field, `title`, caller/org names) as plain text; the UI SHALL
  render ALL of them escaped (`{{ }}`, never `v-html` or any raw-HTML sink)
  because iTop rich-text fields may contain HTML/script.
- R7 — IF no ticket matches the `ref`, THEN THE system SHALL return `NOT_FOUND`.
- R8 — THE preview response SHALL contain only mapped, whitelisted fields (never
  a raw DB row).

### 1.3 Ticket requirement on execute

- R9 — THE `changeTicket` field SHALL be REQUIRED on ACL add/delete and Route
  add/delete (the shared `ChangeTicketSchema`, bounded 1..64, unchanged).
- R10 — WHEN an engineer selects a ticket, THE form SHALL set
  `changeTicket = ticket.ref` (e.g. `C-035919`).
- R11 — WHILE no ticket is selected, THE Generate and Execute buttons SHALL stay
  disabled on all four forms.
- R12 — THE existing `changeTicket` audit behavior SHALL remain unchanged (the
  selected `ref` flows into the already-audited field; Log Trail code is not
  touched).

### 1.4 Test Connection (iTop + n8n)

- R13 — WHEN an administrator clicks "Test iTop Connection", THE system SHALL run
  a read-only `SELECT 1` against iTop bounded by the iTop timeout and return
  `{ ok, message }`.
- R14 — WHEN an administrator clicks "Test n8n Connection", THE system SHALL
  perform a lightweight, `N8N_TIMEOUT_MS`-bounded probe against n8n and return
  `{ ok, message }` without leaking the API key. An HTTP status `>= 500` (a
  reverse-proxy/gateway error page while n8n itself is down) SHALL be reported as
  `ok: false` (degraded), not as a passing test; only a sub-500 response counts
  as reachable.
- R15 — THE two test endpoints SHALL require `assertSameOrigin` +
  `requirePermission(ADMINISTRATION_MANAGE)`; their buttons SHALL be visible only
  when `canManage` is true.
- R16 — IF iTop is not configured, THEN the iTop test SHALL return
  `{ ok: false, message }` (never throw, never block boot).

### 1.5 Config / boot

- R17 — THE app SHALL boot successfully when `ITOP_DATABASE_URL` is unset
  (optional env var); iTop features SHALL surface the missing config only at
  call time as `ITOP_UNREACHABLE` / a failed test result.

### Non-functional

- N1 — iTop access is READ-ONLY (SELECT only); no write/DDL is ever issued.
- N2 — No secrets (connection string, password, API key) are logged or returned.
- N3 — Verification is via `npm run typecheck` + `npm run build` only (no unit
  tests, no vitest config added).

### Out of scope

- Changing Log Trail code or `changeTicket` audit storage.
- Pushing config to devices or persisting any iTop/ticket data in the app DB.
- Adding a new RBAC permission for ticket search/preview.
- Re-doing User-Mapping pagination (already `ITEMS_PER_PAGE = 5`).

---

## 2. Architecture overview

iTop is a foreign, read-only MariaDB reached directly from Nitro with the
`mysql2` driver. It is modeled as a thin network client
(`server/network/itop-client.ts`) mirroring `server/network/n8n-client.ts`:
lazily-created connection pool, every call timeout-bounded and never-throwing,
all failures normalized to a safe shape. It is **not** part of the Drizzle
schema.

Layering follows the repo convention exactly:

```
app/pages/{acl,routes}/{add,delete}.vue
  → ItopTicketModal.vue  (search UI, 3 states)
  → useApi().itop.*       (envelope-unwrapping client)
    → POST /api/itop/tickets/search   (handler: thin)
    → POST /api/itop/tickets/preview        assertSameOrigin + requireAuthenticatedUser
      → Zod validate (shared/schemas/itop.schema.ts)
      → server/services/itop.service.ts  (maps rows → Zod response shapes)
        → server/network/itop-client.ts  (mysql2 pool, parameterized SELECTs)
          → iTop MariaDB (read-only)

app/pages/administration/index.vue
  → useApi().itop.testConnection() / .n8n.testConnection()
    → POST /api/itop/test / POST /api/n8n/test
      assertSameOrigin + requirePermission(ADMINISTRATION_MANAGE)
      → itop-client.pingItop() / n8n-client.pingN8n()
```

The search and preview are two POST endpoints (read-only probes, but POST to
honor the `assertSameOrigin` CSRF posture used by every action endpoint).

---

## 3. iTop class → table & ref-prefix mapping (resolves open decision #1)

iTop uses class-table inheritance: the parent `ticket` row carries `finalclass`,
which names the concrete subclass. The detail row lives in a type-specific table
joined on `id = ticket.id`. The mapping the service uses:

| `finalclass`      | ref prefix | detail table      | type label (API) | extra sub-join        |
| ----------------- | ---------- | ----------------- | ---------------- | --------------------- |
| `UserRequest`     | `R-`       | `ticket_request`  | `UserRequest`    | —                     |
| `Incident`        | `I-`       | `ticket_incident` | `Incident`       | —                     |
| `Problem`         | `P-`       | `ticket_problem`  | `Problem`        | —                     |
| `Change`          | `C-`       | `` `change` ``    | `Change`         | —                     |
| `NormalChange`    | `C-`       | `` `change` ``    | `NormalChange`   | `change_normal`       |
| `RoutineChange`   | `C-`       | `` `change` ``    | `RoutineChange`  | `change_routine`      |
| `EmergencyChange` | `C-`       | `` `change` ``    | `EmergencyChange`| `change_emergency`    |

Rules enforced by the resolver:

- The resolver is driven by `finalclass`, NOT by the ref prefix. The ref prefix
  is informational (used only for the UI type badge if desired); search never
  filters by prefix because the engineer types the exact ticket name.
- `` `change` `` is a MariaDB reserved word and is ALWAYS backticked in SQL.
- All four change subtypes read their base row from `` `change` `` (status,
  reason, requestor_id, impact, supervisor/manager ids, dates). `NormalChange`
  additionally joins `change_normal` (acceptance_date, acceptance_comment);
  `RoutineChange`/`EmergencyChange` have no extra columns, so no extra join.
- An unknown `finalclass` (defensive): the preview still returns the parent
  summary + description with an empty per-type block rather than failing.

### 3.1 Column → detail-block field mapping (per finalclass)

The `ItopTicketDetailBlockSchema` fields (§4) map to iTop columns as below. All
fields are optional in the schema, so a given type populates only its own rows
and leaves the rest `undefined`. These are the **best-effort iTop class-table
column names** inferred from the standard iTop ITIL data model; they are NOT
independently verified against this deployment's schema.

> ⚠️ CONFIRM-BEFORE-CODING: the exact column names below (and the parent-table
> columns in §4/§5) are the standard-iTop names and MUST be confirmed against the
> live `itop` schema before writing the SELECTs — e.g. a one-off
> `SELECT * FROM <table> LIMIT 1` (read-only, via the same `ITOP_DATABASE_URL`)
> or `SHOW COLUMNS FROM <table>` during planning. If a column differs or is
> absent, drop that one field (the schema already makes it optional); do not
> invent a value. This confirmation is a planning task, not a design re-decision.

| Block field       | `UserRequest` (`ticket_request`) | `Incident` (`ticket_incident`) | `Problem` (`ticket_problem`) | `Change` + subtypes (`` `change` `` / sub-table) |
| ----------------- | -------------------------------- | ------------------------------ | ---------------------------- | ------------------------------------------------- |
| `status`          | `status`                         | `status`                       | `status`                     | `` `change` ``.`status`                           |
| `impact`          | `impact`                         | `impact`                       | `impact`                     | `` `change` ``.`impact`                           |
| `priority`        | `priority`                       | `priority`                     | `priority`                   | —                                                 |
| `urgency`         | `urgency`                        | `urgency`                      | `urgency`                    | —                                                 |
| `origin`          | `origin`                         | `origin`                       | `origin`                     | —                                                 |
| `reason`          | —                                | —                              | —                            | `` `change` ``.`reason`                           |
| `outage`          | —                                | —                              | —                            | `` `change` ``.`outage`                           |
| `fallback`        | —                                | —                              | —                            | `` `change` ``.`fallback`                         |
| `acceptanceComment` | —                              | —                              | —                            | `change_normal`.`acceptance_comment` (NormalChange only) |
| `resolutionCode`  | `resolution_code`                | `resolution_code`              | —                            | —                                                 |
| `solution`        | `solution`                       | `solution`                     | `solution`                   | —                                                 |

Notes on this mapping:
- The parent `ticket`.`operational_status` is distinct from the subtype
  `status` column: `operationalStatus` on the summary comes from the parent
  table; `detail.status` comes from the subtype/`change` row. Both are returned.
- `RoutineChange`/`EmergencyChange` add no extra columns beyond `` `change` ``,
  so their `detail` block is exactly the Change columns (no sub-table join).
- `NormalChange` left-joins `change_normal` solely for `acceptance_comment`
  (→ `acceptanceComment`).
- `Unknown`/unmatched finalclass: `detail` is `{}` (every field `undefined`);
  only summary + description are returned (defensive, see §3 rule).

The resolver is a pure function in `itop.service.ts`:

```ts
interface ItopClassInfo {
  type: ItopTicketType          // the API type label
  detailTable: 'ticket_request' | 'ticket_incident' | 'ticket_problem' | 'change' | null
  changeSubTable: 'change_normal' | 'change_routine' | 'change_emergency' | null
}
function resolveClass(finalclass: string): ItopClassInfo
```

(`detailTable: 'change'` is emitted to the client-safe layer only; the SQL
builder backticks it.)

---

## 4. Server: Zod schemas (resolves open decision #2)

New file `shared/schemas/itop.schema.ts`. Zod is the source of truth; types via
`z.infer`. No parallel hand-written interfaces.

```ts
import { z } from 'zod'

/** Ticket subtype labels the API exposes (derived from finalclass). */
export const ItopTicketTypeSchema = z.enum([
  'UserRequest', 'Incident', 'Problem',
  'Change', 'NormalChange', 'RoutineChange', 'EmergencyChange', 'Unknown',
])
export type ItopTicketType = z.infer<typeof ItopTicketTypeSchema>

/** Search request body (POST). */
export const ItopTicketSearchSchema = z.object({
  q: z.string().trim().min(1, 'Search value is required').max(64, 'Search value must be at most 64 characters'),
  limit: z.coerce.number().int().positive().max(50).default(20),
})
export type ItopTicketSearchInput = z.infer<typeof ItopTicketSearchSchema>

/** Preview request body (POST) — selected ticket ref. */
export const ItopTicketRefSchema = z.object({
  ref: z.string().trim().min(1).max(64),
})
export type ItopTicketRefInput = z.infer<typeof ItopTicketRefSchema>

/** List item — parent `ticket` columns only, no secrets. */
export const ItopTicketSummarySchema = z.object({
  ref: z.string(),
  title: z.string(),
  type: ItopTicketTypeSchema,          // from finalclass
  operationalStatus: z.string().nullable(),
  startDate: z.string().nullable(),    // ISO string (DATETIME → string)
  endDate: z.string().nullable(),
})
export type ItopTicketSummary = z.infer<typeof ItopTicketSummarySchema>

/** Resolved people/org for the preview header. */
export const ItopTicketPartySchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
})

/**
 * Per-type detail block. A pragmatic common header plus optional fields that
 * only some types have — the UI renders whatever is present (no v-if explosion).
 * All optional/nullable so one shape covers every type.
 */
export const ItopTicketDetailBlockSchema = z.object({
  status: z.string().nullable().optional(),           // subtype status (distinct from operational_status)
  impact: z.string().nullable().optional(),
  priority: z.string().nullable().optional(),
  urgency: z.string().nullable().optional(),
  origin: z.string().nullable().optional(),
  // Change-only
  reason: z.string().nullable().optional(),
  outage: z.string().nullable().optional(),
  fallback: z.string().nullable().optional(),
  acceptanceComment: z.string().nullable().optional(),
  // Request/Incident-only
  resolutionCode: z.string().nullable().optional(),
  solution: z.string().nullable().optional(),
})

/** Full preview response. */
export const ItopTicketDetailSchema = ItopTicketSummarySchema.extend({
  description: z.string().nullable(),            // plain text, UI escapes it
  caller: ItopTicketPartySchema,                 // resolved from caller_id/requestor_id → contact
  organization: z.object({ name: z.string().nullable() }),
  detail: ItopTicketDetailBlockSchema,
})
export type ItopTicketDetail = z.infer<typeof ItopTicketDetailSchema>

/**
 * Shared result shape for BOTH Test Connection endpoints (iTop AND n8n).
 * It lives in itop.schema.ts for proximity to the iTop work; this is
 * intentional and both /api/itop/test and /api/n8n/test import it from here.
 * (Moving it to shared/schemas/connection.schema.ts is a valid alternative but
 * not required — keep it here to avoid a near-empty extra file.)
 */
export const ConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
})
export type ConnectionTestResult = z.infer<typeof ConnectionTestResultSchema>
```

Notes:
- `limit` lives in the body (POST), coerced + bounded; the client passes `20`.
- Dates are returned as strings (MariaDB `DATETIME`/`DATE` → ISO/string) so the
  response is JSON-stable and the UI formats for display.
- The detail block is one optional-field object, not a discriminated union, so
  the UI needs no per-type template branches — it iterates present fields. This
  is the "common header + optional per-type section; UI shows whatever is
  present" shape the brief asked for.

### 4.1 `changeTicket` becomes required

`shared/schemas/acl.schema.ts` and `shared/schemas/route.schema.ts`: drop
`.optional()` on `changeTicket` in `AclFields` / `RouteFields`:

```ts
// before:  changeTicket: ChangeTicketSchema.optional(),
// after:   changeTicket: ChangeTicketSchema,
```

`ChangeTicketSchema` in `shared/schemas/network.schema.ts` stays as-is
(`z.string().trim().min(1).max(64)` — `C-035919` fits). This change flows into
`AclAddSchema`/`AclDeleteSchema`/`AclPreviewSchema`/`AclExecuteSchema` and the
Route equivalents automatically (they merge `*Fields`). No audit change: the
service still forwards `changeTicket` the same way `acl.service.ts` does today.

The four pages' `buildPayload()` currently send `form.changeTicket.trim() ||
undefined`; after this change they send `form.changeTicket` (always set, because
the picker fills it and the buttons are gated on it).

**Remove the assertion cast in every `buildPayload()`.** Each page currently ends
its builder with `return { ... } as AclPreviewInput` / `as RoutePreviewInput`.
That `as` cast SUPPRESSES structural type-checking, so a page that still sends
`changeTicket: ... || undefined` after `changeTicket` becomes required would NOT
fail `tsc`. The plan MUST drop the cast so the object literal is structurally
checked against the (now-required) field, turning a forgotten edit into a compile
error. Concretely, in each of the four pages:

```ts
// before (ACL add shown; delete/route analogous):
function buildPayload(): AclPreviewInput {
  return {
    operation: 'ADD',
    source: form.source.trim(),
    sourceMask: form.sourceMask.trim() || undefined,
    destination: form.destination.trim(),
    destinationMask: form.destinationMask.trim() || undefined,
    changeTicket: form.changeTicket.trim() || undefined,
    execUsername: form.execUsername,
    execPassword: form.execPassword,
  } as AclPreviewInput          // ← cast hides the missing/undefined changeTicket
}

// after:
function buildPayload(): AclPreviewInput {
  return {
    operation: 'ADD',
    source: form.source.trim(),
    sourceMask: form.sourceMask.trim() || undefined,
    destination: form.destination.trim(),
    destinationMask: form.destinationMask.trim() || undefined,
    changeTicket: form.changeTicket,   // required: string, never undefined
    execUsername: form.execUsername,
    execPassword: form.execPassword,
  }                              // ← no cast: structurally checked against AclPreviewInput
}
```

Note the `*PreviewInput` type is a discriminated union on `operation`; removing
the cast means the literal must satisfy the matching member exactly. `operation`
is a string literal in the object, and the optional `*Mask` fields are still
`string | undefined`, so the only field that was being masked by the cast is
`changeTicket`. If dropping the cast surfaces any OTHER pre-existing mismatch
(e.g. the discriminated-union member needing `operation` narrowed), the planner
keeps the field edits but may re-add a narrower, non-suppressing annotation
(`satisfies AclPreviewInput`) rather than `as` — `satisfies` validates without
suppressing. Prefer no annotation; fall back to `satisfies`, never `as`.

---

## 5. Server: iTop client (`server/network/itop-client.ts`)

New file. Mirrors `n8n-client.ts`: lazily-cached pool, bounded, never-throws.
Uses `mysql2/promise`.

```ts
import mysql from 'mysql2/promise'
import { loadEnv } from '../utils/config'

let pool: mysql.Pool | null = null

function getPool(): mysql.Pool | null {
  const env = loadEnv()
  if (!env.ITOP_DATABASE_URL) return null       // iTop not configured
  if (!pool) {
    pool = mysql.createPool({
      uri: env.ITOP_DATABASE_URL,
      connectionLimit: 4,
      connectTimeout: env.ITOP_TIMEOUT_MS,
      // SELECT-only usage; no multipleStatements (defense against injection).
      waitForConnections: true,
      queueLimit: 0,
    })
  }
  return pool
}

export class ItopUnreachableError extends Error {}

/**
 * Run one parameterized query bounded by ITOP_TIMEOUT_MS.
 *
 * The AUTHORITATIVE deadline is the `Promise.race` against a `setTimeout` below
 * — NOT the driver's per-query `timeout` option and NOT the pool's
 * `connectTimeout`. Those two options are too narrow to uphold R2/R4:
 *   - pool `connectTimeout` bounds only the TCP connect of a NEW connection, not
 *     a slow SELECT on an already-open pooled connection;
 *   - mysql2's per-query `{ timeout }` option bounds only receipt of the first
 *     response packet on the driver side; and
 *   - `await p.getConnection()` is itself UNBOUNDED when the pool is exhausted
 *     or the server is unresponsive — a down/slow iTop can hang here before any
 *     query runs.
 * Wrapping the WHOLE operation (connection acquire + query) in the race is the
 * single enforcement point behind the "never block the request, always surface
 * ITOP_UNREACHABLE" guarantee. Use the plain `conn.query(sql, params)` form (no
 * `{ sql, timeout }` object) so array/`IN (?)` expansion is unambiguous (§5
 * resolve* functions depend on it).
 */
async function run<T extends mysql.RowDataPacket[]>(sql: string, params: unknown[]): Promise<T> {
  const p = getPool()
  if (!p) throw new ItopUnreachableError('iTop is not configured')
  const env = loadEnv()
  // Authoritative whole-operation deadline (acquire + query).
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new ItopUnreachableError('iTop timed out')), env.ITOP_TIMEOUT_MS),
  )
  const work = (async () => {
    const conn = await p.getConnection()
    try {
      const [rows] = await conn.query<T>(sql, params)   // plain form → array IN (?) expansion works
      return rows
    }
    finally {
      conn.release()
    }
  })()
  try {
    return await Promise.race([work, deadline])
  }
  catch {
    // Never leak SQL/connection string/driver detail upward.
    throw new ItopUnreachableError('iTop query failed')
  }
}
```

> Note on `connectTimeout`: it is kept in `createPool` as a best-effort TCP-connect
> ceiling, but it is NOT the per-request guarantee — the `Promise.race` deadline
> above is. The implementer must ship the race, not rely on `connectTimeout` or
> the driver `timeout` option alone.

Exported functions (all parameterized, all SELECT):

- `searchTickets(q, limit)` — parent table only, no joins:
  ```sql
  SELECT ref, title, operational_status, start_date, end_date, finalclass
  FROM ticket
  WHERE ref LIKE ? OR title LIKE ?
  LIMIT ?
  ```
  `q` is turned into `%q%` **in JS** and bound as a parameter (never
  interpolated). `limit` is validated to an int ≤ 50 by Zod before reaching
  here; it is still bound as a `?` placeholder.

- `getTicketByRef(ref)` — `SELECT ... FROM ticket WHERE ref = ? LIMIT 1`
  (indexed, instant). Returns the parent row or null.

- `getChangeDetail(id)` / `getRequestDetail(id)` / `getIncidentDetail(id)` /
  `getProblemDetail(id)` — single `WHERE id = ?` against the type table (change
  detail backticks `` `change` `` and, for `NormalChange`, left-joins
  `change_normal` on `id`). Each selects exactly the columns in the §3.1 mapping
  for its type, e.g.:
  ```sql
  -- getRequestDetail(id)  (Incident/Problem analogous against their table)
  SELECT status, impact, priority, urgency, origin, resolution_code, solution, description
  FROM ticket_request WHERE id = ? LIMIT 1
  -- getChangeDetail(id)  (NormalChange left-joins change_normal)
  SELECT c.status, c.impact, c.reason, c.outage, c.fallback, c.requestor_id,
         c.org_id, c.description, cn.acceptance_comment
  FROM `change` c
  LEFT JOIN change_normal cn ON cn.id = c.id
  WHERE c.id = ? LIMIT 1
  ```
  The exact column list per table is the §3.1 table; confirm names against the
  live schema per the §3.1 CONFIRM-BEFORE-CODING note and drop any column that
  does not exist (its block field stays `undefined`). `id` is the parent
  `ticket.id` (class-table inheritance shares the PK), so the detail row is
  fetched by the same `id`.

- `resolveContacts(ids: number[])` / `resolveOrganizations(ids: number[])` —
  single `WHERE id IN (?)` lookups. Two mechanics MUST be followed exactly or the
  SELECTs break at runtime:
  1. **The id array is passed WRAPPED (`[ids]`), never spread (`ids`).** mysql2
     expands a single `?` into `(a, b, c)` ONLY for `connection.query()` (the
     plain form `run()` now uses — see Finding 1) and ONLY when the value is a
     nested array: `WHERE id IN (?)` with params `[ids]`. `params = ids` (spread)
     is WRONG and does not expand. (mysql2 does NOT expand arrays for
     `.execute()`/prepared statements at all; `run()` deliberately uses `.query()`.)
  2. **Empty-array guard precedes the call** — `IN ()` is a SQL syntax error, so
     short-circuit BEFORE `run()`:
  ```ts
  // resolveContacts
  export async function resolveContacts(ids: number[]): Promise<ContactRow[]> {
    if (ids.length === 0) return []          // IN () is invalid SQL — must guard first
    return run<ContactRow[]>('SELECT id, name, email FROM contact WHERE id IN (?)', [ids])
  }                                          //                                       ^^^^ wrapped, not ...ids
  // resolveOrganizations is identical against: SELECT id, name FROM organization WHERE id IN (?)
  export async function resolveOrganizations(ids: number[]): Promise<OrgRow[]> {
    if (ids.length === 0) return []
    return run<OrgRow[]>('SELECT id, name FROM organization WHERE id IN (?)', [ids])
  }
  ```

- `pingItop(): Promise<ConnectionTestResult>` — never-throws; `SELECT 1`:
  ```ts
  export async function pingItop(): Promise<ConnectionTestResult> {
    try {
      if (!getPool()) return { ok: false, message: 'iTop is not configured' }
      await run('SELECT 1', [])
      return { ok: true, message: 'iTop connection OK' }
    } catch {
      return { ok: false, message: 'iTop is unreachable' }
    }
  }
  ```

The `ItopUnreachableError` is caught in the service and mapped to
`apiError(502, 'ITOP_UNREACHABLE', ...)` for search/preview; `pingItop` swallows
it and returns `{ ok:false }` for the test button.

---

## 6. Server: iTop service (`server/services/itop.service.ts`)

Holds the finalclass resolver (§3) and the row → Zod-shape mappers. Never
returns raw rows.

- `searchItopTickets(input: ItopTicketSearchInput): Promise<ItopTicketSummary[]>`
  — calls `searchTickets(input.q, input.limit)` (threading the Zod-validated
  `limit`, default 20 / max 50, through to the SQL `LIMIT ?`), maps each row to
  `ItopTicketSummary` (dates → string, `type` via
  `resolveClass(finalclass).type`, `title`/`operational_status` passed through).

- `getItopTicketDetail(ref: string): Promise<ItopTicketDetail | null>` —
  1. `getTicketByRef(ref)`; if null → return null (handler → `NOT_FOUND`).
  2. `resolveClass(row.finalclass)` → pick the detail fetch.
  3. Fetch the type detail row (change joins its sub-table).
  4. Collect the party ids present (`caller_id` for ticket-side,
     `requestor_id`/`supervisor_id`/`manager_id` for change) and the `org_id`;
     run `resolveContacts` + `resolveOrganizations` with de-duplicated id arrays.
  5. Assemble `ItopTicketDetail`: summary + `description` (raw text) + `caller`
     (resolved from the primary caller/requestor id) + `organization.name` +
     the `detail` block, populated strictly from the §3.1 column→field mapping
     for the resolved `finalclass` (each present column → its block field; absent
     columns stay `undefined`; `Unknown` → `{}`).

The caller for the preview header is: `UserRequest`/`Incident`/`Problem` →
`ticket.caller_id`; `Change`/subtypes → `` `change` ``.`requestor_id`. Both
resolve through `contact.name`/`contact.email`.

All mapping validates nothing user-controlled (data is from iTop), but the
output object is still parsed/shaped to the Zod response schema so the client
contract holds and nothing extra leaks.

---

## 7. Server: endpoints

Four new handlers, all thin (assertSameOrigin → auth → Zod validate →
service/client → `ok(...)`).

**Imports (explicit relative, matching the repo — NOT Nitro auto-imports).** The
snippets below omit imports for brevity, but the repo uses explicit relative
imports everywhere (confirmed in `server/api/acl/show.post.ts`), so the depth
must be exact. Mind the extra nesting: `server/api/itop/tickets/*.post.ts` sits
THREE directories below `server/` (`itop/tickets/`), one deeper than
`server/api/acl/*.post.ts` (two). Therefore for the two `tickets/` handlers:

```ts
// server/api/itop/tickets/search.post.ts  &  preview.post.ts  (3 levels up to server/)
import { assertSameOrigin, requireAuthenticatedUser } from '../../../utils/auth'
import { apiError, ok } from '../../../utils/envelope'
import { searchItopTickets, getItopTicketDetail } from '../../../services/itop.service'
import { ItopUnreachableError } from '../../../network/itop-client'
import { ItopTicketSearchSchema, ItopTicketRefSchema } from '#shared/schemas/itop.schema'
```

The two test handlers are only TWO levels below `server/`
(`server/api/itop/test.post.ts`, `server/api/n8n/test.post.ts`), so they use
`../../utils/auth`, `../../utils/envelope`, `../../network/itop-client`
(`pingItop`) / `../../network/n8n-client` (`pingN8n`), and
`PERMISSIONS` from wherever `requirePermission`/`PERMISSIONS` are exported in
`server/utils/auth` (match `server/api/acl/show.post.ts`'s import exactly). Schema
types come from `#shared/schemas/itop.schema` via the `#shared` alias (not a
relative path), as the existing handlers do.

### `server/api/itop/tickets/search.post.ts`
```ts
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  await requireAuthenticatedUser(event)                 // auth only, NO new RBAC permission
  const parsed = ItopTicketSearchSchema.safeParse(await readBody(event))
  if (!parsed.success) throw apiError(400, 'VALIDATION_ERROR', 'Invalid ticket search request')
  try {
    return ok(await searchItopTickets(parsed.data))
  } catch (e) {
    if (e instanceof ItopUnreachableError) throw apiError(502, 'ITOP_UNREACHABLE', 'iTop is unreachable')
    throw e
  }
})
```

### `server/api/itop/tickets/preview.post.ts`
Same guard; validates `ItopTicketRefSchema`; `getItopTicketDetail(ref)`; null →
`apiError(404, 'NOT_FOUND', 'Ticket not found')`; `ItopUnreachableError` →
`502 ITOP_UNREACHABLE`.

### `server/api/itop/test.post.ts`
```ts
assertSameOrigin(event)
await requirePermission(event, PERMISSIONS.ADMINISTRATION_MANAGE)
return ok(await pingItop())        // { ok, message }; never throws
```

### `server/api/n8n/test.post.ts`
```ts
assertSameOrigin(event)
await requirePermission(event, PERMISSIONS.ADMINISTRATION_MANAGE)
return ok(await pingN8n())
```

Rationale for auth split (decision already made, restated): search/preview is a
sub-step of an add/delete the user is already permitted to do and is read-only —
authenticated + same-origin is sufficient and avoids a seed/DB change. The test
endpoints are an operational diagnostic → admin-only (`ADMINISTRATION_MANAGE`).

---

## 8. Server: n8n ping (`pingN8n()` — resolves open decision #4)

Add to `server/network/n8n-client.ts`, modeled on `validateDeviceCredentials`
(same timeout + never-throw + no key leak).

Decision: **GET the n8n base host root**, not the webhook path. Reason — the app
only knows `N8N_BASE_URL` (a `/webhook` base) and `N8N_API_KEY`; there is no
documented health webhook, and POSTing a fake webhook could trigger a workflow.
A connectivity probe only needs to prove the host answers. So:

```ts
export async function pingN8n(): Promise<ConnectionTestResult> {
  const env = loadEnv()
  // Probe the origin root (scheme+host), independent of the webhook path.
  const base = new URL(env.N8N_BASE_URL)
  const url = `${base.protocol}//${base.host}/`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), env.N8N_TIMEOUT_MS)
  try {
    // GET (not HEAD): some reverse proxies reject HEAD. The API key is NOT sent
    // here (health probe needs no auth, and we never leak it).
    const res = await fetch(url, { method: 'GET', signal: controller.signal })
    // Qualify success: a 5xx is typically a reverse proxy / gateway answering
    // while n8n itself is down (502/503/504) — report that as degraded, NOT ok.
    // A sub-500 response (incl. 401/404 from the n8n app) means the host answers.
    if (res.status >= 500) {
      return { ok: false, message: `n8n host responded HTTP ${res.status} — service may be down` }
    }
    return { ok: true, message: `n8n reachable (HTTP ${res.status})` }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return { ok: false, message: aborted ? 'n8n request timed out' : 'n8n is unreachable' }
  } finally {
    clearTimeout(timeout)
  }
}
```

Reachability rule (chosen): a sub-500 HTTP response (including `401`/`404` from
the n8n app) counts as "reachable" because the goal is a connectivity check, not
a workflow auth check. A `>= 500` status is treated as DEGRADED/down (`ok: false`)
because a reverse proxy or load balancer commonly answers `502`/`503`/`504` while
n8n itself is down — reporting that as green would be a false positive that
defeats R14's whole purpose. A transport failure/timeout is the other "down"
signal. The API key is intentionally not attached (no secret on the wire for a
health probe). (A non-mutating `HEAD`/`OPTIONS` against the webhook base was
considered but rejected: some reverse proxies reject `HEAD`, and the host-root
GET with the 5xx qualifier gives the same signal without that fragility.)

---

## 9. Server: envelope + config + deps

### 9.1 `server/utils/envelope.ts`
Add to the `ErrorCode` union: `'ITOP_UNREACHABLE'`. (`N8N_UNREACHABLE` is not
needed — the n8n/itop *test* endpoints return `ok({ ok:false })` rather than
throwing; search/preview is the only path that throws, and only for iTop.)

### 9.2 `server/utils/config.ts`
Add to `EnvSchema` (after the N8N block), both optional so boot never breaks:

```ts
// -------------------------------------------------------------------------
// iTop (read-only MariaDB) ticket lookup. Optional — the app boots without it;
// ticket endpoints return ITOP_UNREACHABLE and the admin Test button reports
// "not configured" when unset. See .kiro/specs/n8n-integration.
// -------------------------------------------------------------------------
ITOP_DATABASE_URL: z.string().url('ITOP_DATABASE_URL must be a valid URL').optional(),
ITOP_TIMEOUT_MS: z.coerce.number().int().positive('ITOP_TIMEOUT_MS must be a positive integer').default(10000),
```

No `runtimeConfig` is introduced (none exists; config is `loadEnv()` only).

### 9.3 `.env.example`
Append an iTop block mirroring the n8n block, including the percent-encoding
note:

```
# ---------------------------------------------------------------------------
# iTop ticket lookup (read-only MariaDB)
# See .kiro/specs/n8n-integration/ for the ticket flow.
#
# OPTIONAL: leave unset and the app still boots; the ACL/Route ticket picker and
# the Administration "Test iTop Connection" button will report iTop as
# unavailable. iTop is queried READ-ONLY (SELECT only). FILL MANUALLY, never
# commit the real value.
#
# mysql://USER:PASSWORD@HOST:3306/itop
# NOTE: if the password contains URL-special characters they MUST be
# percent-encoded:  #  →  %23     @  →  %40     :  →  %3A     /  →  %2F
# ---------------------------------------------------------------------------
# ITOP_DATABASE_URL=mysql://USER:PASSWORD@HOST:3306/itop

# Bounded per-query timeout in milliseconds (optional; default 10000).
ITOP_TIMEOUT_MS=10000
```

### 9.4 `package.json`
Add `mysql2` to `dependencies`, pinned exact (matching the repo convention of
pinning native/driver packages like `postgres 3.4.9`, `argon2 0.45.1`,
`ldapts 9.2.0`):

```
"mysql2": "3.15.3"
```

The user runs `npm install` (per AGENTS.md). Plan step should instruct the exact
command; if `3.15.3` is unavailable the planner picks the current stable and
pins it exactly.

---

## 10. Frontend: ticket picker

### 10.1 Selection scope (resolves open decision #3)

Decision: **per-form local selection**, not a session-scoped singleton.
Rationale:
- The device-credentials singleton exists because one credential set is reused
  across every search on every page in a session. A ticket is the opposite: each
  add/delete is tied to its own specific change ticket, and leaking a previously
  selected ticket into the next form would be a correctness/audit hazard
  (R12 — the audited `ref` must match the action).
- The form already owns `changeTicket`, invalidates its preview on any change,
  and clears on success. A per-form `selectedTicket` ref fits that lifecycle
  with no cross-page state and no stale-selection bug.

So each page holds `const selectedTicket = ref<ItopTicketSummary | null>(null)`
and sets `form.changeTicket = selectedTicket.value.ref` on select;
`resetFields()` also clears `selectedTicket`. No `useItopTicket.ts` composable is
created.

### 10.2 `app/components/ItopTicketModal.vue` (new)

A `UModal` (same pattern as `DeviceCredentialsModal.vue`) with search → results →
preview. Props/emits:

```ts
const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'selected': [ticket: ItopTicketSummary]   // parent sets form.changeTicket = ticket.ref
}>()
```

Internal state and behavior:
- Search `UInput` (forced light look: `color="neutral" variant="outline"
  :ui="{ base: 'bg-panel text-ink ring-line placeholder:text-muted' }"`), with a
  search `UButton` (brand) + Enter-to-search; `q` trimmed, min 1.
- Debounced or button-triggered call `useApi().itop.searchTickets(q)` → results.
- Three states via the shared components:
  - `LoadingState` while the search/preview is pending.
  - `EmptyState` (icon `i-lucide-ticket`) when a search returns zero rows.
  - `ErrorState` (emits `retry`) when the call throws (ITOP_UNREACHABLE etc.),
    showing the server message via the local `toMessage(e)` reader.
- Results list: each row shows `ref` (mono), a type badge (`StatusBadge` or a
  token-styled pill from `type`), and truncated `title`. Clicking a row calls
  `itop.getTicket(ref)` and shows a preview card (summary header: ref, type,
  operationalStatus, start/end; caller name/email; organization; the present
  detail-block fields; and the description).
- **XSS rule — render EVERY iTop-sourced string via `{{ }}` (escaped) and NEVER
  `v-html`.** This covers not just `description` but all `detail`-block strings
  (`reason`, `outage`, `fallback`, `acceptanceComment`, `solution`,
  `resolutionCode`, `status`, `impact`, `priority`, `urgency`, `origin`), the
  `title`, and the resolved `caller`/`organization` names — iTop stores several
  of these as rich-text/HTML and any of them may carry markup or script. Do NOT
  pass any iTop string into a `v-html` directive or into any Nuxt UI component
  slot/prop that renders raw HTML; use plain text interpolation only. Vue `{{ }}`
  escapes, so the rule is satisfied as long as no raw-HTML sink is introduced.
- A "Use this ticket" brand button in the preview emits `selected` with the
  summary and closes the modal.
- All token classes only (`bg-panel`, `border-line`, `text-ink`, `text-muted`,
  `text-ok`/`text-bad`, `bg-brand`). Icon-only buttons get `aria-label`.
  `FormField` is reused unmodified for the search field (not restyled).

### 10.3 The four page rewrites

`app/pages/acl/add.vue`, `app/pages/acl/delete.vue`, `app/pages/routes/add.vue`,
`app/pages/routes/delete.vue`. Each currently renders the `changeTicket` block as
a raw `<input ... v-model="form.changeTicket" placeholder="e.g. CHG-123456"
:class="inputClass">` inside `<FormField label="Ticket Change"
name="changeTicket">`. Keep the existing label text ("Ticket Change") and
`name="changeTicket"` as-is — only add `required` and swap the free-text input
for a read-only display + a "Select ticket" trigger (do NOT rename the field):

```vue
<FormField label="Ticket Change" name="changeTicket" required>
  <template #default="{ id }">
    <div class="flex items-center gap-2">
      <input :id="id" :value="form.changeTicket" type="text" readonly
             placeholder="No ticket selected" :class="inputClass">
      <UButton color="neutral" variant="outline" icon="i-lucide-search"
               label="Select ticket" @click="ticketModalOpen = true" />
    </div>
  </template>
</FormField>
<ItopTicketModal v-model="ticketModalOpen" @selected="onTicketSelected" />
```

Script additions per page:
```ts
const ticketModalOpen = ref(false)
const selectedTicket = ref<ItopTicketSummary | null>(null)
function onTicketSelected(t: ItopTicketSummary) {
  selectedTicket.value = t
  form.changeTicket = t.ref
}
```
- `inputClass` stays (reused, now `readonly`); the field is filled only by the
  picker so engineers cannot type a free-form ticket.
- `buildPayload()` sends `changeTicket: form.changeTicket` (no `|| undefined`,
  no `as *Input` cast — see §4.1).
- Button gating (R11): the Generate button is a native
  `<button :disabled="...">`, so the edit appends to the EXISTING `:disabled`
  expression (a disabled-condition, not an enabled-condition). Add
  `|| !form.changeTicket` so the button is disabled while no ticket is selected.
  Exact per-page expressions:
  - `app/pages/acl/add.vue` and `app/pages/acl/delete.vue`:
    `:disabled="generating || !ipsValid || !form.changeTicket"`
  - `app/pages/routes/add.vue` and `app/pages/routes/delete.vue`:
    `:disabled="generating || !ipValid || !form.changeTicket"`

  (Do NOT write `... && !!form.changeTicket` — that would combine with the
  existing `||` chain incorrectly; the gate must be another `|| !form.changeTicket`
  disable term.) The Execute button is unchanged (it only renders via `v-else`
  once a `preview` exists, which now cannot happen without a ticket because
  Generate is blocked). Add a short helper note under the field when
  `!form.changeTicket`: "Select a change ticket to enable Generate." (token
  `text-muted`; use `text-bad` + `role="alert"` only if you choose to render it
  as a validation error).
- `resetFields()` (called only after a successful execute) additionally clears
  `selectedTicket.value = null` — this is the ONLY place, besides a new modal
  selection, that may reset the selection.
- Interaction with the existing `watch(form, ...)` (confirmed in source: it sets
  `preview = null`, `result = null`, `warningMsg = null` on any form change):
  - The watcher MUST NOT be modified to clear `selectedTicket` or
    `form.changeTicket`. Only `resetFields()` (post-execute) and a new modal
    selection change them. If a user edits another field, the stale preview
    clears but the selected ticket is intentionally retained.
  - Selecting a DIFFERENT ticket mutates `form.changeTicket` (via
    `onTicketSelected`), which the existing `watch(form)` observes, so a stale
    preview is invalidated by the same mechanism as any other field change — no
    extra watcher is added.
  - `selectedTicket` and `form.changeTicket` are two refs by design:
    `form.changeTicket` is the audited/submitted value (the `ref` string) that
    the watcher and `buildPayload()` read; `selectedTicket` holds the richer
    summary only so the UI can show the picked ticket's title/type. They are
    written together in `onTicketSelected` and cleared together in
    `resetFields()`, so they never diverge in a way the server sees.
  - The readonly `<input :value="form.changeTicket">` is a plain binding on a
    reactive property, so `watch(form)` still tracks changes to it (readonly on
    the DOM element does not affect Vue reactivity; the value is set
    programmatically in `onTicketSelected`, not typed).

### 10.4 `app/composables/useApi.ts` additions

Add an `itop` group and an `n8n` group. Search/preview use POST (CSRF posture);
the test endpoints also POST:

```ts
itop: {
  searchTickets(q: string, limit = 20): Promise<ItopTicketSummary[]> {
    return apiSend<ItopTicketSummary[]>('/api/itop/tickets/search', 'POST', { q, limit })
  },
  getTicket(ref: string): Promise<ItopTicketDetail> {
    return apiSend<ItopTicketDetail>('/api/itop/tickets/preview', 'POST', { ref })
  },
  testConnection(): Promise<ConnectionTestResult> {
    return apiSend<ConnectionTestResult>('/api/itop/test', 'POST')
  },
},
n8n: {
  testConnection(): Promise<ConnectionTestResult> {
    return apiSend<ConnectionTestResult>('/api/n8n/test', 'POST')
  },
},
```
Import the types from `#shared/schemas/itop.schema`.

---

## 11. Frontend: Test Connection buttons (Administration page)

`app/pages/administration/index.vue`. After the `<Pagination>` block add a small
"Connections" section, visible only when `canManage`:

```vue
<div v-if="canManage" class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4">
  <h2 class="text-[17px] font-semibold text-ink">Connections</h2>
  <div class="flex flex-wrap items-center gap-3">
    <UButton color="neutral" variant="outline" icon="i-lucide-plug"
             label="Test iTop Connection" :loading="itopTesting" @click="testItop" />
    <UButton color="neutral" variant="outline" icon="i-lucide-plug"
             label="Test n8n Connection" :loading="n8nTesting" @click="testN8n" />
  </div>
</div>
```

Script additions (reuse the page's existing `toast` + `errorMessage` helpers):
```ts
// Merge into the page's existing destructure (do NOT add a second useApi() call):
//   const { users, roles: rolesApi } = useApi()
// becomes:
const { users, roles: rolesApi, itop, n8n } = useApi()
const itopTesting = ref(false)
const n8nTesting = ref(false)

async function testItop() {
  itopTesting.value = true
  try {
    const r = await itop.testConnection()
    r.ok ? notifySuccess(r.message) : notifyError(r.message)
  } catch (e) { notifyError(errorMessage(e, 'iTop test failed.')) }
  finally { itopTesting.value = false }
}
// testN8n is identical against n8n.testConnection()
```

Feedback uses the existing toast pattern (`notifySuccess`/`notifyError`), so no
new component. (A `text-ok`/`text-bad` inline pill is an acceptable alternative,
but toast matches the rest of the page and is less code.)

### 11.1 User-Mapping pagination (verify only)
`ITEMS_PER_PAGE = 5` is already set in `app/pages/administration/index.vue`
(confirmed) and the server clamps `limit` to `[1,100]` and returns
`{ items, total, page, limit }`, so pagination beyond 5 works. The planner must
only VERIFY this (no edit): list loads 5, `<Pagination v-if="total > 5">`
renders, page changes refetch.

---

## 12. Error handling (concrete, per operation)

| Operation | Failure | Recoverable? | Caller receives | Logged? |
| --- | --- | --- | --- | --- |
| search validate | empty/too-long/missing `q` | yes (user retypes) | 400 `VALIDATION_ERROR` | no |
| searchTickets | iTop unset/unreachable/timeout | yes (retry) | 502 `ITOP_UNREACHABLE`, safe msg | no secret; generic server log only |
| getTicketByRef | no match | yes | 404 `NOT_FOUND` | no |
| getItopTicketDetail | iTop unreachable mid-fetch | yes | 502 `ITOP_UNREACHABLE` | no secret |
| pingItop | not configured | n/a | `{ ok:false, 'iTop is not configured' }` | no |
| pingItop | unreachable/timeout | n/a | `{ ok:false, 'iTop is unreachable' }` | no |
| pingN8n | unreachable/timeout | n/a | `{ ok:false, 'n8n is unreachable'/'timed out' }` | no |
| pingN8n | host answers HTTP ≥ 500 (proxy up, n8n down) | n/a | `{ ok:false, 'n8n host responded HTTP 5xx — service may be down' }` | no |
| test endpoints authz | not admin | no | 403 `FORBIDDEN` | no |
| any endpoint | cross-origin | no | 403 `FORBIDDEN_ORIGIN` | no |

Invariants and ownership:
- READ-ONLY (N1): owned by `itop-client.ts` — it issues only SELECT/`SELECT 1`,
  no `multipleStatements`, and all input is a bound `?` placeholder, so no DDL/DML
  can be injected. This is the single enforcement point.
- No-secret-leak (N2): owned by `itop-client.ts` (catches driver errors and
  re-throws a generic `ItopUnreachableError`) and the handlers (map to a fixed
  safe message). `pingN8n`/`pingItop` never attach or echo the key/URL.
- Ticket-required (R9–R11): the Zod schema owns the server-side invariant
  (request rejected without `changeTicket`); the UI button-gating is a UX
  convenience, re-validated on the server.

Input validation summary:
- `q`: required, string, trimmed, 1..64; failure → 400 `VALIDATION_ERROR`.
- `limit`: optional, int, 1..50, default 20 (coerced); out of range → clamped by
  Zod `.max(50)` (reject) — planner may `.catch(20)` if lenient coercion is
  preferred, but the brief says max 50 so reject-above-50 is the default.
- `ref`: required, string, trimmed, 1..64; failure → 400.
- `%` LIKE wildcards are added in JS and the whole value is bound as a parameter;
  user `%`/`_` are treated as literal-ish search chars (acceptable for a search
  box) — not an injection risk because the value never enters SQL text.

---

## 13. Spec-doc updates (keep docs in sync)

Primary home: `.kiro/specs/n8n-integration/` (it already owns the ACL/Route
forms, the `changeTicket` audit field, and the Device-Session-Credentials
pattern).

- `.kiro/specs/n8n-integration/requirements.md` — add EARS requirements R1–R17
  (ticket search/preview, required selection, test buttons, optional iTop config).
- `.kiro/specs/n8n-integration/design.md` —
  - under "Field payloads per operation (Req 4)": note `changeTicket` is now
    REQUIRED and carries the selected iTop `ref`.
  - add a sibling subsection to "Device Session Credentials" describing the iTop
    ticket picker (read-only, per-form selection, two POST endpoints, auth model)
    and the `pingN8n`/`pingItop` test endpoints.
- `.kiro/specs/netops-policy-manager/design.md` —
  - Data Models → Zod Application Schemas: add `itop.schema.ts`.
  - Components and Interfaces → API Endpoints: add the four `/api/itop/*` +
    `/api/n8n/test` rows.
  - Frontend Components: add `ItopTicketModal.vue`.
  - Config/env: add `ITOP_DATABASE_URL` + `ITOP_TIMEOUT_MS` rows (mirroring
    `N8N_*`).
- `AGENTS.md` config note: optionally mention iTop as a second read-only external
  DB (SELECT-only, optional env). Not required but consistent.

Do NOT touch `app/pages/logs/*` or audit read endpoints.

---

## 14. Testability

- Unit-testable in principle (no live DB): `resolveClass(finalclass)`, the row →
  Zod mappers, and `itop.schema` parsing. The service is testable with the client
  mocked. Per the brief, no tests and no vitest config are added now; these are
  simply the natural seams if tests are added later.
- Integration-level: the two test endpoints and search/preview can be exercised
  manually against a configured iTop; without `ITOP_DATABASE_URL` they
  deterministically return the "not configured"/`ITOP_UNREACHABLE` paths, which
  is itself a useful boot-resilience check.
- Verification for this change set: `npm run typecheck` then `npm run build`
  (user runs them).
- The `changeTicket`-required change is caught at compile time **only if the
  `as AclPreviewInput` / `as RoutePreviewInput` assertion cast is removed from
  each `buildPayload()`** (see §4.1). The cast suppresses the missing/undefined
  property error, so WITH the cast `tsc` would NOT flag a page that still sends
  `changeTicket: ... || undefined`. The plan removes the cast (preferring no
  annotation, falling back to `satisfies`, never `as`); once removed, a forgotten
  payload edit is a hard `tsc` error — this is the compile-time safety net N3
  relies on.
- Belt-and-suspenders manual check (because N3 adds no runtime tests): after the
  edits, confirm each of the four pages' `buildPayload()` sends
  `changeTicket: form.changeTicket` with NO `|| undefined` and NO `as *Input`
  cast, and that `onGenerate`/`onExecute` are gated per §10.3.

---

## 15. File-change inventory (for the planner)

New files:
- `shared/schemas/itop.schema.ts`
- `server/network/itop-client.ts`
- `server/services/itop.service.ts`
- `server/api/itop/tickets/search.post.ts`
- `server/api/itop/tickets/preview.post.ts`
- `server/api/itop/test.post.ts`
- `server/api/n8n/test.post.ts`
- `app/components/ItopTicketModal.vue`

Modified files:
- `shared/schemas/acl.schema.ts` (changeTicket required)
- `shared/schemas/route.schema.ts` (changeTicket required)
- `server/utils/envelope.ts` (add `ITOP_UNREACHABLE`)
- `server/utils/config.ts` (ITOP_DATABASE_URL + ITOP_TIMEOUT_MS)
- `server/network/n8n-client.ts` (add `pingN8n`)
- `.env.example` (iTop block)
- `package.json` (mysql2 pinned)
- `app/composables/useApi.ts` (itop + n8n groups)
- `app/pages/acl/add.vue`, `app/pages/acl/delete.vue`,
  `app/pages/routes/add.vue`, `app/pages/routes/delete.vue` (picker + gating)
- `app/pages/administration/index.vue` (Test Connection buttons)
- specs under `.kiro/specs/` (§13)

Verify-only (no edit): `ITEMS_PER_PAGE = 5` in
`app/pages/administration/index.vue`.
```

Reminder: when editing the four pages, also DROP the `as AclPreviewInput` /
`as RoutePreviewInput` cast in each `buildPayload()` (§4.1) so the required
`changeTicket` is actually enforced by `tsc`.

---

## 16. Responses to design review (`design-review.json` / `design-review.md`)

All findings resolved; no fixed DECISION or iTOP SCHEMA FACT was re-litigated.

- **Finding 1 (HIGH — `as` cast defeats the compile-time safety net):** ADDRESSED.
  §4.1 now instructs removing the `as AclPreviewInput`/`as RoutePreviewInput`
  cast in all four `buildPayload()` (prefer no annotation, fall back to
  `satisfies`, never `as`), with before/after code. §14 is corrected to state the
  typecheck catches a missed edit ONLY after the cast is removed, and adds an
  explicit manual verification step. §15 carries a reminder. Confirmed against
  source that all four pages use the cast.
- **Finding 2 (MEDIUM — per-type column→field mapping unspecified):** ADDRESSED.
  New §3.1 gives a concrete per-finalclass column→block-field table and threads
  it into §5's SELECTs and §6's assembly step. Because the exact iTop column
  names are a fixed brief fact that was never enumerated in the inputs and could
  not be independently verified, the mapping is the standard-iTop names with an
  explicit CONFIRM-BEFORE-CODING note (planning-time `SHOW COLUMNS` / `SELECT *
  LIMIT 1`), and every block field is optional so an absent column simply stays
  `undefined`. This is a clarity/completeness fix, not an override of the fixed
  schema facts.
- **Finding 3 (MEDIUM — Generate-button gating against the real `:disabled`):**
  ADDRESSED. §10.3 now gives the exact `:disabled` expressions
  (ACL: `generating || !ipsValid || !form.changeTicket`; Route:
  `generating || !ipValid || !form.changeTicket`) and explicitly warns against
  the `&& !!form.changeTicket` phrasing. Confirmed against source that the
  buttons use `:disabled="generating || !ipsValid"` / `|| !ipValid`.
- **Finding 4 (MEDIUM — watch/selectedTicket interaction):** ADDRESSED. §10.3
  now states the watcher must NOT clear `selectedTicket`/`form.changeTicket`
  (only `resetFields()` and a new modal selection do), that selecting a different
  ticket mutates `form.changeTicket` which the existing watcher observes to
  invalidate a stale preview, documents why the two refs exist and that they are
  always written/cleared together, and confirms the readonly input stays reactive.
- **Finding 5 (NIT — admin destructure):** ADDRESSED. §11 now shows the single
  merged `const { users, roles: rolesApi, itop, n8n } = useApi()`.
- **Finding 6 (NIT — shared result shape in itop.schema.ts):** ADDRESSED
  (kept as-is per the reviewer's "acceptable"). Added a comment on
  `ConnectionTestResultSchema` noting it is intentionally shared by both the iTop
  and n8n test endpoints.
- **Finding 7 (NIT — thread `limit` to SQL):** ADDRESSED. §6 now states
  `searchItopTickets` calls `searchTickets(input.q, input.limit)`.

The four previously-OPEN decisions remain resolved and documented: finalclass→
detail-table mapping (§3 + new §3.1), Zod shapes (§4), per-form ticket-picker
UX with no composable (§10.1–§10.3), and the n8n GET-host-root probe (§8).

---

## 17. Responses to the SECOND design review (`design-review.json` / `design-review.md`)

Second review verdict was CHANGES_REQUESTED (1 HIGH + 2 MEDIUM + 4 NITs). All
blocking findings resolved; no fixed DECISION or iTOP SCHEMA FACT was
re-litigated, and the four open decisions stay resolved as above.

- **Finding 1 (HIGH — per-query timeout not actually enforced):** ADDRESSED. §5
  `run()` now wraps the WHOLE operation (connection acquire + query) in a
  `Promise.race` against a `setTimeout(ITOP_TIMEOUT_MS)` that rejects with
  `ItopUnreachableError`, uses the plain `conn.query(sql, params)` form (dropping
  the `{ sql, timeout }` object form), and a doc comment states explicitly that
  the race deadline — NOT the pool `connectTimeout` nor the driver `timeout`
  option — is the authoritative bound. `createPool` keeps `connectionLimit: 4`,
  `connectTimeout`, `waitForConnections: true`, `queueLimit: 0` as a best-effort
  TCP ceiling only. This closes the unbounded `getConnection()` path that
  defeated R2/R4.
- **Finding 2 (MEDIUM — `IN (?)` array expansion):** ADDRESSED. §5
  `resolveContacts`/`resolveOrganizations` now specify params as `[ids]`
  (wrapped, not spread), place the `ids.length === 0 → return []` guard in the
  CODE (before `run`, since `IN ()` is invalid SQL), and rely on the plain
  `conn.query(sql, params)` form (per Finding 1) so array expansion is
  unambiguous. The incompatibility of `.execute()`/prepared statements with array
  expansion is called out so the implementer does not switch call forms.
- **Finding 3 (MEDIUM — n8n probe false-positives on proxy error pages):**
  ADDRESSED. §8 `pingN8n` keeps the host-root GET but now qualifies success:
  HTTP `>= 500` returns `{ ok: false, 'n8n host responded HTTP 5xx — service may
  be down' }` (degraded), while sub-500 (incl. 401/404 from the n8n app) is "up".
  R14 and the §12 error table are updated with the degraded case. The chosen rule
  and why HEAD/OPTIONS-on-webhook was rejected are documented.
- **Finding 4 (NIT — handler imports/relative-path depth):** ADDRESSED. §7 now
  states the exact relative-import depth: the two `tickets/*.post.ts` handlers are
  three levels below `server/` (`../../../utils/*`, `../../../services/*`,
  `../../../network/*`), the two `test.post.ts` handlers are two levels
  (`../../utils/*`, `../../network/*`), and schema types come via the `#shared`
  alias — matching `server/api/acl/show.post.ts`.
- **Finding 5 (NIT — `requireAuthenticatedUser` return discarded):** NO CHANGE
  (reviewer confirmed no issue; the auth-only decision is faithfully applied and
  the function exists and returns `UserRow`).
- **Finding 6 (NIT — `ConnectionTestResultSchema` shared from `itop.schema.ts`):**
  NO CHANGE (reviewer confirmed acceptable; not "fixed" preemptively — the
  `shared/schemas/connection.schema.ts` move remains the documented fallback if
  later objected to).
- **Finding 7 (NIT — escape ALL iTop strings, not just `description`):**
  ADDRESSED. §10.2 and R6 now require EVERY iTop-sourced string (all `detail`
  fields, `title`, caller/org names, as well as `description`) to render via
  `{{ }}` with no `v-html` / raw-HTML sink.
