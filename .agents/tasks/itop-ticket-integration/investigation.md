# iTop Ticket Integration — Investigation Report

Read-only investigation of the NetOps Policy Manager repo to drive the upcoming
work: replace the free-text "Ticket Change" input on the ACL/Route add/delete
forms with a search → pick → preview → (then enable execute) flow backed by a
new read-only iTop (MariaDB) module. No code was changed.

---

## Summary answer (TL;DR)

- **Config:** `server/utils/config.ts` is a single Zod `EnvSchema` object parsed
  from `process.env`. There is **no `runtimeConfig`** block anywhere — all config
  is server-only, read via `loadEnv()`. Add `ITOP_DATABASE_URL` as a new key in
  `EnvSchema` and a placeholder in `.env.example`. It is validated at startup by
  `server/plugins/validate-env.ts`.
- **DB access:** The app's own Postgres is opened in `database/index.ts`
  (`drizzle-orm/postgres-js` + `postgres` driver), cached once in
  `server/utils/db.ts` via `useDatabase()`. **`mysql2` is NOT a direct
  dependency** — it only appears in `package-lock.json` as an optional peer of
  Drizzle. It must be added to `package.json`.
- **Layering (ACL end-to-end):** handler `server/api/acl/show.post.ts` →
  `assertSameOrigin` → `requirePermission` → Zod `safeParse` → `useDatabase()` →
  service `server/services/acl.service.ts` → `ok(...)` envelope. The new iTop
  feature should mirror this exactly but with a thin `server/network`-style
  client (like `n8n-client.ts`) instead of a Drizzle repository, since iTop is a
  foreign DB queried directly (not through the app's Drizzle schema).
- **Envelope:** `server/utils/envelope.ts` → `ok(data)`, `fail(code, msg, fields?)`,
  `apiError(status, code, msg, fields?)`. Need a new `ErrorCode` (e.g.
  `ITOP_UNREACHABLE`) added to the `ErrorCode` union.
- **Auth/authz:** `requirePermission(event, PERMISSIONS.X)` from
  `shared/constants/rbac.ts`. **Recommendation: reuse existing ACL/ROUTE SHOW
  permissions** (or just `requireAuthenticatedUser`) rather than add a new
  permission — ticket search is a sub-step of an ACL/Route add/delete the user
  is already permitted to do. See §5 for the nuance.
- **Zod `changeTicket`:** `ChangeTicketSchema` lives in
  `shared/schemas/network.schema.ts`, imported by both
  `shared/schemas/acl.schema.ts` and `route.schema.ts`. It is currently
  `.optional()` on the add/delete field objects; making ticket selection
  REQUIRED means dropping `.optional()` there. New ticket search/preview request
  + response schemas should go in a new `shared/schemas/itop.schema.ts`.
- **Frontend:** The 4 forms (`app/pages/{acl,routes}/{add,delete}.vue`) each have
  an identical `changeTicket` block using a **raw `<input>`** (not `UInput`) with
  a shared `inputClass` constant. Submit is via `useApi()` (`app/composables/useApi.ts`),
  an envelope-unwrapping wrapper over `$fetch`/`useRequestFetch`. The modal
  pattern to reuse is **Nuxt UI `UModal`** (see `DeviceCredentialsModal.vue`) with
  singleton composable state (`useDeviceCredentials.ts`) — this is the closest
  existing analog for a session-scoped "pick once, auto-fill" UX.
- **Tests:** Vitest is a dependency but **there is NO `vitest.config` and NO test
  files in the repo yet** (`npm test` runs `vitest run --passWithNoTests`). The
  n8n design spec describes an intended Vitest strategy with `fetch` mocked.
- **Specs:** Document the flow in `.kiro/specs/n8n-integration/` (closest home —
  it owns the ACL/Route forms, field payloads, Device Session Credentials and the
  `changeTicket` audit field) and reference it from
  `.kiro/specs/netops-policy-manager/design.md`.
- **iTop connectivity already known:** `.kiro/settings/mcp.json` carries the iTop
  DB coordinates (MySQL, host `10.72.151.10:3306`, db `itop`, user `replicator`).
  That is MCP-tool config only; the app itself needs its own `ITOP_DATABASE_URL`.

---

## Evidence by question

### 1. Config / env (`server/utils/config.ts`, `.env.example`)

`EnvSchema` is one `z.object({...}).refine(...)`; types via `z.infer`; parsed by
`loadEnv()`. No `runtimeConfig` anywhere in the repo (grep confirmed only comments
saying "never expose via `runtimeConfig.public`").

```ts
// server/utils/config.ts
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development','production','test']).default('development'),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),
  // ... SESSION_*, MFA_*, AD_*, N8N_* ...
  N8N_BASE_URL: z.string().url('N8N_BASE_URL must be a valid URL'),
  N8N_API_KEY: z.string().min(1, 'N8N_API_KEY is required'),
  N8N_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
})
export type Env = z.infer<typeof EnvSchema>
export function loadEnv(): Env { return EnvSchema.parse(process.env) }
```

Validated at startup:

```ts
// server/plugins/validate-env.ts
const parsed = EnvSchema.safeParse(process.env)
if (!parsed.success) { /* log fieldErrors, throw */ }
const { db, client } = createDatabase(parsed.data.DATABASE_URL)
await client`select 1`   // connectivity check only; no migrate
```

`.env.example` groups DB-ish vars at the top (`DATABASE_URL=postgres://...`),
then session/MFA, then an AD block, then an n8n block — each with an explanatory
comment and placeholders for secrets left blank.

**Where `ITOP_DATABASE_URL` goes:** a new key in `EnvSchema` (`z.string().url(...)`,
or `.optional()` if iTop may be absent in some envs — see Recommendations), read
via `loadEnv().ITOP_DATABASE_URL` in the new iTop client, plus a placeholder +
comment block in `.env.example` mirroring the n8n block. The URL form the
`mysql2` driver expects is `mysql://user:pass@host:3306/itop`.

### 2. Existing DB access (Drizzle / Postgres) and `mysql2`

```ts
// database/index.ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 10, idle_timeout: 20, connect_timeout: 10 })
  const db = drizzle(client, { schema })
  return { db, client }
}
```

```ts
// server/utils/db.ts — cached once per process
let cached: Database | null = null
export function useDatabase(): Database {
  if (!cached) cached = createDatabase(loadEnv().DATABASE_URL).db
  return cached
}
```

DB-relevant deps in `package.json`: `drizzle-orm ^0.45.3`, `postgres 3.4.9`
(driver), dev `drizzle-kit ^0.31.11`, `tsx`. **`mysql2` is absent from
`dependencies`/`devDependencies`.** In `package-lock.json` it only shows up as an
optional peer dependency of drizzle-orm / postgres metadata (lines ~8762, ~9649),
i.e. not installed as a direct dependency. The implementation must
`npm install mysql2` (pin an exact version) and the user must run it (per
AGENTS.md: "the user runs all commands").

**iTop should NOT be a Drizzle schema.** The app's Drizzle `schema` is its own
Postgres (identity/RBAC/sessions/audit). iTop is a foreign, read-only MariaDB; a
plain `mysql2` connection pool running parameterized `SELECT`s (mirroring the
thin `server/network/n8n-client.ts` boundary) fits the codebase conventions
better than adding iTop tables to the Drizzle schema.

### 3. Layering — ACL feature end-to-end

Handler (thin; validation + authz + envelope):

```ts
// server/api/acl/show.post.ts
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const user = await requirePermission(event, PERMISSIONS.ACL_POLICIES_SHOW)
  const parsed = AclShowSchema.safeParse(await readBody(event))
  if (!parsed.success) throw apiError(400, 'VALIDATION_ERROR', 'Invalid ACL search request')
  const db = useDatabase()
  const creds = await getDeviceCredentials(db, event)
  if (!creds) throw apiError(400, 'DEVICE_CREDENTIALS_REQUIRED', 'Enter your device credentials to search')
  const ctx = await buildAuditContext(db, event, user)
  return ok(await aclShow(db, ctx, parsed.data, creds))
})
```

`server/api/acl/execute.post.ts` picks the permission by operation
(`ADD → ACL_POLICIES_ADD`, else `ACL_POLICIES_DELETE`), parses with
`AclExecuteSchema`, then `ok(await aclExecute(db, ctx, parsed.data))`.

Service `server/services/acl.service.ts`: validates already-parsed input,
generates a `correlationId`, calls `callN8n(...)`, and records audit via
`recordWithDetail(...)`. There is **no ACL repository** (no `acl.repository.ts`)
because ACL/route state is never persisted — the "repository-equivalent" is the
n8n client in `server/network/`. The actual Drizzle repositories are the
audit-detail ones (`server/repositories/acl-log.repository.ts`), which only
`insert`/`select` (immutable, no update/delete):

```ts
// server/repositories/acl-log.repository.ts
export async function insertAclLog(db: DbOrTx, input: InsertAclLog): Promise<AclLogRow> {
  const [row] = await db.insert(aclLogs).values(input).returning()
  ...
}
```

**Mirror for iTop:** `server/api/itop/tickets.get.ts` (search list) +
`server/api/itop/ticket.get.ts` or `tickets/[ref].get.ts` (preview) → thin
handler (`requirePermission`/auth + Zod validate) → `server/services/itop.service.ts`
→ `server/network/itop-client.ts` (the mysql2 pool + parameterized SELECTs) →
map rows to a Zod response shape → `ok(...)`.

### 4. Envelope + errors (`server/utils/envelope.ts`)

```ts
export function ok<T>(data: T): OkEnvelope<T> { return { success: true, data } }
export function fail(code, message, fields?) { ... }   // { success:false, error:{code,message,fields?} }
export function apiError(statusCode, code, message, fields?) {
  return createError({ statusCode, data: fail(code, message, fields) })
}
```

`ErrorCode` is a string-literal union (`VALIDATION_ERROR`, `NOT_FOUND`,
`UNAUTHENTICATED`, `FORBIDDEN`, `INTERNAL_ERROR`, `DEVICE_CREDENTIALS_REQUIRED`,
…). **A new iTop code (e.g. `ITOP_UNREACHABLE`) must be added to this union**
to return a safe error when the iTop DB is down/times out — same spirit as the
n8n client's `AD_UNREACHABLE`/timeout handling.

### 5. Auth / authz & permission catalog (`shared/constants/rbac.ts`)

`requirePermission(event, code)` (`server/utils/auth.ts`) does: require session →
`getEffectivePermissions` → `hasPermission`; 401/403 via `apiError`. It never
branches on a role id (data-driven RBAC). Permission codes live in
`shared/constants/rbac.ts`:

```ts
export const PERMISSIONS = {
  ACL_POLICIES_SHOW:'ACL_POLICIES_SHOW', ACL_POLICIES_ADD:'ACL_POLICIES_ADD', ACL_POLICIES_DELETE:'ACL_POLICIES_DELETE',
  ROUTES_SHOW:'ROUTES_SHOW', ROUTES_ADD:'ROUTES_ADD', ROUTES_DELETE:'ROUTES_DELETE',
  ADMINISTRATION_SHOW:'ADMINISTRATION_SHOW', ADMINISTRATION_MANAGE:'ADMINISTRATION_MANAGE',
} as const
```

Codes are also the single source for the DB seed (`PERMISSION_DEFS`,
`ROLE_PERMISSION_MAP`). Adding a brand-new permission would require a seed/DB
change (new rows in `permissions` + `roles_permissions`) — a migration-ish data
change — plus editing this catalog.

**Recommendation: do NOT add a new permission.** Ticket search/preview is a
read-only helper used only inside an ACL/Route add/delete the user is already
authorized for. Options, best to simplest:
- Gate each iTop endpoint with the matching existing permission the caller is
  mid-flow on. But search is shared across all four forms, so a single gate is
  cleaner: require **any** of the ACL/ROUTE action permissions, or
- Simplest and defensible: gate with `requireAuthenticatedUser(event)` +
  `assertSameOrigin(event)` (authenticated, same-origin, read-only, no device/
  config exposure). This matches how the read-only `/api/acl-logs` /
  `/api/audit` endpoints are "authenticated but no feature permission" per the
  n8n spec's Read-path section.

Pick one and state it; don't leave it open for the implementer.

### 6. Zod schemas (`network.schema.ts`, `acl.schema.ts`, `route.schema.ts`)

`ChangeTicketSchema` is defined once and shared:

```ts
// shared/schemas/network.schema.ts
export const ChangeTicketSchema = z.string().trim()
  .min(1, 'Change ticket is required')
  .max(64, 'Change ticket must be at most 64 characters')
```

Used (currently optional) in both feature schemas:

```ts
// shared/schemas/acl.schema.ts
const AclFields = z.object({
  source: z.string().trim().min(1).max(64),
  sourceMask: MaskSchema.optional(),
  destination: z.string().trim().min(1).max(64),
  destinationMask: MaskSchema.optional(),
  changeTicket: ChangeTicketSchema.optional(),   // ← make REQUIRED (drop .optional())
})
// AclAddSchema / AclDeleteSchema = AclFields.merge(ExecCredentialsSchema)
// AclPreviewSchema = discriminatedUnion('operation', [ADD/DELETE merges])
```

```ts
// shared/schemas/route.schema.ts
const RouteFields = z.object({
  routeIp: z.string().trim().min(1).max(64),
  routeMask: MaskSchema.optional(),
  changeTicket: ChangeTicketSchema.optional(),   // ← make REQUIRED
})
```

**Mass-assignment / server-controlled fields:** request schemas deliberately
exclude server-set fields. The ACL schema file comments: "Server-controlled
values (correlationId, audit status) are never in these schemas, so a client
cannot set them." `changeTicket` is a legitimate client-supplied field (it is the
selected ticket `ref` string, max 64 — `C-035919` etc. fit comfortably), stored
as the audited change-ticket column, so no change to its boundedness is needed —
only making it required.

