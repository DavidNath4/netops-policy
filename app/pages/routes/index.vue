<script setup lang="ts">
// Route search page. Search-only: enter an IP, hit Search, results come live
// from n8n. Device credentials set once per session via a pop-up; the server
// auto-fills them. Requirements: 6.1, 6.2, 13.1–13.4; n8n 11.
import type { OperationResult } from '#shared/schemas/n8n.schema'

definePageMeta({ middleware: 'permission', permission: 'ROUTES_SHOW' })

const api = useApi()
const { can } = usePermissions()
const canAdd = computed(() => can('ROUTES_ADD'))

const { isSet, status, ensureLoaded, clear } = useDeviceCredentials()
const credModalOpen = ref(false)

const search = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
const result = ref<OperationResult | null>(null)
const searched = ref(false)

onMounted(ensureLoaded)

// Structured route rows from n8n (route/show returns { data: [...] }).
interface RouteRow {
  raw?: string
  interface?: string
  destination?: string
  mask?: string
  gateway?: string
  // metric?: number
}

const items = computed<RouteRow[]>(() => (result.value?.items as RouteRow[] | null) ?? [])
const hasItems = computed(() => items.value.length > 0)

// Selected row → its raw command (shown in a RawCommandBox above the table).
const selectedIndex = ref<number | null>(null)
const selectedRaw = computed(() => {
  if (selectedIndex.value === null) return null
  return items.value[selectedIndex.value]?.raw ?? null
})

function selectRow(i: number) {
  selectedIndex.value = selectedIndex.value === i ? null : i
}

const tableColumns = [
  { key: 'interface', label: 'Interface', width: '1.2fr' },
  { key: 'destination', label: 'Destination', width: '1.4fr' },
  { key: 'mask', label: 'Mask', width: '1.3fr' },
  { key: 'gateway', label: 'Gateway', width: '1.3fr' },
  // { key: 'metric', label: 'Metric', width: '0.7fr' },
]

watch(result, () => {
  selectedIndex.value = null
})

async function runSearch() {
  error.value = null
  const value = search.value.trim()
  if (!value) {
    error.value = 'Enter an IP address to search.'
    return
  }
  if (!isSet.value) {
    credModalOpen.value = true
    return
  }

  loading.value = true
  searched.value = true
  try {
    result.value = await api.routeOps.show(value)
  }
  catch (e) {
    const code = (e as { data?: { error?: { code?: string } } })?.data?.error?.code
    if (code === 'DEVICE_CREDENTIALS_REQUIRED') {
      await ensureLoaded()
      credModalOpen.value = true
      result.value = null
    }
    else {
      const msg = (e as { data?: { error?: { message?: string } } })?.data?.error?.message
      error.value = msg ?? (e instanceof Error ? e.message : 'Search failed.')
    }
  }
  finally {
    loading.value = false
  }
}

function onCredsSaved() {
  void runSearch()
}

async function onClearCreds() {
  await clear()
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <PageHeader title="Routes" description="Search routes live from the device.">
      <template #actions>
        <NuxtLink
          v-if="canAdd"
          to="/routes/add"
          class="inline-flex h-[38px] items-center gap-1.5 rounded-md bg-brand px-4 text-xs font-semibold text-white transition-colors hover:opacity-90"
        >
          <UIcon name="i-lucide-plus" class="size-4" />
          Add Route
        </NuxtLink>
      </template>
    </PageHeader>

    <div class="flex items-center justify-between gap-3 rounded-lg border border-line bg-panel px-4 py-2.5 text-xs">
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-key-round" class="size-4" :class="isSet ? 'text-ok' : 'text-muted'" />
        <span v-if="isSet" class="text-ink">
          Device credentials set<span v-if="status.username" class="text-muted"> ({{ status.username }})</span>
        </span>
        <span v-else class="text-muted">No device credentials set for this session</span>
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="rounded-[5px] border border-line px-3 py-1 font-semibold text-ink transition-colors hover:bg-surface"
          @click="credModalOpen = true"
        >
          {{ isSet ? 'Update' : 'Set credentials' }}
        </button>
        <button
          v-if="isSet"
          type="button"
          class="rounded-[5px] border border-line px-3 py-1 font-semibold text-bad transition-colors hover:bg-surface"
          @click="onClearCreds"
        >
          Clear
        </button>
      </div>
    </div>

    <form
      class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4 sm:flex-row sm:items-end"
      @submit.prevent="runSearch"
    >
      <div class="flex flex-col gap-1.5 sm:flex-1">
        <label for="route-search" class="text-[11px] font-semibold text-muted">Search by IP address</label>
        <input
          id="route-search"
          v-model="search"
          type="text"
          placeholder="e.g. 10.200.200.0"
          class="h-7 rounded-[5px] border border-line bg-panel px-2.5 text-xs text-ink outline-none focus:border-brand"
        >
      </div>
      <button
        type="submit"
        :disabled="loading"
        class="inline-flex h-7 items-center gap-1.5 rounded-[5px] bg-brand px-4 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-60"
      >
        <UIcon :name="loading ? 'i-lucide-loader-circle' : 'i-lucide-search'" class="size-3.5" :class="{ 'animate-spin': loading }" />
        Search
      </button>
    </form>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      :description="error"
    />

    <LoadingState v-if="loading" message="Searching…" />

    <section v-else-if="result && result.status === 'FAILED'" class="flex flex-col gap-3">
      <div class="rounded-lg bg-terminal p-4 font-mono text-xs leading-relaxed">
        <p class="text-bad">✗ Search failed</p>
        <pre class="mt-1 whitespace-pre-wrap break-all text-bad">{{ result.error ?? result.message ?? 'Unknown error' }}</pre>
      </div>
    </section>

    <EmptyState
      v-else-if="searched && result && !hasItems && !result.output"
      icon="i-lucide-route-off"
      title="No results"
      :description="result.message ?? 'No routes matched that IP address.'"
    />

    <!-- Structured rows -->
    <section v-else-if="result && hasItems" class="flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <h2 class="text-base font-semibold text-ink">Search Result</h2>
        <span class="text-xs text-muted">{{ result.total ?? items.length }} found</span>
      </div>

      

      <ScrollableResultTable
        :columns="tableColumns"
        :rows="items"
        :selected="selectedIndex"
        @select="selectRow"
      >
        <template #cell="{ row }">
          <span class="truncate">{{ (row as RouteRow).interface ?? '—' }}</span>
          <span class="truncate">{{ (row as RouteRow).destination ?? '—' }}</span>
          <span class="truncate">{{ (row as RouteRow).mask ?? '—' }}</span>
          <span class="truncate">{{ (row as RouteRow).gateway ?? '—' }}</span>
          <!-- <span class="truncate">{{ (row as RouteRow).metric ?? '—' }}</span> -->
        </template>
      </ScrollableResultTable>

      <RawCommandBox :command="selectedRaw" />
    </section>

    <section v-else-if="result && result.output" class="flex flex-col gap-3">
      <h2 class="text-base font-semibold text-ink">Search Result</h2>
      <div class="rounded-lg bg-terminal p-4 font-mono text-xs leading-relaxed">
        <pre class="whitespace-pre-wrap break-all text-terminal-text">{{ result.output }}</pre>
      </div>
    </section>

    <EmptyState
      v-else
      icon="i-lucide-search"
      title="Search routes"
      description="Enter an IP address above to look up routes on the device."
    />

    <DeviceCredentialsModal v-model="credModalOpen" @saved="onCredsSaved" />
  </div>
</template>
