<script setup lang="ts">
// ACL Policies list + inline ACL Detail / Command Result panel.
// Mock-data only via useApi(); real endpoints are wired in task 13.2.
// Requirements: 4.1, 4.2, 4.3, 4.11, 13.1, 13.2, 13.4
import type { AclResponse, ListParams, PolicyStatus } from '~/utils/api-types'

const api = useApi()

// Status filter options (Active/Disabled/Draft/All).
const statusOptions = [
  { label: 'Active', value: 'ACTIVE' },
  { label: 'Disabled', value: 'DISABLED' },
  { label: 'Draft', value: 'DRAFT' },
  { label: 'All', value: '' },
]

const ITEMS_PER_PAGE = 20

// Filter form state (applied to the query only when "Apply" is clicked).
const filters = reactive({
  search: '',
  status: 'ACTIVE' as '' | PolicyStatus,
})

const page = ref(1)
const rows = ref<AclResponse[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref<string | null>(null)
const lastRefreshed = ref<Date | null>(null)

const selected = ref<AclResponse | null>(null)

function formatTime(acl: AclResponse): string {
  if (acl.timeStart && acl.timeEnd) return `${acl.timeStart}–${acl.timeEnd}`
  if (acl.timeStart) return `From ${acl.timeStart}`
  if (acl.timeEnd) return `Until ${acl.timeEnd}`
  return '—'
}

const lastRefreshedLabel = computed(() =>
  lastRefreshed.value ? lastRefreshed.value.toLocaleTimeString() : '—',
)

// Green success line + the server-generated command, matching the Figma
// "Command Result" terminal box.
const commandOutput = computed(() => {
  if (!selected.value) return ''
  return selected.value.generatedCommand
})

async function load() {
  loading.value = true
  error.value = null
  try {
    const params: ListParams = {
      page: page.value,
      limit: ITEMS_PER_PAGE,
      search: filters.search.trim() || undefined,
      status: filters.status || undefined,
    }
    const result = await api.acl.list(params)
    rows.value = result.items
    total.value = result.total
    lastRefreshed.value = new Date()
    // Drop the detail selection if the selected row is no longer in the list.
    if (selected.value && !result.items.some(r => r.id === selected.value!.id)) {
      selected.value = null
    }
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load ACL policies.'
  }
  finally {
    loading.value = false
  }
}

function applyFilters() {
  page.value = 1
  void load()
}

function selectRow(row: AclResponse) {
  selected.value = selected.value?.id === row.id ? null : row
}

watch(page, () => {
  void load()
})

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <PageHeader
      title="ACL Policies"
      description="Review configured ACL policies and command output."
    >
      <template #actions>
        <NuxtLink
          to="/acl/add"
          class="inline-flex h-[38px] items-center gap-1.5 rounded-md bg-brand px-4 text-xs font-semibold text-white transition-colors hover:opacity-90"
        >
          <UIcon name="i-lucide-plus" class="size-4" />
          Add ACL
        </NuxtLink>
      </template>
    </PageHeader>

    <!-- Filter panel -->
    <form
      class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4 sm:flex-row sm:items-end"
      @submit.prevent="applyFilters"
    >
      <div class="flex flex-col gap-1.5 sm:flex-1">
        <label for="acl-search" class="text-[11px] font-semibold text-muted">
          Search / Filter
        </label>
        <input
          id="acl-search"
          v-model="filters.search"
          type="text"
          placeholder="Destination / Source / Ticket"
          class="h-7 rounded-[5px] border border-line bg-panel px-2.5 text-xs text-ink outline-none focus:border-brand"
        >
      </div>
      <div class="flex flex-col gap-1.5 sm:w-44">
        <label for="acl-status" class="text-[11px] font-semibold text-muted">
          Status
        </label>
        <select
          id="acl-status"
          v-model="filters.status"
          class="h-7 rounded-[5px] border border-line bg-panel px-2.5 text-xs text-ink outline-none focus:border-brand"
        >
          <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </div>
      <button
        type="submit"
        class="h-7 rounded-[5px] border border-line bg-panel px-4 text-xs font-semibold text-ink transition-colors hover:bg-surface"
      >
        Apply
      </button>
    </form>

    <!-- Error / loading / empty / table -->
    <ErrorState v-if="error" :message="error" @retry="load" />

    <LoadingState v-else-if="loading && rows.length === 0" message="Loading ACL policies…" />

    <EmptyState
      v-else-if="!loading && rows.length === 0"
      title="No ACL policies found"
      description="Try adjusting your filters, or add a new policy."
      icon="i-lucide-shield-off"
    >
      <template #action>
        <NuxtLink
          to="/acl/add"
          class="inline-flex h-[38px] items-center gap-1.5 rounded-md bg-brand px-4 text-xs font-semibold text-white transition-colors hover:opacity-90"
        >
          <UIcon name="i-lucide-plus" class="size-4" />
          Add ACL
        </NuxtLink>
      </template>
    </EmptyState>

    <template v-else>
      <!-- Table: header labels + spaced white bordered row cards -->
      <div class="flex flex-col gap-2">
        <div
          class="grid grid-cols-[1.4fr_1.4fr_0.6fr_1fr_1.1fr_1.1fr_0.9fr] gap-3 px-4 text-[11px] font-semibold text-muted"
        >
          <span>Destination</span>
          <span>Source</span>
          <span>Port</span>
          <span>Protocol</span>
          <span>Time</span>
          <span>Ticket Change</span>
          <span>Status</span>
        </div>

        <button
          v-for="row in rows"
          :key="row.id"
          type="button"
          :aria-pressed="selected?.id === row.id"
          class="grid grid-cols-[1.4fr_1.4fr_0.6fr_1fr_1.1fr_1.1fr_0.9fr] items-center gap-3 rounded-[5px] border bg-panel px-4 py-3 text-left text-[11px] text-ink transition-colors hover:border-brand/50"
          :class="selected?.id === row.id ? 'border-brand' : 'border-line'"
          @click="selectRow(row)"
        >
          <span class="truncate">{{ row.destination }}</span>
          <span class="truncate">{{ row.source }}</span>
          <span>{{ row.port ?? '—' }}</span>
          <span>{{ row.protocol }}</span>
          <span class="truncate">{{ formatTime(row) }}</span>
          <span class="truncate">{{ row.changeTicket ?? '—' }}</span>
          <span
            class="font-semibold"
            :class="row.status === 'ACTIVE' ? 'text-ok' : 'text-muted'"
          >
            {{ row.status === 'ACTIVE' ? 'Active' : row.status === 'DISABLED' ? 'Disabled' : 'Draft' }}
          </span>
        </button>
      </div>

      <Pagination
        v-if="total > ITEMS_PER_PAGE"
        v-model:page="page"
        :total="total"
        :items-per-page="ITEMS_PER_PAGE"
      />
    </template>

    <!-- ACL Detail / Command Result -->
    <section v-if="selected" class="flex flex-col gap-3">
      <h2 class="text-base font-semibold text-ink">ACL Detail / Command Result</h2>

      <div class="rounded-lg bg-terminal p-4 font-mono text-xs leading-relaxed text-terminal-text">
        <p class="text-ok">✓ {{ selected.name }} loaded successfully</p>
        <pre class="mt-1 whitespace-pre-wrap break-all">{{ commandOutput }}</pre>
      </div>

      <p class="text-[10px] text-muted">Last refreshed: {{ lastRefreshedLabel }}</p>
    </section>
  </div>
</template>
