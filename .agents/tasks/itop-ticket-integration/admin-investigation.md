# Administration Page Investigation — Test Connection buttons + User Mapping pagination

Read-only investigation. Nothing was modified. All paths are absolute from the
repo root `e:\Work\CLOUD PROJECTS\Netops-policy`.

## Summary (answer first)

- **User Mapping table is bespoke**, not `DataTable.vue`. It lives entirely in
  `app/pages/administration/index.vue` as a hand-rolled CSS-grid table, already
  does **server-side pagination** via `users.list({ page, limit })` and the
  shared `Pagination.vue` — but `ITEMS_PER_PAGE = 20`. To match the user's
  request ("max 5, pagination beyond that"), **only one constant changes to 5**
  on the client; the server already paginates with a page/limit contract and
  clamps limit to `[1,100]`, so **no server change is required** for page size.
- **No existing n8n test/health endpoint and no iTop code at all.** The closest
  reusable n8n pattern is `validateDeviceCredentials()` in
  `server/network/n8n-client.ts` (bounded by `N8N_TIMEOUT_MS`, never throws,
  maps failures to a safe message). Both a new `/api/n8n/test` and a new
  `/api/itop/test` endpoint + client helpers need to be created.
- **Config is `loadEnv()` only, no `runtimeConfig`.** New env vars go in the Zod
  `EnvSchema` (`server/utils/config.ts`) and `.env.example`. Adding an optional
  `ITOP_DATABASE_URL` follows the existing `N8N_*` block pattern exactly.
- **`ErrorCode` union** in `server/utils/envelope.ts` has no network-health code;
  add e.g. `ITOP_UNREACHABLE` / `N8N_UNREACHABLE` there before `fail()`/`apiError()`
  can use them.
- **Toast pattern exists** (`useToast()` + `toast.add({ color, icon })`) and is
  already used on the Administration page itself — the Test Connection buttons
  should reuse it for ok/fail feedback.

---

## Administration / User Mapping page

### Q1 — Administration page + User Mapping table

File: `app/pages/administration/index.vue` (single file; no separate User
Mapping component — the table is inline). It is a **bespoke CSS-grid table**, not
`DataTable.vue`.

Data fetch and page size (lines ~55–85):

```ts
const ITEMS_PER_PAGE = 20

const rows = ref<AdminUserResponse[]>([])
const total = ref(0)
const page = ref(1)

async function load() {
  ...
  const res = await users.list({ page: page.value, limit: ITEMS_PER_PAGE })
  rows.value = res.items
  total.value = res.total
  ...
}
onMounted(load)
watch(page, load)
```

Rows are rendered with a `v-for` over `rows` inside a `grid grid-cols-[1.4fr_1.4fr_1fr_0.8fr_auto]`
card (Email / Name / Role / Status / Action columns), and pagination is already
wired:

```vue
<Pagination
  v-if="total > ITEMS_PER_PAGE"
  v-model:page="page"
  :total="total"
  :items-per-page="ITEMS_PER_PAGE"
/>
```

**So it already paginates server-side at 20.** To get "max 5 then paginate",
change `ITEMS_PER_PAGE` to `5`. That single edit flows into both the `users.list`
limit and the `Pagination` props.

### Q2 — Reference table that paginates (page/limit + Pagination.vue + envelope)

