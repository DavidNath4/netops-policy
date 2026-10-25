<script setup lang="ts">
// Log Trail page — the system-of-record audit view (common access).
//
// Master table lists audit entries (Time, User, Source IP, Module, Action,
// Status) with a complete filter set (search, module, action, status, date
// range) where the Action options depend on the selected Module, server-
// side pagination, and loading/empty/error states. Clicking a row opens a
// detail modal with the full audit record (including technical fields) and the
// four JSONB payloads. For ACL/ROUTE rows the modal also fetches the matching
// execution-inspection detail rows ("Inspeksi Eksekusi") by correlation id.
//
// Common access: NO permission middleware (the sidebar links /audit-trail with
// no permission); the global auth middleware already protects the page.
import type { AuditResponse } from '#shared/schemas/audit.schema'
import type { AclLogResponse, RouteLogResponse } from '#shared/schemas/exec-log.schema'

const { audit, aclLogs, routeLogs } = useApi()

// ---------------------------------------------------------------------------
// Filter option arrays (match the Zod enums; ALL = "All" / omit the param)
// ---------------------------------------------------------------------------
// `ALL` is the "All" sentinel — Nuxt UI/Reka USelect forbids an empty-string
// item value (it's reserved for clearing the selection), so we use 'ALL' and
// treat it as "omit the filter param" in buildParams().
const ALL = 'ALL'
// N8N is intentionally absent: n8n activity is folded into the ACL/ROUTE rows
// (the raw n8n request/response is captured inside those audit payloads).
const moduleOptions = [
  { label: 'All', value: ALL },
  { label: 'AUTH', value: 'AUTH' },
  { label: 'USER', value: 'USER' },
  { label: 'ACL', value: 'ACL' },
  { label: 'ROUTE', value: 'ROUTE' },
  { label: 'TIME_RANGE', value: 'TIME_RANGE' },
]
const statusOptions = [
  { label: 'All', value: ALL },
  { label: 'SUCCESS', value: 'SUCCESS' },
  { label: 'FAILED', value: 'FAILED' },
]

// Action options depend on the selected Module. Each list begins with the
// "All" sentinel; the per-module actions mirror what each module can record.
type ActionItem = { label: string, value: string }
const ALL_ITEM: ActionItem = { label: 'All', value: ALL }
const ACTIONS_BY_MODULE: Record<string, ActionItem[]> = {
  [ALL]: [
    ALL_ITEM,
    { label: 'LOGIN', value: 'LOGIN' },
    { label: 'LOGOUT', value: 'LOGOUT' },
    { label: 'MFA_VERIFY', value: 'MFA_VERIFY' },
    { label: 'SHOW', value: 'SHOW' },
    { label: 'ADD', value: 'ADD' },
    { label: 'DELETE', value: 'DELETE' },
    { label: 'UPDATE', value: 'UPDATE' },
  ],
  AUTH: [
    ALL_ITEM,
    { label: 'LOGIN', value: 'LOGIN' },
    { label: 'LOGOUT', value: 'LOGOUT' },
    { label: 'MFA_VERIFY', value: 'MFA_VERIFY' },
  ],
  ACL: [
    ALL_ITEM,
    { label: 'SHOW', value: 'SHOW' },
    { label: 'ADD', value: 'ADD' },
    { label: 'DELETE', value: 'DELETE' },
  ],
  ROUTE: [
    ALL_ITEM,
    { label: 'SHOW', value: 'SHOW' },
    { label: 'ADD', value: 'ADD' },
    { label: 'DELETE', value: 'DELETE' },
  ],
  // Time Range records only writes (create/delete); its Show is read-only and
  // not audited, so no SHOW here.
  TIME_RANGE: [
    ALL_ITEM,
    { label: 'ADD', value: 'ADD' },
    { label: 'DELETE', value: 'DELETE' },
  ],
  USER: [
    ALL_ITEM,
    { label: 'UPDATE', value: 'UPDATE' },
  ],
}

