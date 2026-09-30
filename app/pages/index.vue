<script setup lang="ts">
// Dashboard (default layout). Activity/execution summary derived from audit_logs
// (this app is the audit system of record, not the source of truth for ACL/route
// counts). Shows execution totals, success/failed, per-module activity, and
// recent activity. Requirements: 9.1–9.7.
import type { AuditResponse } from '#shared/schemas/audit.schema'

interface DashboardSummary {
  totalExecutions: number
  successCount: number
  failedCount: number
  perModule: { module: string, count: number }[]
  recentActivities: AuditResponse[]
  failedRecent: AuditResponse[]
}

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
  tone?: 'ok' | 'bad'
}

const stats = computed<StatCard[]>(() => {
  const s = summary.value
  if (!s) return []
  return [
    { label: 'Total Executions', value: s.totalExecutions, icon: 'i-lucide-activity' },
    { label: 'Successful', value: s.successCount, icon: 'i-lucide-circle-check', tone: 'ok' },
    { label: 'Failed', value: s.failedCount, icon: 'i-lucide-circle-x', tone: 'bad' },
    { label: 'ACL / Route Activity', value: aclRouteCount.value, icon: 'i-lucide-route' },
  ]
})

const aclRouteCount = computed(() => {
  const per = summary.value?.perModule ?? []
  return per
    .filter(p => p.module === 'ACL' || p.module === 'ROUTE')
    .reduce((sum, p) => sum + p.count, 0)
})

const activities = computed<AuditResponse[]>(() => summary.value?.recentActivities ?? [])

function formatTimestamp(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString()
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <PageHeader title="Dashboard" description="Activity and execution overview." />

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
            <p
              class="mt-1 text-[26px] font-semibold leading-none"
              :class="stat.tone === 'ok' ? 'text-ok' : stat.tone === 'bad' ? 'text-bad' : 'text-ink'"
            >
              {{ stat.value }}
            </p>
          </div>
          <UIcon
            :name="stat.icon"
            class="size-7 shrink-0"
            :class="stat.tone === 'ok' ? 'text-ok' : stat.tone === 'bad' ? 'text-bad' : 'text-brand'"
          />
        </div>
      </div>

      <!-- Per-module activity -->
      <div v-if="summary.perModule.length" class="rounded-lg border border-line bg-panel">
        <div class="border-b border-line px-5 py-4">
          <h2 class="text-[17px] font-semibold text-ink">Activity by Module</h2>
        </div>
        <ul class="divide-y divide-line">
          <li
            v-for="m in summary.perModule"
            :key="m.module"
            class="flex items-center justify-between px-5 py-3 text-sm"
          >
            <span class="font-medium text-ink">{{ m.module }}</span>
            <span class="text-muted">{{ m.count }}</span>
          </li>
        </ul>
      </div>

      <!-- Recent activities -->
      <div class="rounded-lg border border-line bg-panel">
        <div class="border-b border-line px-5 py-4">
          <h2 class="text-[17px] font-semibold text-ink">Recent Activities</h2>
        </div>

        <EmptyState
          v-if="activities.length === 0"
          title="No recent activity"
          description="Activity from ACL and route operations will appear here."
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
                {{ activity.module }} / {{ activity.action }}
              </p>
              <p class="mt-0.5 truncate text-xs text-muted">
                {{ activity.username ?? 'system' }}
                <span aria-hidden="true">·</span>
                {{ formatTimestamp(activity.createdAt) }}
              </p>
            </div>
            <span
              class="shrink-0 text-xs font-semibold"
              :class="activity.status === 'SUCCESS' ? 'text-ok' : 'text-bad'"
            >
              {{ activity.status === 'SUCCESS' ? 'Success' : 'Failed' }}
            </span>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
