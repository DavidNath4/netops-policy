<script setup lang="ts">
// (3) Config Changes by Operation — bar chart over the fixed four config
// operations (ROUTE/ADD, ROUTE/DELETE, ACL/ADD, ACL/DELETE), zero-filled by the
// backend. Self-contained: owns its own fetch + loading/error/empty state.

interface ConfigByOperation {
  operation: string
  count: number
}

const { dashboard } = useApi()

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

onMounted(() => loadConfig())

// Chart rows for <BarChart>: one object per operation with its count.
const configChartData = computed(() =>
  (configData.value ?? []).map(o => ({ operation: o.operation, count: o.count })),
)
const configCategories = { count: { name: 'Config changes', color: '#1a57ab' } }
const configXFormatter = (i: number): string => configChartData.value[i]?.operation ?? ''
</script>

<template>
  <div class="rounded-lg border border-line bg-panel">
    <div class="border-b border-line px-5 py-3.5">
      <h2 class="text-[15px] font-semibold text-ink">Config Changes by Operation</h2>
    </div>

    <div class="p-4">
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
          :height="220"
          :x-formatter="configXFormatter"
          :radius="4"
        />
      </ClientOnly>
    </div>
  </div>
</template>
