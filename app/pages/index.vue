<script setup lang="ts">
// Dashboard (default layout). A BI overview derived entirely from audit_logs
// (this app is the audit system of record, not the source of truth for ACL/route
// counts). Five approved widgets, each backed by its OWN endpoint so they load
// in parallel and each shows its own loading/error/empty state:
//   1) KPI row — Total Activity, Config Changes, Success Rate (each "vs last month")
//   2) Activity Over Time — bar chart with a Daily/Weekly/Monthly toggle
//   3) Config Changes by Operation — ROUTE/ADD, ROUTE/DELETE, ACL/ADD, ACL/DELETE
//   4) Top Active Users — ranked by activity count only
//   5) Recent Config Changes — newest config mutations with inline status
//
// KPI deltas are a STATIC "vs last month" comparison; the chart toggle is
// independent (it only switches a pre-fetched series client-side, no refetch).

interface KpiDelta {
  value: number
  delta: number
}
interface Kpi {
  totalActivity: KpiDelta
  configChanges: KpiDelta
  successRate: KpiDelta
}
interface SeriesPoint {
  bucket: string
  count: number
}
interface ActivitySeries {
  daily: SeriesPoint[]
  weekly: SeriesPoint[]
  monthly: SeriesPoint[]
}
interface ConfigByOperation {
  operation: string
  count: number
}
interface TopUser {
  username: string
  count: number
}
interface RecentConfigChange {
  id: string
  module: string
  action: string
  username: string | null
  status: string
  createdAt: string
}

const { dashboard } = useApi()

// ---------------------------------------------------------------------------
// Per-widget async state — each widget owns its own data/pending/error and
// fetches its own endpoint. They are kicked off in parallel in onMounted so a
// slow widget never blocks the others, and each can be retried on its own.
// ---------------------------------------------------------------------------
const kpiData = ref<Kpi | null>(null)
const kpiPending = ref(true)
const kpiError = ref(false)

async function loadKpi() {
  kpiPending.value = true
  kpiError.value = false
  try {
    kpiData.value = await dashboard.kpi()
  }
  catch {
    kpiError.value = true
  }
  finally {
    kpiPending.value = false
  }
}

const seriesData = ref<ActivitySeries | null>(null)
const seriesPending = ref(true)
const seriesError = ref(false)

async function loadSeries() {
  seriesPending.value = true
  seriesError.value = false
  try {
    seriesData.value = await dashboard.activitySeries()
  }
  catch {
    seriesError.value = true
  }
  finally {
    seriesPending.value = false
  }
}

const configData = ref<ConfigByOperation[] | null>(null)
const configPending = ref(true)
const configError = ref(false)

async function loadConfig() {
  configPending.value = true
  configError.value = false
  try {
    configData.value = (await dashboard.configByOperation()).items
  }
  catch {
    configError.value = true
  }
  finally {
    configPending.value = false
  }
}

const usersData = ref<TopUser[] | null>(null)
const usersPending = ref(true)
const usersError = ref(false)

async function loadUsers() {
  usersPending.value = true
  usersError.value = false
  try {
    usersData.value = (await dashboard.topUsers()).items
  }
  catch {
    usersError.value = true
  }
  finally {
    usersPending.value = false
  }
}

const recentData = ref<RecentConfigChange[] | null>(null)
const recentPending = ref(true)
const recentError = ref(false)

async function loadRecent() {
  recentPending.value = true
  recentError.value = false
  try {
    recentData.value = (await dashboard.recentConfigChanges()).items
  }
  catch {
    recentError.value = true
  }
  finally {
    recentPending.value = false
  }
}

// Fire all five in parallel; do not await them in sequence.
onMounted(() => {
  loadKpi()
  loadSeries()
  loadConfig()
  loadUsers()
  loadRecent()
})

// ---------------------------------------------------------------------------
// (1) KPI cards
// ---------------------------------------------------------------------------
// Total Activity — all-time count of every audit row; delta = this calendar
//   month vs the previous. Overall engagement/volume signal.
// Config Changes — all-time count of real device-policy mutations (ACL/ROUTE
//   ADD/DELETE); delta vs last month. The "real work" signal, separate from
//   read-only SHOW/LOGIN noise.
// Success Rate — SUCCESS/total × 100 all-time; delta in percentage points vs
//   last month. Operational health; higher is better (green up / red down).

/** Signed count label, e.g. "+3", "−2", "0". */
function deltaCount(n: number): string {
  if (n > 0) return `+${n}`
  if (n < 0) return `−${Math.abs(n)}`
  return '0'
}

// ---------------------------------------------------------------------------
// (2) Activity Over Time — toggle between pre-fetched series (no refetch)
// ---------------------------------------------------------------------------
type Granularity = 'daily' | 'weekly' | 'monthly'
const granularity = ref<Granularity>('daily')
const granularityOptions: { label: string, value: Granularity }[] = [
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Monthly', value: 'monthly' },
]

