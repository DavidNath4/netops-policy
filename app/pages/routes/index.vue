<script setup lang="ts">
// Routes page. Shows ALL routes from the device (route/show returns the full
// table), fetched on load. The search box filters the fetched rows client-side
// — it does not hit the API again. Device credentials are set once per session
// via a pop-up; the server auto-fills them. Requirements: 6.1, 6.2; n8n 11.
import type { OperationResult } from '#shared/schemas/n8n.schema'

definePageMeta({ middleware: 'permission', permission: 'ROUTES_SHOW' })

const api = useApi()
const { can } = usePermissions()
const canAdd = computed(() => can('ROUTES_ADD'))
const canDelete = computed(() => can('ROUTES_DELETE'))

const { isSet, status, ensureLoaded, clear } = useDeviceCredentials()
const credModalOpen = ref(false)

const search = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
const result = ref<OperationResult | null>(null)
const loaded = ref(false)

// Structured route rows from n8n (route/show returns { data: [...] }).
interface RouteRow {
  raw?: string
  interface?: string
  destination?: string
  mask?: string
  gateway?: string
  metric?: number
}

// All rows from the last fetch.
const allItems = computed<RouteRow[]>(() => (result.value?.items as RouteRow[] | null) ?? [])

// Client-side filter: match the typed text against destination / mask / gateway
// / raw. Empty search shows everything.
const items = computed<RouteRow[]>(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return allItems.value
  return allItems.value.filter((r) => {
    return [r.destination, r.mask, r.gateway, r.raw]
      .some(v => v?.toLowerCase().includes(q))
  })
})
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
  { key: 'destination', label: 'Destination', width: '1.4fr' },
  { key: 'mask', label: 'Mask', width: '1.3fr' },
  { key: 'gateway', label: 'Gateway', width: '1.3fr' },
]

// Reset the row selection whenever the filtered list changes.
watch(items, () => {
  selectedIndex.value = null
})

// Fetch the full route table. Gated on device credentials.
async function loadRoutes() {
  error.value = null
  if (!isSet.value) {
    credModalOpen.value = true
    return
  }

  loading.value = true
  try {
    // route/show is show-all: the server sends only { user, pass }; the search
    // arg is ignored by the contract but kept for the API signature.
    result.value = await api.routeOps.show('')
    loaded.value = true
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
      error.value = msg ?? (e instanceof Error ? e.message : 'Failed to load routes.')
    }
  }
  finally {
    loading.value = false
  }
}

// On load: make sure creds are known, then fetch all routes if we have them.
onMounted(async () => {
  await ensureLoaded()
  if (isSet.value) await loadRoutes()
})

// After saving credentials in the modal, load the routes.
function onCredsSaved() {
  void loadRoutes()
}

async function onClearCreds() {
  await clear()
  result.value = null
  loaded.value = false
}
</script>

<template>
  <div class="flex flex-col gap-6" style="zoom: 1.2">
    <PageHeader title="Routes" description="All routes on the device. Use search to filter the results.">
      <template #actions>
        <NuxtLink
          v-if="canAdd"
          to="/routes/add"
          class="inline-flex h-[38px] items-center gap-1.5 rounded-md bg-brand px-4 text-xs font-semibold text-white transition-colors hover:opacity-90"
        >
          <UIcon name="i-lucide-plus" class="size-4" />
          Add Route
        </NuxtLink>
        <NuxtLink
          v-if="canDelete"
          to="/routes/delete"
          class="inline-flex h-[38px] items-center gap-1.5 rounded-md border border-line bg-panel px-4 text-xs font-semibold text-bad transition-colors hover:bg-surface"
        >
          <UIcon name="i-lucide-trash-2" class="size-4" />
          Delete Route
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
          v-if="isSet"
          type="button"
          class="inline-flex items-center gap-1 rounded-[5px] border border-line px-3 py-1 font-semibold text-ink transition-colors hover:bg-surface"
          @click="loadRoutes"
        >
          <UIcon name="i-lucide-refresh-cw" class="size-3.5" />
          Refresh
        </button>
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

    <!-- Client-side filter of the fetched routes -->
    <div class="flex flex-col gap-1.5 rounded-lg border border-line bg-panel p-4">
      <label for="route-search" class="text-[11px] font-semibold text-muted">Filter results</label>
      <input
        id="route-search"
        v-model="search"
        type="text"
        placeholder="Filter by destination, mask, or gateway…"
        class="h-7 rounded-[5px] border border-line bg-panel px-2.5 text-xs text-ink outline-none focus:border-brand"
      >
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      :description="error"
    />

    <LoadingState v-if="loading" message="Loading routes…" />

    <!-- Failed fetch -->
    <section v-else-if="result && result.status === 'FAILED'" class="flex flex-col gap-3">
      <div class="rounded-lg bg-terminal p-4 font-mono text-xs leading-relaxed">
        <p class="text-bad">✗ Failed to load routes</p>
        <pre class="mt-1 whitespace-pre-wrap break-all text-bad">{{ result.error ?? result.message ?? 'Unknown error' }}</pre>
      </div>
    </section>

    <!-- Loaded, but the filter matched nothing (or the device returned none) -->
    <EmptyState
      v-else-if="loaded && !hasItems"
      icon="i-lucide-route-off"
      title="No routes"
      :description="search.trim() ? 'No routes match your filter.' : (result?.message ?? 'No routes found on the device.')"
    />

    <!-- Structured rows -->
    <section v-else-if="hasItems" class="flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <h2 class="text-base font-semibold text-ink">Routes</h2>
        <span class="text-xs text-muted">{{ items.length }} shown</span>
      </div>

      <ScrollableResultTable
        :columns="tableColumns"
        :rows="items"
        :selected="selectedIndex"
        @select="selectRow"
      >
        <template #cell="{ row }">
          <span class="truncate">{{ (row as RouteRow).destination ?? '—' }}</span>
          <span class="truncate">{{ (row as RouteRow).mask ?? '—' }}</span>
          <span class="truncate">{{ (row as RouteRow).gateway ?? '—' }}</span>
        </template>
      </ScrollableResultTable>

      <RawCommandBox :command="selectedRaw" />
    </section>

    <!-- Not loaded yet (no credentials) -->
    <EmptyState
      v-else
      icon="i-lucide-key-round"
      title="Set device credentials"
      description="Set your device credentials to load the route table."
    />

    <DeviceCredentialsModal v-model="credModalOpen" @saved="onCredsSaved" />
  </div>
</template>