/** Action dropdown items for the currently-selected Module. */
const actionOptions = computed<ActionItem[]>(() => ACTIONS_BY_MODULE[filters.module] ?? ACTIONS_BY_MODULE[ALL]!)

// ---------------------------------------------------------------------------
// List state + loading (mirrors administration/index.vue)
// ---------------------------------------------------------------------------
const ITEMS_PER_PAGE = 20

const rows = ref<AuditResponse[]>([])
const total = ref(0)
const page = ref(1)
const pending = ref(true)
const error = ref(false)

// Reactive filters. `search` is applied on submit; the selects/dates apply
// immediately. All empty values are omitted from the request params.
const filters = reactive({
  search: '',
  module: ALL,
  action: ALL,
  status: ALL,
  from: '',
  to: '',
})

// The search text that is actually sent to the server (committed on submit).
const appliedSearch = ref('')

/** Build request params, omitting any empty/blank filter so blanks never hit the server. */
function buildParams(): Record<string, unknown> {
  const params: Record<string, unknown> = { page: page.value, limit: ITEMS_PER_PAGE }
  if (appliedSearch.value.trim()) params.search = appliedSearch.value.trim()
  if (filters.module !== ALL) params.module = filters.module
  if (filters.action !== ALL) params.action = filters.action
  if (filters.status !== ALL) params.status = filters.status
  // Native date inputs give YYYY-MM-DD; convert to ISO. `to` covers the whole
  // day (end-of-day) so a same-day upper bound is inclusive (server uses lte).
  if (filters.from) params.from = new Date(`${filters.from}T00:00:00`).toISOString()
  if (filters.to) params.to = new Date(`${filters.to}T23:59:59.999`).toISOString()
  return params
}

async function load() {
  pending.value = true
  error.value = false
  try {
    const res = await audit.list(buildParams())
    rows.value = res.items
    total.value = res.total
  }
  catch {
    error.value = true
  }
  finally {
    pending.value = false
  }
}

onMounted(load)
watch(page, load)

// When the Module changes, drop any Action that isn't valid for the new Module
// so the request stays consistent. Runs before the reload watcher below picks up
// the (possibly reset) action value.
watch(() => filters.module, () => {
  const valid = actionOptions.value.some(o => o.value === filters.action)
  if (!valid) filters.action = ALL
})

// Any filter change (except the raw search text, which is submit-driven) resets
// to page 1 and reloads.
watch(
  () => [filters.module, filters.action, filters.status, filters.from, filters.to],
  () => {
    page.value = 1
    void load()
  },
)

/** Commit the current search text and reload from page 1. */
function submitSearch() {
  appliedSearch.value = filters.search
  page.value = 1
  void load()
}

/** Clear every filter and reload. */
function resetFilters() {
  filters.search = ''
  filters.module = ALL
  filters.action = ALL
  filters.status = ALL
  filters.from = ''
  filters.to = ''
  appliedSearch.value = ''
  page.value = 1
  void load()
}

const skeletonRows = computed(() => Array.from({ length: 5 }, (_, i) => i))

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
/** Format an ISO timestamp into a readable local datetime. */
function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-GB')
}

/** Pretty-print any JSONB payload for a <pre> block. */
function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  }
  catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// Detail / inspection modal
// ---------------------------------------------------------------------------
const detailOpen = ref(false)
const selected = ref<AuditResponse | null>(null)

// ACL/ROUTE execution-inspection detail rows (fetched only when a modal opens
// for an ACL or ROUTE log).
const execLogs = ref<(AclLogResponse | RouteLogResponse)[]>([])
const execLoading = ref(false)
const execError = ref(false)

const isExecModule = computed(
  () => selected.value?.module === 'ACL' || selected.value?.module === 'ROUTE',
)