**New schemas:** add `shared/schemas/itop.schema.ts` with:
- `ItopTicketSearchSchema` (query: `q` string min 1, bounded; optional `limit`).
- `ItopTicketSummarySchema` (list item: `ref`, `title`, `finalclass`,
  `operationalStatus`, dates — the parent-`ticket` columns, no secrets).
- `ItopTicketDetailSchema` (preview: summary + type-specific detail + resolved
  caller/org names).
Derive types with `z.infer`; map DB rows → these shapes in the service (never
return raw rows — matches the "never return raw DB rows" rule and `toUserResponse`
pattern).

### 7. Frontend form pattern (the 4 ACL/Route add/delete pages)

All four pages are near-identical. The `changeTicket` block is a **raw HTML
`<input>`** (NOT `UInput`), wrapped in the shared `FormField`:

```vue
<!-- app/pages/acl/add.vue, acl/delete.vue, routes/add.vue, routes/delete.vue -->
<FormField label="Ticket Change" name="changeTicket">
  <template #default="{ id }">
    <input :id="id" v-model="form.changeTicket" type="text"
           placeholder="e.g. CHG-123456" :class="inputClass">
  </template>
</FormField>
```

`inputClass` is a per-page constant (identical across all four):

```ts
const inputClass =
  'h-[38px] w-full rounded-md border border-line bg-panel px-3 text-xs text-ink outline-none focus:border-brand disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted'
```

