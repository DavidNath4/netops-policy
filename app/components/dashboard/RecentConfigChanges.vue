<script setup lang="ts">
// (5) Recent Config Changes — compact feed of newest config mutations with
// inline status. Readable local timestamp (matches Log Trail).

interface RecentConfigChange {
  id: string
  module: string
  action: string
  username: string | null
  status: string
  createdAt: string
}

const { dashboard } = useApi()

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

onMounted(() => loadRecent())

function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-GB')
}
</script>

<template>
  <div class="rounded-lg border border-line bg-panel">
    <div class="border-b border-line px-4 py-3">
      <h2 class="text-sm font-semibold text-ink">Recent Config Changes</h2>
    </div>

    <div v-if="recentPending" class="p-4">
      <LoadingState message="Loading recent changes…" />
    </div>

    <div v-else-if="recentError" class="p-4">
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
        class="flex items-center justify-between gap-3 px-4 py-2"
      >
        <div class="min-w-0">
          <p class="truncate text-[13px] font-medium text-ink">
            {{ change.module }} / {{ change.action }}
          </p>
          <p class="mt-0.5 truncate text-[11px] text-muted">
            {{ change.username ?? '—' }}
            <span aria-hidden="true">·</span>
            {{ formatTime(change.createdAt) }}
          </p>
        </div>
        <span
          class="shrink-0 text-[11px] font-semibold"
          :class="change.status === 'SUCCESS' ? 'text-ok' : 'text-bad'"
        >
          {{ change.status === 'SUCCESS' ? 'Success' : 'Failed' }}
        </span>
      </li>
    </ul>
  </div>
</template>
