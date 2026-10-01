<script setup lang="ts">
// (2) Activity Over Time — bar chart with a Daily/Weekly/Monthly toggle.
// The toggle switches a pre-fetched series client-side (no refetch).

interface SeriesPoint {
  bucket: string
  count: number
}
interface ActivitySeries {
  daily: SeriesPoint[]
  weekly: SeriesPoint[]
  monthly: SeriesPoint[]
}

const { dashboard } = useApi()

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

onMounted(() => loadSeries())

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
const seriesCategories = { count: { name: 'Activity', color: '#2563eb' } }
const seriesXFormatter = (i: number): string => seriesChartData.value[i]?.label ?? ''

// Compact insights for the Activity Over Time widget. Deliberately NOT total:
// total is already the top KPI. The series is zero-filled (every bucket in the
// window is present), so "recorded periods" counts only buckets with count > 0
// — the number of periods that actually have activity.
const activitySummary = computed(() => {
  const rows = activeSeries.value
  // The series is now zero-filled (every bucket in the window is present), so
  // "recorded periods" must count only buckets that actually have activity —
  // NOT rows.length (which is always the full window, e.g. 12 months).
  const active = rows.filter(r => r.count > 0)
  if (active.length === 0) {
    return { peak: 0, peakLabel: '—', recordedPeriods: 0 }
  }
  const peakPoint = active.reduce((highest, current) =>
    current.count > highest.count ? current : highest,
  )
  return {
    peak: peakPoint.count,
    peakLabel: seriesLabel(peakPoint.bucket),
    recordedPeriods: active.length,
  }
})

// Human-readable window label for the active granularity.
const activityPeriodLabel = computed(() => {
  switch (granularity.value) {
    case 'weekly':
      return 'Last 12 weeks'
    case 'monthly':
      return 'Last 12 months'
    default:
      return 'Last 14 days'
  }
})

// Unit label for "recorded periods" (singular/plural, per granularity).
const activityPeriodUnit = computed(() => {
  const one = activitySummary.value.recordedPeriods === 1
  switch (granularity.value) {
    case 'weekly':
      return one ? 'active week' : 'active weeks'
    case 'monthly':
      return one ? 'active month' : 'active months'
    default:
      return one ? 'active day' : 'active days'
  }
})
</script>

<template>
  <section class="overflow-hidden rounded-2xl border border-line bg-panel shadow-sm">
    <!-- Header -->
    <div
      class="flex flex-col gap-4 border-b border-line px-5 py-5 sm:flex-row sm:items-center sm:justify-between lg:px-6"
    >
      <!-- Title -->
      <div class="flex items-center gap-3">
        <div
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand"
        >
          <UIcon name="i-lucide-chart-no-axes-combined" class="h-5 w-5" />
        </div>

        <div>
          <div class="flex items-center gap-2">
            <h2 class="text-base font-semibold text-ink sm:text-[17px]">
              Activity Over Time
            </h2>

            <span
              class="hidden rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium text-muted sm:inline-flex"
            >
              {{ activityPeriodLabel }}
            </span>
          </div>

          <p class="mt-0.5 text-xs text-muted">
            Activity trend across the selected time window.
          </p>
        </div>
      </div>

      <!-- Granularity Toggle -->
      <div
        class="inline-flex self-start rounded-xl border border-line bg-surface p-1 sm:self-auto"
      >
        <button
          v-for="opt in granularityOptions"
          :key="opt.value"
          type="button"
          class="relative rounded-lg px-3.5 py-1.5 text-xs font-medium transition-all duration-200"
          :class="granularity === opt.value
            ? 'bg-panel text-ink shadow-sm ring-1 ring-line'
            : 'text-muted hover:text-ink'"
          @click="granularity = opt.value"
        >
          {{ opt.label }}
        </button>
      </div>
    </div>

    <!-- Content -->
    <div class="p-5 lg:p-6">
      <LoadingState v-if="seriesPending" message="Loading activity…" />

      <ErrorState
        v-else-if="seriesError"
        message="Could not load activity over time."
        @retry="loadSeries"
      />

      <EmptyState
        v-else-if="activitySummary.recordedPeriods === 0"
        title="No activity in this range"
        description="Activity will appear here once operations are recorded."
        icon="i-lucide-chart-column"
      />

      <template v-else>
        <!-- Compact insights (Peak / Recorded Periods / Window). No Total: it is
             the top KPI. Recorded Periods counts only buckets with activity. -->
        <div class="mb-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
          <!-- Peak -->
          <div class="flex items-center gap-3">
            <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
              <UIcon name="i-lucide-trending-up" class="h-4 w-4" />
            </div>
            <div>
              <p class="text-[10px] font-medium uppercase tracking-wide text-muted">Peak</p>
              <p class="mt-0.5 text-sm font-semibold text-ink">
                {{ activitySummary.peak.toLocaleString() }}
                <span class="font-normal text-muted">· {{ activitySummary.peakLabel }}</span>
              </p>
            </div>
          </div>

          <div class="hidden h-9 w-px bg-line sm:block" />

          <!-- Recorded periods -->
          <div class="flex items-center gap-3">
            <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-muted">
              <UIcon name="i-lucide-chart-column" class="h-4 w-4" />
            </div>
            <div>
              <p class="text-[10px] font-medium uppercase tracking-wide text-muted">Recorded Periods</p>
              <p class="mt-0.5 text-sm font-semibold text-ink">
                {{ activitySummary.recordedPeriods }}
                <span class="font-normal text-muted">{{ activityPeriodUnit }}</span>
              </p>
            </div>
          </div>

          <div class="hidden h-9 w-px bg-line sm:block" />

          <!-- Window -->
          <div class="flex items-center gap-3">
            <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-muted">
              <UIcon name="i-lucide-calendar-range" class="h-4 w-4" />
            </div>
            <div>
              <p class="text-[10px] font-medium uppercase tracking-wide text-muted">Window</p>
              <p class="mt-0.5 text-sm font-semibold text-ink">
                {{ activityPeriodLabel }}
              </p>
            </div>
          </div>
        </div>

        <!-- Chart container (no custom legend — BarChart renders its own) -->
        <div
          class="relative overflow-hidden rounded-xl border border-line bg-surface/30 px-3 pb-3 pt-5 sm:px-5"
        >
          <div class="mb-2 px-1">
            <p class="text-xs font-medium text-ink">Activity volume</p>
            <p class="mt-0.5 text-[11px] text-muted">
              Activity recorded during the selected window.
            </p>
          </div>

          <!-- Chart (Unovis renders in the browser only; ClientOnly avoids SSR).
               `:key="granularity"` forces a clean remount when the toggle
               changes, so Unovis' internal hover/tooltip state can't carry
               over and pop a stale tooltip on the new bars. -->
          <ClientOnly>
            <template #fallback>
              <LoadingState message="Rendering chart…" />
            </template>
            <BarChart
              :key="granularity"
              :data="seriesChartData"
              :categories="seriesCategories"
              :y-axis="['count']"
              :height="280"
              :x-formatter="seriesXFormatter"
              :radius="7"
            />
          </ClientOnly>
        </div>
      </template>
    </div>
  </section>
</template>