Form state is a `reactive({...})` object; `buildPayload()` builds the typed
preview/execute input; a `watch(form, ...)` invalidates the preview on any change;
`resetFields()` clears everything after a successful execute. Submit path:
`const api = useApi()` → `api.aclOps.preview(...)` then (on confirm)
`api.aclOps.execute(...)`; errors unwrapped via a local `toMessage(e)` reading
`e.data.error.message`. Execute is gated behind a `preview` existing +
`ConfirmDialog`. The **"execute enabled only after a step"** pattern already
exists: the Execute button only renders once `preview` is non-null (`v-if="!preview"`
Generate vs `v-else` Execute). The new rule (execute enabled only after a ticket
is picked) slots into the same `:disabled` / `v-if` gating.

**Shared components in `app/components/`:**
`ConfirmDialog.vue`, `DataTable.vue`, `DeviceCredentialsModal.vue`,
`EmptyState.vue`, `ErrorState.vue`, `FormField.vue`, `IpInput.vue`,
`LoadingState.vue`, `MaskInput.vue`, `MfaCodeInput.vue`, `PageHeader.vue`,
`Pagination.vue`, `RawCommandBox.vue`, `ScrollableResultTable.vue`,
`StatusBadge.vue`, plus `dashboard/*` and `layout/*`.

