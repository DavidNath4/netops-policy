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
const totalConfigChanges = computed(() =>
  (configData.value ?? []).reduce((sum, item) => sum + item.count, 0),
)

const topOperation = computed(() => {
  const items = configData.value ?? []

  if (items.length === 0)
    return null

  return items.reduce((highest, current) =>
    current.count > highest.count ? current : highest,
  )
})
</script>

<template>
  <div
    class="
      flex h-full flex-col overflow-hidden
      rounded-xl border border-line bg-panel
    "
  >
    <!-- Header -->
    <div
      class="
        flex shrink-0 items-center justify-between
        gap-4 border-b border-line
        px-5 py-4
      "
    >
      <div>
        <h2 class="text-[15px] font-semibold text-ink">
          Config Changes by Operation
        </h2>

        <p class="mt-0.5 text-[11px] text-muted">
          Distribution of ACL and route configuration changes.
        </p>
      </div>

      
    </div>

    <!-- Content -->
    <div class="flex flex-1 flex-col p-4">
      <LoadingState
        v-if="configPending"
        message="Loading operations…"
      />

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

      <template v-else>
        <!-- Compact insights -->
        <div class="mb-4 grid grid-cols-2 gap-3">
          <!-- Total changes -->
          <div
            class="
              flex items-center gap-3
              rounded-lg border border-line
              bg-surface/40 px-3 py-2.5
            "
          >
            <div
              class="
                flex h-8 w-8 shrink-0
                items-center justify-center
                rounded-lg bg-brand/10
                text-brand
              "
            >
              <UIcon
                name="i-lucide-git-commit-horizontal"
                class="h-4 w-4"
              />
            </div>

            <div>
              <p
                class="
                  text-[9px] font-medium uppercase
                  tracking-wide text-muted
                "
              >
                Changes
              </p>

              <p class="mt-0.5 text-sm font-semibold text-ink">
                {{ totalConfigChanges }}
                <span class="font-normal text-muted">
                  total
                </span>
              </p>
            </div>
          </div>

          <!-- Most frequent -->
          <div
            class="
              flex items-center gap-3
              rounded-lg border border-line
              bg-surface/40 px-3 py-2.5
            "
          >
            <div
              class="
                flex h-8 w-8 shrink-0
                items-center justify-center
                rounded-lg bg-surface
                text-muted
              "
            >
              <UIcon
                name="i-lucide-trending-up"
                class="h-4 w-4"
              />
            </div>

            <div class="min-w-0">
              <p
                class="
                  text-[9px] font-medium uppercase
                  tracking-wide text-muted
                "
              >
                Most Frequent
              </p>

              <p class="mt-0.5 truncate text-sm font-semibold text-ink">
                {{ topOperation?.operation ?? '—' }}

                <span class="font-normal text-muted">
                  · {{ topOperation?.count ?? 0 }}
                </span>
              </p>
            </div>
          </div>
        </div>

        <!-- Chart -->
        <div
          class="
            flex flex-1 flex-col
            rounded-xl border border-line
            bg-surface/25
            px-3 pb-2 pt-3
          "
        >
          <div class="mb-1 flex items-center justify-between px-1">
            <div>
              <p class="text-xs font-medium text-ink">
                Operation distribution
              </p>

              <p class="mt-0.5 text-[10px] text-muted">
                Number of configuration changes by operation.
              </p>
            </div>

            <span
              class="
                rounded-full bg-panel
                px-2 py-1
                text-[10px] font-medium text-muted
                ring-1 ring-line
              "
            >
              4 operations
            </span>
          </div>

          <div class="flex flex-1 items-center">
            <ClientOnly>
              <template #fallback>
                <LoadingState message="Rendering chart…" />
              </template>

              <div class="w-full">
                <BarChart
                  :data="configChartData"
                  :categories="configCategories"
                  :y-axis="['count']"
                  :height="230"
                  :x-formatter="configXFormatter"
                  :radius="7"
                />
              </div>
            </ClientOnly>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
