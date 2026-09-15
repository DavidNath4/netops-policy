<script setup lang="ts">
// Routes list page (mock data via useApi()). Wired to live /api/routes/* in
// task 13.2. Shows every route in a searchable, paginated table with loading /
// empty / error states.
// _Requirements: 6.1, 6.2, 13.1, 13.2, 13.3, 13.4_
import type { Paginated, RouteResponse } from '~/utils/api-types'

definePageMeta({ middleware: 'permission', permission: 'ROUTES_SHOW' })

const api = useApi()
const { can } = usePermissions()
const canAdd = computed(() => can('ROUTES_ADD'))

const ITEMS_PER_PAGE = 20

const search = ref('')
const page = ref(1)

const loading = ref(false)
const error = ref<string | null>(null)
const result = ref<Paginated<RouteResponse> | null>(null)
const lastRefreshed = ref<Date | null>(null)

const rows = computed(() => result.value?.items ?? [])
const total = computed(() => result.value?.total ?? 0)

async function load() {
  loading.value = true
  error.value = null
  try {
    result.value = await api.routes.list({
      page: page.value,
      limit: ITEMS_PER_PAGE,
      search: search.value.trim() || undefined,
    })
    lastRefreshed.value = new Date()
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load routes.'
  }
  finally {
    loading.value = false
  }
}

function applySearch() {
  page.value = 1
  void load()
}

watch(page, () => {
  void load()
})

/** Combine start/end into a single readable range, or an em-dash when unset. */
function formatTime(row: RouteResponse): string {
  if (row.timeStart && row.timeEnd) return `${row.timeStart}–${row.timeEnd}`
  return row.timeStart ?? row.timeEnd ?? '—'
}

function statusLabel(status: string): string {
  if (status === 'ACTIVE') return 'Active'
  if (status === 'DISABLED') return 'Disabled'
  return 'Draft'
}

const lastRefreshedLabel = computed(() =>
  lastRefreshed.value ? lastRefreshed.value.toLocaleTimeString() : '—',
)

onMounted(load)
</script>

<template>
  <div class="flex flex-col gap-6">
    <PageHeader title="Routes" description="Manage static routes and their next hops.">
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

    <!-- Search / refresh bar -->
    <form
      class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4 sm:flex-row sm:items-end"
      @submit.prevent="applySearch"
    >
      <div class="flex flex-col gap-1.5 sm:flex-1">
        <label for="route-search" class="text-[11px] font-semibold text-muted">
          Search / Filter
        </label>
        <input
          id="route-search"
          v-model="search"
          type="text"
          placeholder="Route / Source / Destination / Next Hop"
          class="h-7 rounded-[5px] border border-line bg-panel px-2.5 text-xs text-ink outline-none focus:border-brand"
        >
      </div>
      <button
        type="submit"
        class="h-7 rounded-[5px] border border-line bg-panel px-4 text-xs font-semibold text-ink transition-colors hover:bg-surface"
      >
        Apply
      </button>
      <button
        type="button"
        class="inline-flex h-7 items-center gap-1.5 rounded-[5px] border border-line bg-panel px-4 text-xs font-semibold text-ink transition-colors hover:bg-surface"
        @click="load"
      >
        <UIcon
          name="i-lucide-refresh-cw"
          class="size-3.5"
          :class="{ 'animate-spin': loading }"
        />
        Refresh
      </button>
    </form>

    <ErrorState v-if="error" :message="error" @retry="load" />

    <LoadingState v-else-if="loading && rows.length === 0" message="Loading routes…" />

    <EmptyState
      v-else-if="!loading && rows.length === 0"
      icon="i-lucide-route"
      title="No routes found"
      :description="search ? 'Try adjusting your search.' : 'Get started by adding your first route.'"
    >
      <template v-if="canAdd" #action>
        <NuxtLink
          to="/routes/add"
          class="inline-flex h-[38px] items-center gap-1.5 rounded-md bg-brand px-4 text-xs font-semibold text-white transition-colors hover:opacity-90"
        >
          <UIcon name="i-lucide-plus" class="size-4" />
          Add Route
        </NuxtLink>
      </template>
    </EmptyState>

    <template v-else>
      <!-- Table: header labels + spaced white bordered row cards -->
      <div class="flex flex-col gap-2">
        <div
          class="grid grid-cols-[1.2fr_1.2fr_1.2fr_1fr_1fr_1.1fr_1fr_0.9fr] gap-3 px-4 text-[11px] font-semibold text-muted"
        >
          <span>Route</span>
          <span>Source</span>
          <span>Destination</span>
          <span>Next Hop</span>
          <span>Policy</span>
          <span>Time</span>
          <span>Ticket</span>
          <span>Status</span>
        </div>

        <div
          v-for="row in rows"
          :key="row.id"
          class="grid grid-cols-[1.2fr_1.2fr_1.2fr_1fr_1fr_1.1fr_1fr_0.9fr] items-center gap-3 rounded-[5px] border border-line bg-panel px-4 py-3 text-[11px] text-ink"
        >
          <span class="truncate">{{ row.name }}</span>
          <span class="truncate">{{ row.source ?? '—' }}</span>
          <span class="truncate">{{ row.destination }}</span>
          <span class="truncate">{{ row.nextHop }}</span>
          <span class="truncate">{{ row.policy ?? '—' }}</span>
          <span class="truncate">{{ formatTime(row) }}</span>
          <span class="truncate">{{ row.changeTicket ?? '—' }}</span>
          <span
            class="font-semibold"
            :class="row.status === 'ACTIVE' ? 'text-ok' : 'text-muted'"
          >
            {{ statusLabel(row.status) }}
          </span>
        </div>
      </div>

      <div class="flex items-center justify-between gap-3">
        <p class="text-[10px] text-muted">Last refreshed: {{ lastRefreshedLabel }}</p>
        <Pagination
          v-if="total > ITEMS_PER_PAGE"
          v-model:page="page"
          :total="total"
          :items-per-page="ITEMS_PER_PAGE"
        />
      </div>
    </template>
  </div>
</template>