**Existing modal/search pattern to reuse:** Nuxt UI **`UModal`** is already used
(`DeviceCredentialsModal.vue`, and `ConfirmDialog.vue`). There is **no existing
`UCommandPalette` / `UInputMenu` / combobox usage** in the repo. The cleanest
reuse is a `UModal` with a search `UInput`, a results list (or `DataTable` /
`ScrollableResultTable`), `LoadingState` / `EmptyState` / `ErrorState` for the
three states, and a singleton composable (`useItopTicket.ts`) mirroring
`useDeviceCredentials.ts` to hold the selected ticket. `FormField` must NOT be
restyled for this (shared across all forms, per ui-conventions).

### 8. useApi / data fetching (`app/composables/useApi.ts`)

Envelope-aware wrapper; every method returns the UNWRAPPED `data`:

```ts
interface Envelope<T> { success: boolean, data: T }
async function apiGet<T>(url, query?) {
  const requestFetch = useRequestFetch()                 // SSR-safe, forwards cookies
  const res = await requestFetch<Envelope<T>>(url, { query })
  return res.data
}
async function apiSend<T>(url, method, body?) {
  const res = await $fetch<Envelope<T>>(url, { method, body })
  return res.data
}
export function useApi() {
  return { auth:{...}, aclOps:{ show, preview, execute }, routeOps:{...},
           deviceCredentials:{ status, set, reveal, clear }, dashboard:{...},
           audit:{...}, aclLogs:{...}, routeLogs:{...}, users:{...}, roles:{...} }
}
```