const activeSeries = computed<SeriesPoint[]>(() => {
  const s = seriesData.value
  if (!s) return []
  if (granularity.value === 'weekly') return s.weekly
  if (granularity.value === 'monthly') return s.monthly
  return s.daily
})

/** Readable x-axis label from a bucket key for the active granularity. */
function seriesLabel(bucket: string): string {
  if (granularity.value === 'daily') {
    // 'YYYY-MM-DD' -> 'Oct 1'
    const d = new Date(`${bucket}T00:00:00`)
    return Number.isNaN(d.getTime())
      ? bucket
      : d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })
  }
  if (granularity.value === 'weekly') {
    // 'IYYY-WIW' -> 'W40'
    const match = bucket.match(/W(\d+)/)
    return match ? `W${match[1]}` : bucket
  }
  // monthly: 'YYYY-MM' -> 'Oct 2026'
  const d = new Date(`${bucket}-01T00:00:00`)
  return Number.isNaN(d.getTime())
    ? bucket
    : d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
}

// Chart rows for nuxt-charts <BarChart>: one object per bucket with the readable
// label and the count. The x-axis formatter receives the row INDEX and returns
// the label (per the library's xFormatter(i) contract).
const seriesChartData = computed(() =>
  activeSeries.value.map(p => ({ label: seriesLabel(p.bucket), count: p.count })),
)
const seriesCategories = { count: { name: 'Activity', color: '#1a57ab' } }
const seriesXFormatter = (i: number): string => seriesChartData.value[i]?.label ?? ''

// ---------------------------------------------------------------------------
// (3) Config Changes by Operation — bar chart over the fixed four operations
// ---------------------------------------------------------------------------
const configChartData = computed(() =>
  (configData.value ?? []).map(o => ({ operation: o.operation, count: o.count })),
)
const configCategories = { count: { name: 'Config changes', color: '#1a57ab' } }
const configXFormatter = (i: number): string => configChartData.value[i]?.operation ?? ''

