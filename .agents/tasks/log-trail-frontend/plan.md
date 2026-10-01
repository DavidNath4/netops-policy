# Implementation Plan — Log Trail Frontend (`/logs`)

Frontend-only. Creates `app/pages/logs/index.vue` and adds client API methods to
`app/composables/useApi.ts`. The backend is complete and read-only reference.

## Context confirmed by reading the code

- **Routes (from the `.get.ts` handlers):**
  - `GET /api/audit` (list, paginated) and `GET /api/audit/:id` — already wired as
    `audit.list(params)` / `audit.get(id)` in `useApi.ts`.
  - `GET /api/acl-logs` — paginated ACL detail list (`AclLogQuerySchema`). *(Not needed
    for this run; see scope note — only the by-correlation route is used.)*
  - `GET /api/acl-logs/correlation/:id` — array of `AclLogResponse` for one operation.
    Empty array is a valid `200`, NOT a 404.
  - `GET /api/route-logs` — paginated ROUTE detail list.
  - `GET /api/route-logs/correlation/:id` — array of `RouteLogResponse`. Empty array = `200`.
  - All four require only authentication (`requireAuthenticatedUser`), no feature permission.
- **Envelope:** every endpoint returns `{ success, data }`. `useApi`'s `apiGet` unwraps
  `.data`, so new methods return the raw payload (array or `Paginated<T>`).
- **Search behavior (verified in `audit.repository.ts`):** the single `search` param is
  matched server-side via `ilike` against `username`, `changeTicket`, the joined user's
  `displayName`, AND `email`. So one text field covers username + display name + email.
  No separate client-side filtering is needed.
- **Date range (verified in `audit.service.ts` → `toFilter`):** `from`/`to` are parsed with
  `new Date(query.from)`. Sending ISO strings (`new Date(value).toISOString()`) works. The
  server does `gte(createdAt, from)` / `lte(createdAt, to)`.
- **`AuditResponse` fields:** `id, createdAt(string), userId, username, userRole, module,
  action, status, sourceIp, userAgent, changeTicket, correlationId, requestPayload,
  commandPayload, executionPayload, responsePayload`. The four payloads are typed `unknown`,
  pre-redacted server-side, so safe to render.
- **`AclLogResponse` / `RouteLogResponse` fields:** `id, auditId, correlationId, action,
  status, device, commandPreview, executionMeta, responseSummary, createdAt` plus
  `source`+`destination` (ACL) / `destination`+`changeTicket` (ROUTE).
- **Enums:** `AuditModule = AUTH|USER|ACL|ROUTE|N8N`, `AuditAction = LOGIN|SHOW|ADD|DELETE|UPDATE`,
  `AuditStatus = SUCCESS|FAILED`.
- **Sidebar:** `Log Trail -> /logs` has no `permission`, so the page must NOT set a permission
  middleware. The global auth middleware already protects it. Use the `default` layout (do not
  set `layout` — `default` is implicit).
- **Patterns to mirror:** `app/pages/administration/index.vue` is the table-card template
  (grid header + rows, skeleton, `ErrorState`/`EmptyState`, `Pagination`, `UModal`).
  `app/pages/acl/index.vue` shows `PageHeader`, filter-form styling, terminal/mono blocks.
- **Shared components available:** `PageHeader`, `Pagination` (`v-model:page`, `:total`,
  `:items-per-page`), `LoadingState`, `EmptyState`, `ErrorState`, `FormField`, `RawCommandBox`,
  `StatusBadge` (auto-imported from `app/components/`). `USkeleton`, `UModal`, `UInput`,
  `USelect`, `UBadge`, `UIcon` from Nuxt UI.
- **No existing date/format helper** (`app/utils/format*` does not exist). Format timestamps
  inline with `Intl.DateTimeFormat` / `toLocaleString('id-ID')` in the page.

### Verification note

No CLI is run here (hard constraint). The real verification command, to be run by the user
after implementation, is `npm run typecheck` (defined in `package.json` as `nuxt typecheck`),
plus a manual smoke test of `/logs`. Each item below lists the expected observable outcome;
"needs verification during implementation" marks anything not provable by reading alone.

---

## Plan