The best reference is the **Log Trail** page, `app/pages/logs/index.vue`, which
mirrors the exact same pattern (its own comment says "mirrors
administration/index.vue"):

```ts
const ITEMS_PER_PAGE = 20
function buildParams(): Record<string, unknown> {
  const params: Record<string, unknown> = { page: page.value, limit: ITEMS_PER_PAGE }
  ...
}
const res = await audit.list(buildParams())
rows.value = res.items
total.value = res.total
```

```vue
<Pagination v-if="total > ITEMS_PER_PAGE" v-model:page="page" :total="total" :items-per-page="ITEMS_PER_PAGE" />
```

- **Query params sent:** `page` and `limit` (1-based page, not offset/limit on
  the wire). `useApi()` forwards them as `?page=&limit=&search=`.
- **useApi method:** `audit.list(params)` → `apiGet<Paginated<AuditResponse>>('/api/audit', params)`.
  The Administration page uses the sibling `users.list(params)` →
  `apiGet<Paginated<AdminUserResponse>>('/api/users', { page, limit, search })`
  (`app/composables/useApi.ts`).
- **Envelope shape for a paginated list:** the server returns
  `ok({ items, total, page, limit })`, and `useApi` unwraps `{ success, data }`
  so the page sees `Paginated<T> = { items, total, page, limit }`. The service
  builds this directly:

  `server/services/user.service.ts` →
  ```ts
  export async function listUsers(db, opts): Promise<{ items, total, page, limit }> {
    const { items, total } = await userRepo.listWithRole(db, opts)
    return { items: items.map(toAdminUserResponse), total, page: opts.page, limit: opts.limit }
  }
  ```

**Conclusion:** The reference page size is a UI constant (`ITEMS_PER_PAGE`), not
a server constant. There is no shared "pageSize = 5" anywhere — each page owns
its own constant. User Mapping already follows this exact pattern; matching the
request means setting its constant to 5.

### Q3 — Server endpoint / service / repository for the User Mapping list

Endpoint: `server/api/users/index.get.ts` — **already supports pagination**:

```ts
export default defineEventHandler(async (event) => {
  await requirePermission(event, PERMISSIONS.ADMINISTRATION_SHOW)

  const q = getQuery(event)
  const page = Math.max(1, Number.parseInt(String(q.page ?? '1'), 10) || 1)
  const limitRaw = Number.parseInt(String(q.limit ?? '20'), 10) || 20
  const limit = Math.min(100, Math.max(1, limitRaw))   // clamps to [1,100]
  const search = typeof q.search === 'string' ? q.search : undefined

  const result = await listUsers(useDatabase(), { page, limit, search })
  return ok(result)
})
```

Service: `server/services/user.service.ts` → `listUsers()` (shown in Q2).

Repository: `server/repositories/user.repository.ts` → `listWithRole()` already
does `limit`/`offset`:

```ts
const [{ value: total } = { value: 0 }] = await db.select({ value: count() }).from(users).where(where)
const rows = await db.select({ ... })
  .from(users)
  .leftJoin(roles, eq(roles.roleId, users.roleId))
  .where(where)
  .orderBy(desc(users.createdAt))
  .limit(opts.limit)
  .offset((opts.page - 1) * opts.limit)
return { items: rows, total }
```

**What must change for page-size-5:** nothing on the server. The server already
honors any `limit` in `[1,100]`. The client sends `limit = ITEMS_PER_PAGE`;
changing that constant to `5` in `app/pages/administration/index.vue` is the only
required change. (The server default of `20` when `limit` is omitted is
irrelevant because the page always sends an explicit limit.)

### Q4 — Pagination.vue props/events + DataTable.vue props

`app/components/Pagination.vue`:

```ts
withDefaults(defineProps<{
  page: number        // v-model:page, 1-based
  total: number       // total items across all pages
  itemsPerPage?: number
}>(), { itemsPerPage: 20 })

emit('update:page', value)   // v-model:page
```
Renders "Showing from–to of total" plus Nuxt UI `<UPagination>`. Wire it exactly
as the reference: `v-model:page="page" :total="total" :items-per-page="ITEMS_PER_PAGE"`.

`app/components/DataTable.vue` (NOT currently used by Administration):

```ts
interface DataTableColumn { key: string; label: string }
withDefaults(defineProps<{
  columns: DataTableColumn[]
  rows: T[]
  loading?: boolean
  emptyLabel?: string
}>(), { loading: false, emptyLabel: 'No data to display.' })
// named slots: cell-<key>, empty, loading
```

Note: `DataTable.vue` styles use the generic Nuxt UI tokens (`ring-default`,
`bg-elevated`), **not** the NetOps `bg-panel/border-line` tokens the bespoke
Administration table uses. The bespoke table matches the ui-conventions palette;
switching to `DataTable.vue` would change the look. **Recommendation:** keep the
bespoke table and only change the page-size constant — do not swap in `DataTable`.

### Q5 — RBAC permission gating the Administration/User endpoints

Code strings: `shared/constants/rbac.ts` → `PERMISSIONS.ADMINISTRATION_SHOW` and
`PERMISSIONS.ADMINISTRATION_MANAGE`.

Enforced in the handler via `requirePermission(event, code)`
(`server/utils/auth.ts` resolves the user's effective permission set from the DB
— data-driven, never a role-id branch):

- List: `server/api/users/index.get.ts` → `await requirePermission(event, PERMISSIONS.ADMINISTRATION_SHOW)`
- The page itself: `definePageMeta({ middleware: 'permission', permission: 'ADMINISTRATION_SHOW' })`
  in `app/pages/administration/index.vue`; mutating controls are hidden behind
  `canManage = can('ADMINISTRATION_MANAGE')`.

**Recommendation for the new buttons:** gate the Test Connection buttons' UI with
`canManage` (ADMINISTRATION_MANAGE), and gate the new `/api/.../test` endpoints
with `requirePermission(event, PERMISSIONS.ADMINISTRATION_MANAGE)` so only admins
can probe infrastructure. (SHOW would also be defensible; MANAGE is the safer
default since this is an operational diagnostic action.)

---

## Test Connection (iTop + n8n)

### Q6 — Existing n8n health/test endpoint?

**None.** `server/api/` has no n8n ping/health/test route (only ACL/route
show/preview/execute call n8n indirectly through the service layer). There is no
iTop code anywhere in `server/`.

Reusable pattern in `server/network/n8n-client.ts` — `validateDeviceCredentials`
is the template for a lightweight, bounded, never-throwing probe:

```ts
export async function validateDeviceCredentials(username, password): Promise<ValidateResult> {
  const env = loadEnv()
  const base = env.N8N_BASE_URL.replace(/\/+$/, '')
  const url = `${base}/user/validate`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), env.N8N_TIMEOUT_MS)
  try {
    const res = await fetch(url, { method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-NetOps-Internal-Key': env.N8N_API_KEY },
      body: JSON.stringify({ user: username, pass: password }) })
    ...
    return { success, message }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return { success: false, message: aborted ? 'Validation request timed out' : 'Validation service is unreachable' }
  } finally { clearTimeout(timeout) }
}
```

Main exported functions of the n8n client:
- `callN8n(options): Promise<N8nCallResult>` — per-operation webhook call;
  **never throws** for n8n/network errors, resolves to `FAILED` with a safe
  message (`'n8n request timed out'` / `'n8n is unreachable'`).
- `validateDeviceCredentials(username, password): Promise<ValidateResult>`.
- Env usage: `env.N8N_BASE_URL`, `env.N8N_API_KEY` (header
  `X-NetOps-Internal-Key`), `env.N8N_TIMEOUT_MS` (AbortController deadline).

**Recommendation:**
- **n8n test:** add a `pingN8n()` helper to `n8n-client.ts` modeled on
  `validateDeviceCredentials` (a lightweight GET/HEAD or a known webhook ping,
  bounded by `N8N_TIMEOUT_MS`, never-throw), and a new
  `server/api/n8n/test.post.ts` (or `.get.ts`) handler that calls it. There is
  currently **no reusable zero-arg health call** — one must be added.
- **iTop test:** new helper is required (no iTop client exists). A read-only
  `SELECT 1` against the iTop MariaDB using `ITOP_DATABASE_URL` is the simplest
  probe (project rule: iTop is **read-only, SELECT only**). Needs a new
  `server/api/itop/test.post.ts` + a small iTop client module. The MCP tooling
  observed in `.kiro/settings/mcp.json` is dev-only; the app must query via its
  own connection variable per the user's request (message #9).

### Q7 — `server/utils/envelope.ts` ErrorCode union + helpers

Current `ErrorCode` union (full list):

```ts
export type ErrorCode =
  | 'INVALID_CREDENTIALS' | 'INVALID_VERIFICATION_CODE' | 'MFA_CHALLENGE_INVALID'
  | 'MFA_DEVICE_LIMIT_REACHED' | 'MFA_DEVICE_NOT_FOUND' | 'MFA_LAST_DEVICE'
  | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'VALIDATION_ERROR' | 'FORBIDDEN_ORIGIN'
  | 'NOT_FOUND' | 'CONFLICT' | 'AD_UNREACHABLE' | 'ACCOUNT_DISABLED'
  | 'SELF_DISABLE_FORBIDDEN' | 'DEVICE_CREDENTIALS_REQUIRED' | 'INTERNAL_ERROR'
```

There is **no** iTop/n8n health code — new codes like `ITOP_UNREACHABLE` and
`N8N_UNREACHABLE` must be **added to this union** (note `AD_UNREACHABLE` already
exists as a naming precedent). Helpers:

```ts
export function ok<T>(data: T): OkEnvelope<T> { return { success: true, data } }
export function fail(code, message, fields?): FailEnvelope {
  return { success: false, error: fields ? { code, message, fields } : { code, message } }
}
export function apiError(statusCode, code, message, fields?) {
  return createError({ statusCode, data: fail(code, message, fields) })
}
```

### Q8 — `config.ts` EnvSchema (n8n block) + `.env.example`; no runtimeConfig

`server/utils/config.ts` n8n block (pattern to copy for `ITOP_DATABASE_URL`):

```ts
N8N_BASE_URL: z.string().url('N8N_BASE_URL must be a valid URL'),
N8N_API_KEY: z.string().min(1, 'N8N_API_KEY is required'),
N8N_TIMEOUT_MS: z.coerce.number().int().positive('N8N_TIMEOUT_MS must be a positive integer').default(15000),
```

Config is read **only** via `loadEnv()` → `EnvSchema.parse(process.env)`. There
is **no `runtimeConfig`** anywhere (the schema comment explicitly says values
"may [not] be exposed via runtimeConfig.public"). Validation runs once at startup
in `server/plugins/validate-env.ts`.

`.env.example` already documents the `N8N_*` block (`N8N_BASE_URL`,
`N8N_API_KEY`, `N8N_TIMEOUT_MS=15000`) with the same "FILL MANUALLY, never
commit" convention. **Recommendation:** add an **optional** `ITOP_DATABASE_URL`
(e.g. `z.string().url(...).optional()`) so the app still boots without it (the
user asked in message #12 that boot work without an iTop connection), plus an
optional `ITOP_TIMEOUT_MS` with a default, and add a commented placeholder to
`.env.example`. Keep boot resilient: make iTop vars optional, surface
connectivity only through the Test Connection button.

### Q9 — `useApi()` structure + where to add test methods

`app/composables/useApi.ts` uses two private helpers and returns a grouped object:

```ts
async function apiGet<T>(url, query?) { const res = await useRequestFetch()<Envelope<T>>(url, { query }); return res.data }
async function apiSend<T>(url, method, body?) { const res = await $fetch<Envelope<T>>(url, { method, body }); return res.data }

export function useApi() {
  return {
    auth: { me, login, logout },
    aclOps: { show, preview, execute },
    routeOps: { show, preview, execute },
    deviceCredentials: { status, set, reveal, clear },
    dashboard: { kpi, activitySeries, configByOperation, topUsers, recentConfigChanges },
    audit: { list, get, export },
    aclLogs: { list, byCorrelation },
    routeLogs: { list, byCorrelation },
    users: { list, create, update, changeRole, setStatus, resetPassword },
    roles: { list },
  }
}
```

**Where to add:** two new groups following the existing style, each a single
POST (via `apiSend`) returning the test result shape, e.g.:

```ts
itop: {
  testConnection(): Promise<{ ok: boolean, message: string }> {
    return apiSend<{ ok: boolean, message: string }>('/api/itop/test', 'POST')
  },
},
n8n: {
  testConnection(): Promise<{ ok: boolean, message: string }> {
    return apiSend<{ ok: boolean, message: string }>('/api/n8n/test', 'POST')
  },
},
```

(Use POST to match `assertSameOrigin` CSRF posture used by other mutating/action
endpoints; the endpoints themselves perform read-only probes.)

### Q10 — Button UI conventions + toast pattern

From `.kiro/steering/ui-conventions.md`:

- **Primary (brand) button:**
  ```vue
  <UButton color="primary" class="bg-brand text-white hover:bg-brand/90" :ui="{ label: 'text-white' }" />
  ```
- **Icon-only buttons must have an `aria-label`** (observed in practice on the
  Administration page: `<UButton ... icon="i-lucide-ellipsis-vertical" aria-label="More actions" />`).
- **Secondary / neutral action** (seen on the page): `color="neutral" variant="outline"`
  (e.g. the "Edit Role" and Log Trail "Reset" buttons).
- **Status tokens:** success `text-ok` / `bg-ok/10`, danger `text-bad` /
  `bg-bad/10`, border `border-line`, surfaces `bg-panel` / `bg-surface`, primary
  `bg-brand` / `text-brand`. Never hard-code hex. The Log Trail status pill is a
  ready template for an ok/fail indicator:
  ```vue
  <span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
        :class="status === 'SUCCESS' ? 'bg-ok/10 text-ok' : 'bg-bad/10 text-bad'">
    <UIcon :name="status === 'SUCCESS' ? 'i-lucide-check' : 'i-lucide-x'" class="size-3.5" aria-hidden="true" />
    {{ status }}
  </span>
  ```

- **Toast pattern (Nuxt UI `useToast`) is already in the repo** and used on the
  Administration page itself (`app/pages/administration/index.vue`):
  ```ts
  const toast = useToast()
  function notifySuccess(title: string) { toast.add({ title, color: 'success', icon: 'i-lucide-check' }) }
  function notifyError(description: string) { toast.add({ title: 'Error', description, color: 'error', icon: 'i-lucide-circle-alert' }) }
  ```
  Also used in `app/components/layout/ProfileModal.vue` and
  `app/pages/mfa/add-device.vue`. **Reuse this** for Test Connection results.

---

## Conclusions & recommendations

1. **Pagination at 5 (client-only change):** in
   `app/pages/administration/index.vue`, change `const ITEMS_PER_PAGE = 20` to
   `5`. Server (`index.get.ts` / `listUsers` / `listWithRole`) already paginates
   with a clamped `limit` and returns `{ items, total, page, limit }`; no
   server/DB change and no migration needed. Keep the bespoke table (matches
   NetOps tokens); do not swap to `DataTable.vue`.
2. **Two Test Connection buttons below the User Mapping table:** add a small
   section after the `<Pagination>` block with a brand/neutral `UButton` each
   ("Test iTop Connection", "Test n8n Connection"), per-button `:loading` state,
   and an ok/fail pill or toast using `text-ok`/`text-bad`. Gate visibility with
   `canManage`.
3. **Backend additions (follow existing patterns, keep boot resilient):**
   - `server/utils/envelope.ts`: add `ITOP_UNREACHABLE` (and optionally
     `N8N_UNREACHABLE`) to `ErrorCode`.
   - `server/utils/config.ts` + `.env.example`: add **optional** `ITOP_DATABASE_URL`
     (+ optional `ITOP_TIMEOUT_MS` with default) modeled on the `N8N_*` block, so
     startup still succeeds without iTop configured.
   - n8n: add a lightweight `pingN8n()` to `server/network/n8n-client.ts`
     (never-throw, `N8N_TIMEOUT_MS`-bounded) + `server/api/n8n/test.post.ts`.
   - iTop: add a new read-only iTop client (SELECT 1 using `ITOP_DATABASE_URL`,
     timeout-bounded, never-throw) + `server/api/itop/test.post.ts`. Enforce
     read-only per project rules.
   - Both endpoints: `assertSameOrigin(event)` + `requirePermission(event,
     PERMISSIONS.ADMINISTRATION_MANAGE)`, return `ok({ ok, message })` on success
     and never leak connection strings/SQL/stack in the error message.
   - `app/composables/useApi.ts`: add `itop.testConnection()` and
     `n8n.testConnection()` groups.
4. **Scope note:** This task is independent of the broader iTop *ticket search/
   preview* flow in the original request (messages #1–#11); it only covers the
   Administration-page test buttons + 5-row pagination (message #12). The iTop
   DB connection variable introduced here (`ITOP_DATABASE_URL`) is the same one
   the later ticket-search feature will reuse.