/** Core audit fields rendered as a definition list in the detail modal. */
const detailFields = computed(() => {
  const s = selected.value
  if (!s) return []
  return [
    { label: 'Time', value: formatTime(s.createdAt) },
    { label: 'User', value: s.username ?? '—' },
    { label: 'Role', value: s.userRole ?? '—' },
    { label: 'Module', value: s.module },
    { label: 'Action', value: s.action },
    { label: 'Source IP', value: s.sourceIp ?? '—' },
    { label: 'User Agent', value: s.userAgent ?? '—' },
    { label: 'Change Ticket', value: s.changeTicket ?? '—' },
    { label: 'Correlation ID', value: s.correlationId },
  ]
})

/** JSONB payload blocks (null payloads are skipped). */
const detailPayloads = computed(() => {
  const s = selected.value
  if (!s) return []
  return [
    { label: 'Request Payload', value: s.requestPayload },
    { label: 'Command Payload', value: s.commandPayload },
    { label: 'Execution Payload', value: s.executionPayload },
    { label: 'Response Payload', value: s.responsePayload },
  ].filter(p => p.value !== null && p.value !== undefined)
})

async function loadExecLogs(row: AuditResponse) {
  execLogs.value = []
  execError.value = false
  if (row.module !== 'ACL' && row.module !== 'ROUTE') return
  execLoading.value = true
  try {
    execLogs.value
      = row.module === 'ACL'
        ? await aclLogs.byCorrelation(row.correlationId)
        : await routeLogs.byCorrelation(row.correlationId)
  }
  catch {
    execError.value = true
  }
  finally {
    execLoading.value = false
  }
}

function openDetail(row: AuditResponse) {
  selected.value = row
  detailOpen.value = true
  void loadExecLogs(row)
}

// Clear stale inspection data whenever the modal closes.
watch(detailOpen, (open) => {
  if (!open) {
    execLogs.value = []
    execLoading.value = false
    execError.value = false
  }
})

/** ACL-only source endpoint; undefined for ROUTE rows. */
function execSource(detail: AclLogResponse | RouteLogResponse): string | null | undefined {
  return 'source' in detail ? detail.source : undefined
}

/** ROUTE-only change ticket; undefined for ACL rows. */
function execChangeTicket(detail: AclLogResponse | RouteLogResponse): string | null | undefined {
  return 'changeTicket' in detail ? detail.changeTicket : undefined
}

/** JSONB blocks for one exec-log detail row (null fields skipped). */
function execDetailBlocks(detail: AclLogResponse | RouteLogResponse) {
  return [
    { label: 'Command Preview', value: detail.commandPreview },
    { label: 'Execution Metadata', value: detail.executionMeta },
    { label: 'Response Summary', value: detail.responseSummary },
  ].filter(b => b.value !== null && b.value !== undefined)
}
</script>