- [ ] 1. Add the four exec-log client methods to `useApi.ts`.
      Add type imports `AclLogResponse`, `RouteLogResponse` from
      `#shared/schemas/exec-log.schema` (mirroring the existing `AuditResponse` import).
      Add two new groups to the returned object, next to `audit`:
      `aclLogs = { list(params?) => apiGet<Paginated<AclLogResponse>>('/api/acl-logs', params),
      byCorrelation(correlationId: string) => apiGet<AclLogResponse[]>(\`/api/acl-logs/correlation/${correlationId}\`) }`
      and `routeLogs = { list(params?) => apiGet<Paginated<RouteLogResponse>>('/api/route-logs', params),
      byCorrelation(correlationId: string) => apiGet<RouteLogResponse[]>(\`/api/route-logs/correlation/${correlationId}\`) }`.
      `list` signature matches `audit.list`: `(params?: Record<string, unknown>)`. Only
      `byCorrelation` is consumed this run, but add `list` too since the routes are confirmed
      and it keeps the group complete (cheap, same pattern). Keep comments in English.
      Files: `app/composables/useApi.ts`
      Verify: `npm run typecheck` passes with no new errors; the methods are callable with the
      correct return types from the page in item 2+.

- [ ] 2. Create the Log Trail page shell with master-table scaffolding.
      New SFC `<script setup lang="ts">`, `default` layout (do not set `layout`), and NO
      `definePageMeta` permission (common access — confirmed via sidebar). Set the page title
      via `useHead({ title: 'Log Trail' })` if other pages do (needs verification during
      implementation — otherwise omit). Render `PageHeader title="Log Trail"
      description="Riwayat aktivitas dan audit sistem."`. Set up list state mirroring
      `administration/index.vue`: `rows = ref<AuditResponse[]>([])`, `total`, `page = ref(1)`,
      `pending = ref(true)`, `error = ref(false)`, `const ITEMS_PER_PAGE = 20`. Implement
      `load()` calling `audit.list(buildParams())` (buildParams in item 4), `onMounted(load)`,
      `watch(page, load)`. Import `AuditResponse` from `#shared/schemas/audit.schema` and
      destructure `const { audit, aclLogs, routeLogs } = useApi()`.
      Files: `app/pages/logs/index.vue`
      Verify: navigating to `/logs` renders the header and reaches the loading state;
      `npm run typecheck` passes.

- [ ] 3. Build the master table card (reuse the administration card markup).
      Columns, in order, Indonesian labels: **Waktu** (createdAt), **User** (username),
      **Module** (module), **Action** (action), **Status** (status). Do NOT show Source IP,
      User Agent, Role, Correlation ID, or Change Ticket in the master table (explicit user
      wish — those live in the detail modal only). Use the same
      `rounded-lg border border-line bg-panel shadow-sm` card, `overflow-x-auto` +
      `min-w-[...]`, a `grid grid-cols-[...]` header row (`bg-surface`, `text-xs font-semibold
      uppercase tracking-wide text-muted`) and data rows (`text-sm text-ink`, hover
      `hover:bg-surface/60`). Grid template suggestion:
      `grid-cols-[1.3fr_1.4fr_0.9fr_0.9fr_0.8fr]` (tune during implementation). Format Waktu
      with `toLocaleString('id-ID')` (or `Intl.DateTimeFormat`) in a small `formatTime(iso)`
      helper. Render a 5-row `USkeleton` loading block (as administration does) while
      `pending`. Make each data row clickable (`<button>`-like row or `role="button"`,
      `tabindex="0"`, `cursor-pointer`, keydown Enter/Space) to open the detail modal
      (item 6); give it an `aria-label` like `` `Lihat detail log ${username} ${module} ${action}` ``.
      Files: `app/pages/logs/index.vue`
      Verify: with data present the table shows the five columns and rows are keyboard- and
      mouse-focusable; `npm run typecheck` passes.