Errors surface as thrown `$fetch` errors whose `.data` is the `FailEnvelope`;
callers read `e.data.error.message` (see each page's `toMessage`). **Add an
`itop` section** here: `itop: { searchTickets(q): apiGet('/api/itop/tickets',{q}),
getTicket(ref): apiGet('/api/itop/tickets/'+encodeURIComponent(ref)) }` — use GET
for these read-only lookups (consistent with `audit.list`/`get` using `apiGet`).

### 9. UI conventions compliance (`.kiro/steering/ui-conventions.md`)

The new search/preview UI must:
- Use token classes only: `bg-surface`, `bg-panel`, `border-line`/`ring-line`,
  `text-ink`, `text-muted`, `bg-brand`/`text-brand`, `text-ok`/`text-bad`. No raw
  hex. (Confirmed these are the tokens the forms already use via `inputClass`.)
- Force the light look on any `UInput`:
  `color="neutral" variant="outline" :ui="{ base: 'bg-panel text-ink ring-line placeholder:text-muted' }"`
  (exact pattern in `DeviceCredentialsModal.vue`).
- Primary button: `color="primary" class="bg-brand text-white hover:bg-brand/90"
  :ui="{ label: 'text-white' }"`. Icon-only buttons need `aria-label`.
- Wrap fields in the shared `FormField` (don't restyle it).
- Use the shared **`LoadingState`** (`app/components/LoadingState.vue`),
  **`EmptyState`** (`app/components/EmptyState.vue`), **`ErrorState`**
  (`app/components/ErrorState.vue`) for the search modal's three states. All three
  exist and take simple props (title/description/icon; ErrorState emits `retry`).
- Validation errors: `text-bad` + `role="alert"` (FormField already renders the
  error slot with `role="alert"`, though it uses the Nuxt UI `text-error` alias).

### 10. Tests (Vitest)

- `vitest ^5.0.3`, `@vitejs/plugin-vue`, `happy-dom`, `fast-check` are
  devDependencies; `npm test` = `vitest run --passWithNoTests`.
- **No `vitest.config.ts`/`.js` exists and there are NO `*.test.ts` / `*.spec.ts`
  files in the repo** (grep for `describe(`/`it(`/`test(` in repo test files → no
  matches; the only hits are inside `node_modules`).
- The n8n-integration design (`.kiro/specs/n8n-integration/design.md` →
  "Testing Strategy") describes the *intended* approach: Vitest with the n8n
  client / global `fetch` mocked, unit tests for `redactPayload`/`redactText`,
  service tests, and handler integration tests with a mocked client.
- **Implication:** the iTop module's tests should be the first real tests. Unit-
  test the pure pieces (Zod `itop.schema` parsing, the row→response mappers, the
  `finalclass → detail table/ref prefix` resolver) without a live DB, and mock the
  `itop-client` for service tests — do not hit the real iTop DB in tests. The
  implementer will need to create a minimal `vitest.config.ts`.

### 11. Specs — where to document the iTop flow

Spec dirs: `.kiro/specs/{ad-authentication,n8n-integration,netops-policy-manager,rbac-permissions}`.

- **Primary home: `.kiro/specs/n8n-integration/`** — it already owns the ACL/Route
  add/delete forms, the field payloads, the `changeTicket` audit field, and the
  Device Session Credentials session-scoped pattern. Relevant existing headings to
  extend/reference:
  - `design.md` → "## Field payloads per operation (Req 4)" (document that
    `changeTicket` now carries the selected iTop `ref` and is required),
  - `design.md` → "## Device Session Credentials (read operations) (Req 11)" (the
    nearest analog for a session-scoped read-only helper; the iTop selection flow
    can be documented as a sibling subsection),
  - `requirements.md` → add EARS requirements for ticket search/preview/required
    selection.
- **Cross-reference in `.kiro/specs/netops-policy-manager/design.md`:** the
  "## Data Models → ### Zod Application Schemas", "## Components and Interfaces →
  ### API Endpoints — Req 12, Req 16" (add the two `/api/itop/*` rows), and
  "### Frontend Components" (the ticket-picker modal) sections, plus "## Data Flow
  — Add ACL" to note the pre-execute ticket requirement.
- Add the `ITOP_DATABASE_URL` row under the config/env sections of both specs
  (mirroring how `N8N_*` is documented), and to AGENTS.md's config note if
  broadening is warranted.

---

## iTop connectivity context (already configured for MCP, not for the app)

`.kiro/settings/mcp.json` (`db-local` server env) already contains the iTop DB
coordinates used by the MCP tool for the connectivity checks the user ran:
`DB_ITOP_DIALECT=mysql`, `DB_ITOP_HOST=10.72.151.10`, `DB_ITOP_PORT=3306`,
`DB_ITOP_DATABASE=itop`, `DB_ITOP_USERNAME=replicator`, and a password. This is
**MCP-tool configuration only** — it is NOT how the Nitro app will connect. The
app needs its own server-only `ITOP_DATABASE_URL` env var
(`mysql://replicator:<pw>@10.72.151.10:3306/itop`) read via `loadEnv()`. (Per
AGENTS.md, never commit `.env`; the password is a secret — reference by key name,
not value.)

---

## Conclusions & recommendations

1. **New iTop module = thin DB client in `server/network/`, not Drizzle.**
   Add `server/network/itop-client.ts`: a lazily-cached `mysql2/promise` pool
   from `loadEnv().ITOP_DATABASE_URL`, exposing `searchTickets(q, limit)` and
   `getTicketByRef(ref)` using **parameterized** `SELECT`s only (never string
   interpolation — SQL-injection safety rule). Backtick the `change` table
   (reserved word). Bound every query with a connection/query timeout and
   normalize failures into a safe `ITOP_UNREACHABLE` error (mirror `n8n-client.ts`,
   which never throws credential-bearing errors upward).
2. **Service + mappers:** `server/services/itop.service.ts` resolves the
   finalclass → detail table, runs the follow-up IN(...) lookups for
   caller/org names, and maps rows to the Zod response shapes. Never return raw
   rows.
3. **Endpoints (GET, read-only):** `server/api/itop/tickets.get.ts` (search list,
   server-side `LIMIT ~20`) and `server/api/itop/tickets/[ref].get.ts` (preview).
   Guard with `assertSameOrigin` + authenticated session (recommended) rather than
   a new RBAC permission (§5). Validate query/params with the new Zod schemas;
   return via `ok(...)`.
4. **Config:** add `ITOP_DATABASE_URL` to `EnvSchema` + `.env.example` placeholder
   + comment block. Decide required vs optional: if ACL/Route must work even when
   iTop is unconfigured, make it `.optional()` and have the client throw
   `ITOP_UNREACHABLE` when unset; otherwise make it required (fails fast at
   startup). Recommend **optional** so a missing iTop doesn't block app boot, with
   a clear runtime error on the ticket endpoints. (Add `mysql2` to deps, pinned.)
5. **Schemas:** new `shared/schemas/itop.schema.ts`; make `changeTicket`
   **required** in `AclFields`/`RouteFields` (drop `.optional()`), keep the shared
   `ChangeTicketSchema` (bounded 1..64) as-is — `ref` values fit. Request schemas
   still exclude server-controlled fields.
6. **Frontend:** replace the raw `<input>` `changeTicket` block in all four forms
   with a `UModal`-based ticket picker (search `UInput` → results list with
   `LoadingState`/`EmptyState`/`ErrorState` → select → preview card). Store the
   selection in a singleton composable (`useItopTicket.ts`, modeled on
   `useDeviceCredentials.ts`); on select, set `form.changeTicket = ticket.ref`.
   Gate the Generate/Execute buttons so they stay disabled until a ticket is
   selected (extend the existing `:disabled`/`v-if` gating). Add an `itop` section
   to `useApi()`. Follow ui-conventions tokens throughout; do not restyle
   `FormField`.
7. **Tests:** introduce `vitest.config.ts` and the repo's first tests — unit-test
   `itop.schema` + the mappers + the finalclass/ref resolver, and service tests
   with the iTop client mocked. Do not contact the real iTop DB in tests.
8. **Docs:** update `.kiro/specs/n8n-integration/` (primary) and cross-reference
   `.kiro/specs/netops-policy-manager/design.md` (schemas, API endpoints table,
   frontend components, data flow), per §11. **Do not touch Log Trail code.**

### Open assumptions (reasonable, flagged for the implementer)
- Permission model for the iTop endpoints: assumed "authenticated + same-origin,
  no new RBAC permission." If the team wants an explicit permission, that's a
  seed/DB change — surface before implementing.
- `ITOP_DATABASE_URL` optional vs required: assumed optional (don't block boot).
- Preview detail depth: the brief lists the parent `ticket` columns + per-type
  detail tables + resolved caller/org names; exact columns per `finalclass` are an
  iTop-schema concern already confirmed by the brief and should be taken as given
  (do not re-investigate iTop).
