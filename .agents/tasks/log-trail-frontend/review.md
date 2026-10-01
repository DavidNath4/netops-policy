# Log Trail frontend: master table, filters, and ACL/ROUTE execution inspection

Adds the `/logs` page (`app/pages/logs/index.vue`) and three API accessors in `app/composables/useApi.ts` (`audit`, `aclLogs.byCorrelation`, `routeLogs.byCorrelation`). The page renders audit entries in a master table (Waktu/Pengguna/Modul/Aksi/Status) with a full server-side filter set and pagination, and a row-click detail modal that surfaces the full audit record plus the four JSONB payloads. For ACL/ROUTE rows the modal additionally fetches the complement detail tables by `correlationId` and renders an "Inspeksi Eksekusi" panel. The work is confined to `app/`; no server, schema, database, or shared-component files are touched.

Watch for: nothing blocking. The page faithfully mirrors `administration/index.vue` patterns and the `ui-conventions` token set, keeps the master table free of technical columns, uses an inline status pill (StatusBadge untouched), omits empty filter params, and wires the by-correlation calls to the real `[id].get.ts` routes. Minor observations below are non-blocking (confidence noted inline).

**Verdict**: APPROVED

## High-level view

The page is a near-exact structural clone of `administration/index.vue`: same `rows/total/page/pending/error` state machine, same `ITEMS_PER_PAGE = 20` server-side pagination, same card/grid table, same shared `PageHeader`/`ErrorState`/`EmptyState`/`Pagination`/`FormField` components and the same token-backed utility classes. No new styling approach, no hard-coded hex, no new dependency.

Access control is correct for a common-access page: there is no `definePageMeta` permission middleware at all, matching the stated intent that the global auth middleware alone protects `/logs`.

The master table shows only Waktu/Pengguna/Modul/Aksi/Status. Technical fields (Source IP, User Agent, Role, Correlation ID, Change Ticket) are deliberately held back for the detail modal. Waktu is a formatted `toLocaleString('id-ID')` value with an ISO fallback, and username falls back to `—`.

Status is conveyed by an inline pill with both an icon and the literal SUCCESS/FAILED text, colored via `text-ok`/`text-bad` — so status is never color-only, and the shared `StatusBadge.vue` is left untouched as required.

The filter set is complete: a submit-driven search (placeholder naming username/display name/email), Module/Action/Status selects whose "Semua" option is `''` and is omitted from the request, and Dari/Sampai native date inputs converted to ISO `from`/`to` with each empty bound omitted. Any select/date change resets to page 1; search resets to page 1 on submit. `buildParams` only ever adds a key when the value is non-empty, so blanks never reach the server.

The detail modal is labeled (`UModal title="Detail Log"`), rows are keyboard-operable (`role="button"`, `tabindex="0"`, Enter/Space handlers, descriptive `aria-label`), the four JSONB payloads render in `bg-terminal` `<pre>` blocks with null payloads filtered out, and the ACL/ROUTE inspection fetches run only for ACL/ROUTE modules and only on modal open, with empty/failed results shown softly ("Tidak ada detail eksekusi" / a soft alert) rather than as a page error.

The `useApi` additions follow the existing `audit:` block style, go through the envelope-unwrapping SSR-safe `apiGet`, import the types from `#shared/schemas/exec-log.schema`, and target paths that match the real `server/api/acl-logs/correlation/[id].get.ts` and `server/api/route-logs/correlation/[id].get.ts` routes.

<details>
<summary>Issues (2)</summary>

1. **Search field coverage is server-dependent (possible)** — the placeholder promises username/display name/email search; the frontend only forwards `search`. Whether all three fields are matched depends on `audit.service.ts`, which is outside this diff. No change needed here; just confirm the server honors it.
2. **Exec-inspection "Aksi"/"Status" labels duplicate the parent row (possible)** — the inspection cards repeat Aksi/Status that already appear in the audit detail. Harmless and arguably useful (per-device granularity), but worth a glance to confirm it reads cleanly when there are multiple detail rows.

</details>

<details>
<summary>Details</summary>

### Pattern and token fidelity

The page copies the `administration/index.vue` shape: identical list state (`rows`, `total`, `page`, `pending`, `error`), `onMounted(load)` + `watch(page, load)`, the `overflow-hidden rounded-lg border border-line bg-panel shadow-sm` table card, the `bg-surface` header row with `text-xs font-semibold uppercase tracking-wide text-muted` column labels, the skeleton loading rows, and the `v-if="total > ITEMS_PER_PAGE"` `Pagination`. Every color is a token utility (`bg-surface`, `bg-panel`, `border-line`, `text-ink`, `text-muted`, `bg-brand`, `text-ok`, `text-bad`) and the two `<pre>` payload boxes use the real `bg-terminal`/`text-terminal-text` tokens defined in `tailwind.css`. No raw hex, no new component system.

Inputs follow the convention explicitly — `UInput`/`USelect` carry `color="neutral" variant="outline"` and `:ui="{ base: 'bg-panel text-ink ring-line …' }"`, and the primary Cari button uses `bg-brand text-white hover:bg-brand/90` with `:ui="{ label: 'text-white' }"`. The native date inputs are styled with token utilities (`border-line bg-panel text-ink focus:border-brand`) rather than hex.

### Status pill without touching StatusBadge

The master table and the modal both render status with an inline pill:

```vue
<span
  class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
  :class="row.status === 'SUCCESS' ? 'bg-ok/10 text-ok' : 'bg-bad/10 text-bad'"
>
  <UIcon :name="row.status === 'SUCCESS' ? 'i-lucide-check' : 'i-lucide-x'" ... aria-hidden="true" />
  {{ row.status }}
</span>
```

Status is conveyed through text and icon, not color alone, and `StatusBadge.vue` is unmodified. The icon is `aria-hidden`, so screen readers read the SUCCESS/FAILED text.

### Filter param hygiene and page-reset

`buildParams()` starts from `{ page, limit }` and conditionally adds each filter only when truthy, so `module`/`action`/`status`/`search` are omitted when "Semua"/blank, and `from`/`to` are omitted when their date input is empty. Date conversion is local-midnight → ISO for `from` and local end-of-day (`23:59:59.999`) → ISO for `to`, which makes a same-day upper bound inclusive against a server `lte`. The selects/date watcher resets `page` to 1 before reload; `submitSearch()` commits `appliedSearch` and resets to page 1. Search is submit-driven (not reactive) by design.

### Detail modal and keyboard access

Rows are `role="button"`, `tabindex="0"`, with `@click`, `@keydown.enter.prevent`, `@keydown.space.prevent`, and an `aria-label` describing the entry. The modal is labeled via `UModal title="Detail Log"`. The core fields list surfaces the technical fields withheld from the table — Source IP, User Agent, Role, Change Ticket, Correlation ID — and the status pill is repeated in the modal. The four payload blocks are filtered with `p.value !== null && p.value !== undefined` so null JSONB payloads are skipped rather than printed as empty boxes.

### ACL/ROUTE execution inspection

`loadExecLogs` guards on `row.module !== 'ACL' && row.module !== 'ROUTE'` and is invoked from `openDetail`, so the complement tables are fetched only for ACL/ROUTE rows and only when a modal opens. ACL uses `aclLogs.byCorrelation`, ROUTE uses `routeLogs.byCorrelation`. The `execSource`/`execChangeTicket` helpers use `'source' in detail` / `'changeTicket' in detail` to narrow the ACL vs ROUTE union, so ACL rows render Source + Destination and ROUTE rows render Destination + Change Ticket, with `commandPreview`/`executionMeta`/`responseSummary` as per-detail `<pre>` blocks (null fields filtered). A failed fetch sets `execError` and renders a soft `UAlert`; an empty array renders the "Tidak ada detail eksekusi" line — neither is treated as a page-level error, matching the requirement. The `watch(detailOpen)` clears `execLogs`/`execLoading`/`execError` on close so stale inspection data never leaks into the next modal.

### useApi additions and route path match

The three accessors reuse the existing `audit:` block style and the envelope-unwrapping, SSR-safe `apiGet`:

```ts
aclLogs.byCorrelation(correlationId) -> GET /api/acl-logs/correlation/${correlationId}
routeLogs.byCorrelation(correlationId) -> GET /api/route-logs/correlation/${correlationId}
```

Both target directories hold `correlation/[id].get.ts` handlers that read `getRouterParam(event, 'id')`, validate it with `CorrelationIdSchema`, require an authenticated user (no feature permission), and return `ok(array)` — so the client return type `Promise<AclLogResponse[]>` / `Promise<RouteLogResponse[]>` matches the server contract, including the empty-array-is-200 behavior the UI relies on. Types are imported from `#shared/schemas/exec-log.schema`, and the fields consumed on the page (`id`, `device`, `action`, `status`, `source`, `destination`, `changeTicket`, `commandPreview`, `executionMeta`, `responseSummary`) all exist on those Zod-inferred shapes.

### Verified against typecheck breakers

`FormField` exposes `id` on its default slot (`#default="{ id }"` is valid) and binds its `<label for>` to the same `field-${name}` id. `ErrorState` emits `retry` and defaults `retryable` to true, so `@retry="load"` with no explicit prop works. `Pagination` accepts `v-model:page`, `total`, `items-per-page`. `USelect` with `value-key="value"` bound to a string `v-model` matches the administration usage. `AuditResponse`/`AuditLogResponse` fields read by the page all exist on the schemas. `search` is a real field on `PaginationQuerySchema`, so `audit.list({ search })` validates server-side.

### Copy and scope

User-facing strings are Indonesian (Cari/Modul/Aksi/Status/Dari/Sampai/Waktu/Pengguna/Detail/Inspeksi Eksekusi/Tidak ada data/Tidak ada detail eksekusi) while enum option values stay as system codes (AUTH/USER/ACL/ROUTE/N8N, LOGIN/SHOW/ADD/DELETE/UPDATE, SUCCESS/FAILED) and code comments are English. Only `app/` is touched; no export/CSV control was added; no new dependency.

</details>

<details>
<summary>File map</summary>

- `app/pages/logs/index.vue` — new Log Trail page: master table, full filter set, server-side pagination, detail modal, ACL/ROUTE execution-inspection panel.
- `app/composables/useApi.ts` — added `aclLogs.byCorrelation` and `routeLogs.byCorrelation` accessors (the `audit`/`aclLogs`/`routeLogs` blocks); envelope-unwrapping via `apiGet`.

Full change: `git diff main -- app/pages/logs/index.vue app/composables/useApi.ts`.

</details>