- [ ] 4. Add the inline status pill + the filter form, with param building.
      **Status pill (inline, NOT StatusBadge — do not edit StatusBadge):** a small
      `inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium` span.
      SUCCESS → `text-ok` with a soft green tint (e.g. `bg-ok/10`); FAILED → `text-bad` with
      `bg-bad/10`. Include the status word as text (not color alone) for accessibility, plus a
      Lucide icon (`i-lucide-check` / `i-lucide-x`) marked `aria-hidden`. Capitalize for
      display but keep the raw enum for logic.
      **Filter form** (styled like the acl/admin filter card: `rounded-lg border border-line
      bg-panel p-4`, responsive flex/grid): reactive `filters` object:
      `search`, `module`, `action`, `status`, `from`, `to`. Controls:
      a text `UInput` (label "Cari" — placeholder mentions username/nama/email) wired to
      `filters.search`; three `USelect`s **Module/Action/Status** built from the enum arrays
      (`AuditModuleSchema.options` etc., or hardcode the arrays matching the enums) each with an
      "Semua" (empty) option; two native `<input type="date">` **Dari**/**Sampai** (no new
      date-picker dependency — explicit constraint). Wrap each control in `FormField` (shared;
      do not restyle) so labels/ids are consistent, OR use plain labeled `<label for>` matching
      the acl page's filter inputs — pick the `FormField` route for accessibility consistency.
      Style `UInput`/`USelect` with the mandated light look:
      `color="neutral" variant="outline" :ui="{ base: 'bg-panel text-ink ring-line placeholder:text-muted' }"`.
      **`buildParams()`**: returns a plain object with `page: page.value`, `limit: ITEMS_PER_PAGE`,
      and only the non-empty filters. For `from`/`to`, convert the native date (`YYYY-MM-DD`) to
      ISO via `new Date(value).toISOString()` — map `to` to end-of-day if desired (needs
      verification during implementation whether inclusive end-of-day matters; the server uses
      `lte`). OMIT any empty/blank filter key entirely (don't send empty strings).
      **Reset to page 1 on filter change:** `watch(filters, () => { page.value = 1; load() },
      { deep: true })` (debounce the search input if it feels chatty — optional).
      Files: `app/pages/logs/index.vue`
      Verify: changing any filter resets to page 1 and refetches with only the populated params
      (observe the network request); empty filters are absent from the query string;
      `npm run typecheck` passes.

- [ ] 5. Wire Loading / Error / Empty states and server-side pagination.
      Use shared components exactly as administration does: `<ErrorState v-if="error"
      message="..." @retry="load" />`; `<LoadingState v-if="pending" />` (or the skeleton rows
      from item 3 — pick one consistently, administration uses skeleton rows inside the card);
      `<EmptyState v-if="!pending && rows.length === 0" title="Belum ada log"
      description="..." icon="i-lucide-scroll-text" />`. Render
      `<Pagination v-if="total > ITEMS_PER_PAGE" v-model:page="page" :total="total"
      :items-per-page="ITEMS_PER_PAGE" />` below the card. All user-facing copy in Indonesian.
      Files: `app/pages/logs/index.vue`
      Verify: forcing an API error shows ErrorState with a working retry; an empty result shows
      EmptyState; pagination appears only when total exceeds 20 and changing page refetches;
      `npm run typecheck` passes.

- [ ] 6. Add the detail/inspection `UModal` — core audit fields + JSONB payloads.
      State: `detailOpen = ref(false)`, `selected = ref<AuditResponse | null>(null)`.
      `openDetail(row)` sets `selected` and `detailOpen = true`. Use the full `AuditResponse`
      already in the row (no extra `audit.get` call needed since the list returns full rows —
      confirmed in `toAuditResponse`; if a field is ever missing, fall back to `audit.get(id)` —
      note as needs verification during implementation). `<UModal v-model:open="detailOpen"
      title="Detail Log">` with a `#body`. Show a labeled definition list (Indonesian labels,
      `text-muted` label + `text-ink` value) of the core fields, INCLUDING the technical ones
      allowed in detail only: **Waktu, User (username), Role (userRole), Module, Action,
      Status, Source IP (sourceIp), User Agent (userAgent), Change Ticket (changeTicket),
      Correlation ID (correlationId)**. Render the status with the same inline pill from item 4.
      Then render the **four JSONB payloads** (`requestPayload`, `commandPayload`,
      `executionPayload`, `responsePayload`) — SKIP any that are null — each under an Indonesian
      sub-heading, pretty-printed with `JSON.stringify(value, null, 2)` inside a terminal-style
      `<pre>` block. Reuse `RawCommandBox` if the value stringifies to a single command-like
      string; otherwise use a styled `<pre class="rounded-lg bg-terminal p-4 font-mono text-xs
      ... whitespace-pre-wrap break-all text-terminal-text">` matching the acl page's terminal
      blocks (confirm `bg-terminal`/`text-terminal-text` tokens exist — they are used in
      `acl/index.vue`, so safe). Ensure the modal has an accessible label (the `title` prop
      covers it) and icon-only close/buttons carry `aria-label`.
      Files: `app/pages/logs/index.vue`
      Verify: clicking a row opens the modal with the core fields and only the non-null payload
      blocks; `npm run typecheck` passes.

- [ ] 7. Add the ACL/ROUTE "Inspeksi Eksekusi" section inside the detail modal.
      Only for rows where `selected.module === 'ACL'` or `'ROUTE'`, and only fetched when the
      modal opens (not eagerly for every list row). State: `execLogs =
      ref<AclLogResponse[] | RouteLogResponse[]>([])`, `execLoading = ref(false)`,
      `execError = ref(false)`. In `openDetail` (or a `watch(detailOpen)`), after setting
      `selected`, if module is ACL call `aclLogs.byCorrelation(selected.correlationId)`, if ROUTE
      call `routeLogs.byCorrelation(selected.correlationId)`; otherwise clear `execLogs`. Guard
      with try/catch → `execError`, set `execLoading` around the call. Render a section titled
      "Inspeksi Eksekusi" that shows: `LoadingState` while `execLoading`; on error a soft
      `UAlert color="error" variant="soft"`; when the array is empty a soft inline note
      "Tidak ada detail eksekusi" (muted text, NOT a hard error — empty array is a valid 200);
      when populated, list each detail row's `device`, `action`, `status` (reuse the inline
      pill), ACL `source`/`destination` or ROUTE `destination`/`changeTicket`, and the
      `commandPreview`/`executionMeta`/`responseSummary` JSONB in `<pre>` blocks (skip nulls),
      same terminal styling as item 6. Reset `execLogs`/`execError`/`execLoading` when the modal
      closes so stale data isn't shown on the next open.
      Files: `app/pages/logs/index.vue`
      Verify: opening an ACL or ROUTE log fetches its correlation details once on open and shows
      them (or the soft "Tidak ada detail eksekusi" when empty); opening AUTH/USER/N8N logs makes
      no exec-log request and shows no Inspeksi section; `npm run typecheck` passes.

- [ ] 8. Final accessibility + copy + scope pass (review, no new behavior).
      Confirm: all user-facing strings are Indonesian; all code comments are English; every
      icon-only button has an `aria-label`; status is conveyed by text (the enum word) not color
      alone (item 4 pill); filter inputs and the modal are labeled (`FormField`/`UModal title`);
      the clickable rows are keyboard-operable (item 3). Confirm scope: the diff touches ONLY
      `app/pages/logs/index.vue` and `app/composables/useApi.ts` — no edits to `server/`,
      `database/`, `shared/schemas/`, or `StatusBadge.vue`, no export/CSV, no new dependency.
      Files: `app/pages/logs/index.vue`, `app/composables/useApi.ts`
      Verify: `npm run typecheck` passes clean; manual smoke of `/logs` (list, filter, paginate,
      open ACL/ROUTE detail with Inspeksi, open AUTH detail without it) behaves as described.

## Open items (needs verification during implementation)

- Whether `to` date should be pushed to end-of-day for an inclusive range (server uses `lte`
  on a timestamp; a bare date midnight would exclude same-day later entries). Decide during
  implementation; default to appending end-of-day if same-day filtering looks wrong.
- Whether the list already returns the full payload fields on every row (it does per
  `toAuditResponse`); keep `audit.get(id)` as a fallback only if a payload comes back absent.
- Whether to use `useHead` for the document title (match whatever sibling pages do).
- Debounce on the search input is optional polish, not required.

## Scope guard

Touch only `app/`: the new page and the `useApi.ts` additions. A tiny inline helper
(`formatTime`, `prettyJson`) lives in the page itself — no new shared file unless genuinely
reused. Do NOT modify `server/`, `database/`, `shared/schemas/`, or `StatusBadge.vue`. No
export/CSV this run. No new date-picker dependency (native `<input type="date">` only).
