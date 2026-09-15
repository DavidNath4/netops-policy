<script setup lang="ts">
// Dashboard (default layout). Shows four stat cards derived from the mock
// dashboard summary plus a Recent Activities list, restyled to the Figma
// "Network ops app" design language (white panels, brand-blue icons,
// colored result text). Handles loading / empty / error states around the
// ~150ms mock fetch.
import type { AuditResponse, DashboardSummary } from '~/utils/api-types'

const { dashboard } = useApi()

const summary = ref<DashboardSummary | null>(null)
const pending = ref(true)
const error = ref(false)

async function load() {
  pending.value = true
  error.value = false
  try {
    summary.value = await dashboard.summary()
  }
  catch {
    error.value = true
  }
  finally {
    pending.value = false
  }
}

onMounted(load)

interface StatCard {
  label: string
  value: number
  icon: string
}

const stats = computed<StatCard[]>(() => {
  const s = summary.value
  if (!s) return []
  return [
    { label: 'Total ACL', value: s.aclTotal, icon: 'i-lucide-shield' },
    { label: 'Active ACL', value: s.aclActive, icon: 'i-lucide-shield-check' },
    { label: 'Total Routes', value: s.routeTotal, icon: 'i-lucide-route' },
    { label: 'Active Routes', value: s.routeActive, icon: 'i-lucide-route-off' },
  ]
})

const activities = computed<AuditResponse[]>(() => summary.value?.recentActivities ?? [])

function formatTimestamp(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString()
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <PageHeader title="Dashboard" description="Operational overview." />

    <LoadingState v-if="pending" message="Loading dashboard…" />

    <ErrorState
      v-else-if="error"
      message="Could not load the dashboard summary."
      @retry="load"
    />

    <template v-else-if="summary">
      <!-- Stat cards -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div
          v-for="stat in stats"
          :key="stat.label"
          class="flex items-center justify-between gap-4 rounded-lg border border-line bg-panel p-5"
        >
          <div class="min-w-0">
            <p class="text-xs text-muted">{{ stat.label }}</p>
            <p class="mt-1 text-[26px] font-semibold leading-none text-ink">{{ stat.value }}</p>
          </div>
          <UIcon :name="stat.icon" class="size-7 shrink-0 text-brand" />
        </div>
      </div>

      <!-- Recent activities -->
      <div class="rounded-lg border border-line bg-panel">
        <div class="border-b border-line px-5 py-4">
          <h2 class="text-[17px] font-semibold text-ink">Recent Activities</h2>
        </div>

        <EmptyState
          v-if="activities.length === 0"
          title="No recent activity"
          description="Activity from ACL and route changes will appear here."
          icon="i-lucide-history"
        />

        <ul v-else class="divide-y divide-line">
          <li
            v-for="activity in activities"
            :key="activity.id"
            class="flex items-center justify-between gap-4 px-5 py-3"
          >
            <div class="min-w-0">
              <p class="truncate text-sm font-medium text-ink">
                {{ activity.activity }}
              </p>
              <p class="mt-0.5 truncate text-xs text-muted">
                {{ activity.actorUsername ?? 'system' }}
                <span aria-hidden="true">·</span>
                {{ formatTimestamp(activity.timestamp) }}
              </p>
            </div>
            <span
              class="shrink-0 text-xs font-semibold"
              :class="activity.result === 'SUCCESS' ? 'text-ok' : 'text-bad'"
            >
              {{ activity.result === 'SUCCESS' ? 'Success' : 'Failure' }}
            </span>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