<template>
  <!-- Fill the content area (viewport minus the sticky header + main padding)
       so the TABLE scrolls internally and the page itself never grows. -->
  <div class="flex h-[calc(100vh-7rem)] flex-col gap-6">
    <PageHeader title="Log Trail" description="System activity and audit history." />

    <!-- Filter form: Search on its own row; Module/Action/Status/From/To on a
         single compact row (wraps on small screens, one line on desktop). -->
    <form
      class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-4"
      @submit.prevent="submitSearch"
    >
      <!-- Row 1: search + Search/Reset buttons -->
      <FormField label="Search" name="log-search">
        <template #default="{ id }">
          <div class="flex gap-2">
            <UInput
              :id="id"
              v-model="filters.search"
              color="neutral"
              variant="outline"
              placeholder="Search by username, display name, or email"
              class="w-full"
              :ui="{ base: 'bg-panel text-ink ring-line placeholder:text-muted' }"
            />
            <UButton
              type="submit"
              color="primary"
              icon="i-lucide-search"
              label="Search"
              class="bg-brand text-white hover:bg-brand/90"
              :ui="{ label: 'text-white' }"
            />
            <UButton
              type="button"
              color="neutral"
              variant="outline"
              icon="i-lucide-x"
              label="Reset"
              @click="resetFilters"
            />
          </div>
        </template>
      </FormField>

      <!-- Row 2: Module, Action, Status, From, To — always a single row.
           flex-nowrap keeps them on one line; equal flex-1 widths; the row
           scrolls horizontally only if the viewport is extremely narrow. -->
      <div class="flex flex-nowrap items-start gap-4 overflow-x-auto">
        <FormField label="Module" name="log-module" class="min-w-[120px] flex-1">
          <template #default="{ id }">
            <USelect
              :id="id"
              v-model="filters.module"
              :items="moduleOptions"
              value-key="value"
              color="neutral"
              variant="outline"
              class="w-full"
              :ui="{ base: 'bg-panel text-ink ring-line' }"
            />
          </template>
        </FormField>

        <FormField label="Action" name="log-action" class="min-w-[120px] flex-1">
          <template #default="{ id }">
            <USelect
              :id="id"
              v-model="filters.action"
              :items="actionOptions"
              value-key="value"
              color="neutral"
              variant="outline"
              class="w-full"
              :ui="{ base: 'bg-panel text-ink ring-line' }"
            />
          </template>
        </FormField>

        <FormField label="Status" name="log-status" class="min-w-[120px] flex-1">
          <template #default="{ id }">
            <USelect
              :id="id"
              v-model="filters.status"
              :items="statusOptions"
              value-key="value"
              color="neutral"
              variant="outline"
              class="w-full"
              :ui="{ base: 'bg-panel text-ink ring-line' }"
            />
          </template>
        </FormField>

        <FormField label="From" name="log-from" class="min-w-[120px] flex-1">
          <template #default="{ id }">
            <input
              :id="id"
              v-model="filters.from"
              type="date"
              class="h-9 w-full rounded-md border border-line bg-panel px-2.5 text-sm text-ink outline-none focus:border-brand"
            >
          </template>
        </FormField>

        <FormField label="To" name="log-to" class="min-w-[120px] flex-1">
          <template #default="{ id }">
            <input
              :id="id"
              v-model="filters.to"
              type="date"
              class="h-9 w-full rounded-md border border-line bg-panel px-2.5 text-sm text-ink outline-none focus:border-brand"
            >
          </template>
        </FormField>
      </div>
    </form>

    <ErrorState
      v-if="error"
      message="Could not load the log trail."
      @retry="load"
    />

    <template v-else>
      <!-- Empty state -->
      <EmptyState
        v-if="!pending && rows.length === 0"
        title="No results"
        description="No activity matches the current filters."
        icon="i-lucide-scroll-text"
      />

      <!-- Master table card — a standard horizontal HTML table whose BODY scrolls
           inside this card (sticky header) so the page itself doesn't grow with
           rows; pagination sits beneath the scroll area. The card takes the
           remaining flex height (flex-1 min-h-0) and the inner div scrolls. -->
      <div v-else class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-sm">
        <!-- overflow-x-auto for narrow screens; overflow-y-auto fills the card
             height for the internal vertical scroll. -->
        <div class="min-h-0 flex-1 overflow-x-auto overflow-y-auto">
          <table class="w-full min-w-[820px] border-collapse text-left">
            <thead class="sticky top-0 z-10">
              <tr class="border-b border-line bg-surface">
                <th class="bg-surface px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted">Time</th>
                <th class="bg-surface px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted">User</th>
                <th class="bg-surface px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted">Source IP</th>
                <th class="bg-surface px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted">Module</th>
                <th class="bg-surface px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted">Action</th>
                <th class="bg-surface px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted">Status</th>
              </tr>
            </thead>

            <!-- Loading skeleton -->
            <tbody v-if="pending">
              <tr
                v-for="n in skeletonRows"
                :key="`sk-${n}`"
                class="border-b border-line last:border-b-0"
              >
                <td class="px-4 py-3"><USkeleton class="h-4 w-32" /></td>
                <td class="px-4 py-3"><USkeleton class="h-4 w-28" /></td>
                <td class="px-4 py-3"><USkeleton class="h-4 w-24" /></td>
                <td class="px-4 py-3"><USkeleton class="h-5 w-14 rounded-full" /></td>
                <td class="px-4 py-3"><USkeleton class="h-4 w-16" /></td>
                <td class="px-4 py-3"><USkeleton class="h-5 w-16 rounded-full" /></td>
              </tr>
            </tbody>

            <!-- Data rows (keyboard-accessible; Enter/Space opens the detail) -->
            <tbody v-else>
              <tr
                v-for="row in rows"
                :key="row.id"
                role="button"
                tabindex="0"
                :aria-label="`View log detail ${row.username ?? 'no user'} ${row.module} ${row.action}`"
                class="cursor-pointer border-b border-line transition-colors last:border-b-0 hover:bg-surface/60 focus:bg-surface/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
                @click="openDetail(row)"
                @keydown.enter.prevent="openDetail(row)"
                @keydown.space.prevent="openDetail(row)"
              >
                <td class="whitespace-nowrap px-4 py-2.5 text-sm text-ink">{{ formatTime(row.createdAt) }}</td>
                <td class="max-w-[200px] truncate px-4 py-2.5 text-sm text-ink">{{ row.username ?? '—' }}</td>
                <td class="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-muted">{{ row.sourceIp ?? '—' }}</td>
                <td class="px-4 py-2.5">
                  <span class="inline-flex items-center rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-ink ring-1 ring-line">
                    {{ row.module }}
                  </span>
                </td>
                <td class="whitespace-nowrap px-4 py-2.5 text-sm text-ink">{{ row.action }}</td>
                <td class="px-4 py-2.5">
                  <span
                    class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
                    :class="row.status === 'SUCCESS' ? 'bg-ok/10 text-ok' : 'bg-bad/10 text-bad'"
                  >
                    <UIcon
                      :name="row.status === 'SUCCESS' ? 'i-lucide-check' : 'i-lucide-x'"
                      class="size-3.5"
                      aria-hidden="true"
                    />
                    {{ row.status }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <Pagination
        v-if="total > ITEMS_PER_PAGE"
        v-model:page="page"
        :total="total"
        :items-per-page="ITEMS_PER_PAGE"
      />
    </template>

    <!-- Detail / inspection modal -->
    <UModal v-model:open="detailOpen" title="Log Detail">
      <template #body>
        <div v-if="selected" class="flex flex-col gap-6">
          <!-- Core audit fields -->
          <dl class="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            <div v-for="field in detailFields" :key="field.label" class="flex flex-col gap-0.5">
              <dt class="text-[11px] font-semibold uppercase tracking-wide text-muted">{{ field.label }}</dt>
              <dd class="break-all text-sm text-ink">{{ field.value }}</dd>
            </div>
            <div class="flex flex-col gap-0.5">
              <dt class="text-[11px] font-semibold uppercase tracking-wide text-muted">Status</dt>
              <dd>
                <span
                  class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
                  :class="selected.status === 'SUCCESS' ? 'bg-ok/10 text-ok' : 'bg-bad/10 text-bad'"
                >
                  <UIcon
                    :name="selected.status === 'SUCCESS' ? 'i-lucide-check' : 'i-lucide-x'"
                    class="size-3.5"
                    aria-hidden="true"
                  />
                  {{ selected.status }}
                </span>
              </dd>
            </div>
          </dl>

          <!-- JSONB payloads (null payloads skipped) -->
          <div v-if="detailPayloads.length" class="flex flex-col gap-4">
            <div v-for="payload in detailPayloads" :key="payload.label" class="flex flex-col gap-2">
              <h3 class="text-[13px] font-semibold text-ink">{{ payload.label }}</h3>
              <div class="rounded-lg bg-terminal p-4 font-mono text-xs leading-relaxed">
                <pre class="whitespace-pre-wrap break-all text-terminal-text">{{ prettyJson(payload.value) }}</pre>
              </div>
            </div>
          </div>

          <!-- ACL/ROUTE execution inspection -->
          <section v-if="isExecModule" class="flex flex-col gap-3">
            <h3 class="text-base font-semibold text-ink">Execution Inspection</h3>

            <LoadingState v-if="execLoading" message="Loading execution detail…" />

            <UAlert
              v-else-if="execError"
              color="error"
              variant="soft"
              icon="i-lucide-circle-alert"
              description="Failed to load execution detail."
            />

            <p v-else-if="execLogs.length === 0" class="text-sm text-muted">
              No execution detail
            </p>

            <template v-else>
              <div
                v-for="detail in execLogs"
                :key="detail.id"
                class="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
              >
                <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
                  <div class="flex flex-col gap-0.5">
                    <span class="text-[11px] font-semibold uppercase tracking-wide text-muted">Device</span>
                    <span class="text-sm text-ink">{{ detail.device ?? '—' }}</span>
                  </div>
                  <div class="flex flex-col gap-0.5">
                    <span class="text-[11px] font-semibold uppercase tracking-wide text-muted">Action</span>
                    <span class="text-sm text-ink">{{ detail.action }}</span>
                  </div>
                  <div class="flex flex-col gap-0.5">
                    <span class="text-[11px] font-semibold uppercase tracking-wide text-muted">Status</span>
                    <span
                      class="inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
                      :class="detail.status === 'SUCCESS' ? 'bg-ok/10 text-ok' : 'bg-bad/10 text-bad'"
                    >
                      <UIcon
                        :name="detail.status === 'SUCCESS' ? 'i-lucide-check' : 'i-lucide-x'"
                        class="size-3.5"
                        aria-hidden="true"
                      />
                      {{ detail.status }}
                    </span>
                  </div>
                  <!-- ACL has source/destination; ROUTE has destination/changeTicket -->
                  <div v-if="execSource(detail) !== undefined" class="flex flex-col gap-0.5">
                    <span class="text-[11px] font-semibold uppercase tracking-wide text-muted">Source</span>
                    <span class="text-sm text-ink">{{ execSource(detail) ?? '—' }}</span>
                  </div>
                  <div class="flex flex-col gap-0.5">
                    <span class="text-[11px] font-semibold uppercase tracking-wide text-muted">Destination</span>
                    <span class="text-sm text-ink">{{ detail.destination ?? '—' }}</span>
                  </div>
                  <div v-if="execChangeTicket(detail) !== undefined" class="flex flex-col gap-0.5">
                    <span class="text-[11px] font-semibold uppercase tracking-wide text-muted">Change Ticket</span>
                    <span class="text-sm text-ink">{{ execChangeTicket(detail) ?? '—' }}</span>
                  </div>
                </div>

                <!-- Per-detail JSONB blocks (null fields skipped) -->
                <div
                  v-for="block in execDetailBlocks(detail)"
                  :key="block.label"
                  class="flex flex-col gap-2"
                >
                  <h4 class="text-[13px] font-semibold text-ink">{{ block.label }}</h4>
                  <div class="rounded-lg bg-terminal p-4 font-mono text-xs leading-relaxed">
                    <pre class="whitespace-pre-wrap break-all text-terminal-text">{{ prettyJson(block.value) }}</pre>
                  </div>
                </div>
              </div>
            </template>
          </section>
        </div>
      </template>

      <template #footer>
        <div class="flex w-full justify-end">
          <UButton color="neutral" variant="ghost" label="Close" @click="detailOpen = false" />
        </div>
      </template>
    </UModal>
  </div>
</template>