// ---------------------------------------------------------------------------
// (5) Recent Config Changes — readable local timestamp (matches Log Trail)
// ---------------------------------------------------------------------------
function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-GB')
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <PageHeader title="Dashboard" description="Activity and configuration overview." />

    <!-- (1) KPI row — three minimal cards, no icons -->
    <div>
      <LoadingState v-if="kpiPending" message="Loading KPIs…" />

      <ErrorState
        v-else-if="kpiError"
        message="Could not load the KPIs."
        @retry="loadKpi"
      />

      <div v-else-if="kpiData" class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <!-- Total Activity -->
        <div class="rounded-lg border border-line bg-panel p-5">
          <p class="text-xs text-muted">Total Activity</p>
          <p class="mt-1 text-[28px] font-semibold leading-none text-ink">
            {{ kpiData.totalActivity.value }}
          </p>
          <p class="mt-1 text-[11px] text-muted">
            {{ deltaCount(kpiData.totalActivity.delta) }} vs last month
          </p>
        </div>

        <!-- Config Changes -->
        <div class="rounded-lg border border-line bg-panel p-5">
          <p class="text-xs text-muted">Config Changes</p>
          <p class="mt-1 text-[28px] font-semibold leading-none text-ink">
            {{ kpiData.configChanges.value }}
          </p>
          <p class="mt-1 text-[11px] text-muted">
            {{ deltaCount(kpiData.configChanges.delta) }} vs last month
          </p>
        </div>

        <!-- Success Rate — higher is better -->
        <div class="rounded-lg border border-line bg-panel p-5">
          <p class="text-xs text-muted">Success Rate</p>
          <p class="mt-1 text-[28px] font-semibold leading-none text-ink">
            {{ kpiData.successRate.value }}%
          </p>
          <p
            class="mt-1 text-[11px]"
            :class="kpiData.successRate.delta >= 0 ? 'text-ok' : 'text-bad'"
          >
            {{ kpiData.successRate.delta >= 0 ? '▲' : '▼' }}
            {{ Math.abs(kpiData.successRate.delta) }}pp vs last month
          </p>
        </div>
      </div>
    </div>

    <!-- (2) Activity Over Time -->
    <div class="rounded-lg border border-line bg-panel">
      <div class="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
        <h2 class="text-[17px] font-semibold text-ink">Activity Over Time</h2>
        <div class="inline-flex overflow-hidden rounded-md ring-1 ring-line">
          <button
            v-for="opt in granularityOptions"
            :key="opt.value"
            type="button"
            class="px-3 py-1.5 text-xs font-medium transition-colors"
            :class="granularity === opt.value
              ? 'bg-brand text-white'
              : 'bg-surface text-muted hover:text-ink'"
            @click="granularity = opt.value"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>

      <div class="p-5">
        <LoadingState v-if="seriesPending" message="Loading activity…" />

        <ErrorState
          v-else-if="seriesError"
          message="Could not load activity over time."
          @retry="loadSeries"
        />

        <EmptyState
          v-else-if="activeSeries.length === 0"
          title="No activity in this range"
          description="Activity will appear here once operations are recorded."
          icon="i-lucide-chart-column"
        />

        <!-- Unovis-based charts render in the browser only; wrap in ClientOnly
             so SSR doesn't try to render them. -->
        <ClientOnly v-else>
          <template #fallback>
            <LoadingState message="Rendering chart…" />
          </template>
          <BarChart
            :data="seriesChartData"
            :categories="seriesCategories"
            :y-axis="['count']"
            :height="260"
            :x-formatter="seriesXFormatter"
            :radius="4"
          />
        </ClientOnly>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <!-- (3) Config Changes by Operation -->
      <div class="rounded-lg border border-line bg-panel">
        <div class="border-b border-line px-5 py-4">
          <h2 class="text-[17px] font-semibold text-ink">Config Changes by Operation</h2>
        </div>

        <div class="p-5">
          <LoadingState v-if="configPending" message="Loading operations…" />

          <ErrorState
            v-else-if="configError"
            message="Could not load config changes by operation."
            @retry="loadConfig"
          />

          <EmptyState
            v-else-if="configChartData.length === 0"
            title="No config changes"
            description="ACL and route operations will be summarized here."
            icon="i-lucide-chart-column"
          />

          <ClientOnly v-else>
            <template #fallback>
              <LoadingState message="Rendering chart…" />
            </template>
            <BarChart
              :data="configChartData"
              :categories="configCategories"
              :y-axis="['count']"
              :height="260"
              :x-formatter="configXFormatter"
              :radius="4"
            />
          </ClientOnly>
        </div>
      </div>

      <!-- (4) Top Active Users -->
      <div class="rounded-lg border border-line bg-panel">
        <div class="border-b border-line px-5 py-4">
          <h2 class="text-[17px] font-semibold text-ink">Top Active Users</h2>
        </div>

        <div v-if="usersPending" class="p-5">
          <LoadingState message="Loading users…" />
        </div>

        <div v-else-if="usersError" class="p-5">
          <ErrorState
            message="Could not load top active users."
            @retry="loadUsers"
          />
        </div>

        <EmptyState
          v-else-if="(usersData ?? []).length === 0"
          title="No activity yet"
          description="The most active users will be ranked here."
          icon="i-lucide-users"
        />

        <ul v-else class="divide-y divide-line">
          <li
            v-for="(user, index) in usersData ?? []"
            :key="`${user.username}-${index}`"
            class="flex items-center justify-between gap-4 px-5 py-3"
          >
            <div class="flex min-w-0 items-center gap-3">
              <span class="shrink-0 text-xs text-muted">#{{ index + 1 }}</span>
              <span class="truncate text-sm font-medium text-ink">{{ user.username }}</span>
            </div>
            <span class="shrink-0 text-sm text-muted">{{ user.count }}</span>
          </li>
        </ul>
      </div>
    </div>

    <!-- (5) Recent Config Changes -->
    <div class="rounded-lg border border-line bg-panel">
      <div class="border-b border-line px-5 py-4">
        <h2 class="text-[17px] font-semibold text-ink">Recent Config Changes</h2>
      </div>

      <div v-if="recentPending" class="p-5">
        <LoadingState message="Loading recent changes…" />
      </div>

      <div v-else-if="recentError" class="p-5">
        <ErrorState
          message="Could not load recent config changes."
          @retry="loadRecent"
        />
      </div>

      <EmptyState
        v-else-if="(recentData ?? []).length === 0"
        title="No config changes"
        description="ACL and route additions or deletions will appear here."
        icon="i-lucide-history"
      />

      <ul v-else class="divide-y divide-line">
        <li
          v-for="change in recentData ?? []"
          :key="change.id"
          class="flex items-center justify-between gap-4 px-5 py-3"
        >
          <div class="min-w-0">
            <p class="truncate text-sm font-medium text-ink">
              {{ change.module }} / {{ change.action }}
            </p>
            <p class="mt-0.5 truncate text-xs text-muted">
              {{ change.username ?? '—' }}
              <span aria-hidden="true">·</span>
              {{ formatTime(change.createdAt) }}
            </p>
          </div>
          <span
            class="shrink-0 text-xs font-semibold"
            :class="change.status === 'SUCCESS' ? 'text-ok' : 'text-bad'"
          >
            {{ change.status === 'SUCCESS' ? 'Success' : 'Failed' }}
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>
