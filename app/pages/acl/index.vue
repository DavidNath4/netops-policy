<script setup lang="ts">
// ACL search page. Search-only: enter an IP, hit Search, results come live from
// n8n. Device credentials are set once per session via a pop-up; the server
// auto-fills them for each search. Requirements: 4.1, 4.2, 13.1–13.4; n8n 11.
import type { OperationResult } from '#shared/schemas/n8n.schema'

definePageMeta({ middleware: 'permission', permission: 'ACL_POLICIES_SHOW' })

const api = useApi()
const { can } = usePermissions()
const canAdd = computed(() => can('ACL_POLICIES_ADD'))
const canDelete = computed(() => can('ACL_POLICIES_DELETE'))

// Device credentials are now set GLOBALLY from the head bar; this page only
// reads the status to gate search and surface a hint when they're missing.
const { isSet, ensureLoaded } = useDeviceCredentials()

const search = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
const result = ref<OperationResult | null>(null)
const searched = ref(false)

onMounted(ensureLoaded)

// Structured ACL rows from n8n (acl/show returns { data: [...] }). The live
// contract uses snake_case fields (`raw_command`, `acl_name`, `time_range`, and
// endpoints with `subnet_mask`); older camelCase keys are tolerated as a
// fallback so a response in either shape renders.
interface AclEndpoint { type?: string, value?: string, subnet_mask?: string | null }
interface AclRow {
  raw_command?: string
  raw?: string
  acl_name?: string
  aclName?: string
  action?: string
  protocol?: string
  source?: AclEndpoint
  destination?: AclEndpoint
  service?: string | null
  time_range?: string | null
}

const items = computed<AclRow[]>(() => (result.value?.items as AclRow[] | null) ?? [])
const hasItems = computed(() => items.value.length > 0)

function rawCommand(row: AclRow): string | null {
  return row.raw_command ?? row.raw ?? null
}

// Render an endpoint's address only (no mask). Object/type prefixes such as
// "object KSEI-PROD" are preserved; a plain host/network shows just its value.
function endpoint(e?: AclEndpoint): string {
  if (!e || !e.value) return '—'
  return e.type && e.type !== 'host' ? `${e.type} ${e.value}`.trim() : e.value
}

// Subnet mask for its own column. Shown only when meaningful: a `host` entry or
// a /32 mask is a single address, so the redundant 255.255.255.255 is left
// blank. Objects carry no mask, so they also stay blank.
const HOST_MASK = '255.255.255.255'
function endpointMask(e?: AclEndpoint): string {
  if (!e || !e.subnet_mask || e.subnet_mask === HOST_MASK || e.type === 'host') return ''
  return e.subnet_mask
}

// Time range column: show the object name when the rule carries one, otherwise
// leave it blank (the user asked for an empty cell, not a dash).
function timeRange(row: AclRow): string {
  return row.time_range ?? ''
}

// Selected row → its raw command (shown in a RawCommandBox above the table).
const selectedIndex = ref<number | null>(null)
const selectedRaw = computed(() => {
  if (selectedIndex.value === null) return null
  const row = items.value[selectedIndex.value]
  return row ? rawCommand(row) : null
})

function selectRow(i: number) {
  selectedIndex.value = selectedIndex.value === i ? null : i
}

// Table columns for the scrollable result table.
const tableColumns = [
  { key: 'source', label: 'Source', width: '1.4fr' },
  { key: 'sourceMask', label: 'Source Subnet Mask', width: '1.2fr' },
  { key: 'destination', label: 'Destination', width: '1.4fr' },
  { key: 'destinationMask', label: 'Destination Subnet Mask', width: '1.2fr' },
  { key: 'timeRange', label: 'Time Range', width: '1.1fr' },
]

// Reset the selection whenever a new search result arrives.
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

  // Gate: need device credentials first — now set from the head bar.
  if (!isSet.value) {
    error.value = 'Set your device credentials from the key icon in the top bar, then search.'
    return
  }

  loading.value = true
  searched.value = true
  try {
    result.value = await api.aclOps.show(value)
  }
  catch (e) {
    // The server returns DEVICE_CREDENTIALS_REQUIRED if creds expired mid-session.
    const code = (e as { data?: { error?: { code?: string } } })?.data?.error?.code
    if (code === 'DEVICE_CREDENTIALS_REQUIRED') {
      await ensureLoaded()
      error.value = 'Your device credentials expired. Set them again from the key icon in the top bar.'
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
</script>

<template>
  <div class="flex flex-col gap-6" style="zoom: 1.2">
    <PageHeader title="ACL Policies" description="Search ACLs live from the device.">
      <template #actions>
        <NuxtLink
          v-if="canAdd"
          to="/acl/add"
          class="inline-flex h-[38px] items-center gap-1.5 rounded-md bg-brand px-4 text-xs font-semibold text-white transition-colors hover:opacity-90"
        >
          <UIcon name="i-lucide-plus" class="size-4" />
          Add ACL
        </NuxtLink>
        <NuxtLink
          v-if="canDelete"
          to="/acl/delete"
          class="inline-flex h-[38px] items-center gap-1.5 rounded-md border border-line bg-panel px-4 text-xs font-semibold text-bad transition-colors hover:bg-surface"
        >
          <UIcon name="i-lucide-trash-2" class="size-4" />
          Delete ACL
        </NuxtLink>
      </template>
    </PageHeader>

    <!-- Search bar -->
    <form
      class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4 sm:flex-row sm:items-end"
      @submit.prevent="runSearch"
    >
      <div class="flex flex-col gap-1.5 sm:flex-1">
        <label for="acl-search" class="text-[11px] font-semibold text-muted">Search by IP address</label>
        <input
          id="acl-search"
          v-model="search"
          type="text"
          placeholder="e.g. 10.131.10.111"
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

    <!-- Failed result -->
    <section v-else-if="result && result.status === 'FAILED'" class="flex flex-col gap-3">
      <div class="rounded-lg bg-terminal p-4 font-mono text-xs leading-relaxed">
        <p class="text-bad">✗ Search failed</p>
        <pre class="mt-1 whitespace-pre-wrap break-all text-bad">{{ result.error ?? result.message ?? 'Unknown error' }}</pre>
      </div>
    </section>

    <!-- Success but no rows -->
    <EmptyState
      v-else-if="searched && result && !hasItems && !result.output"
      icon="i-lucide-shield-off"
      title="No results"
      :description="result.message ?? 'No ACL entries matched that IP address.'"
    />

    <!-- Success with structured rows -->
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
          <span class="truncate">{{ endpoint((row as AclRow).source) }}</span>
          <span class="truncate text-muted">{{ endpointMask((row as AclRow).source) }}</span>
          <span class="truncate">{{ endpoint((row as AclRow).destination) }}</span>
          <span class="truncate text-muted">{{ endpointMask((row as AclRow).destination) }}</span>
          <span class="truncate text-muted">{{ timeRange(row as AclRow) }}</span>
        </template>
      </ScrollableResultTable>
      
      <!-- Raw command sits ABOVE the table so it's visible without scrolling -->
      <RawCommandBox :command="selectedRaw" />
    </section>

    <!-- Success with only raw text (fallback) -->
    <section v-else-if="result && result.output" class="flex flex-col gap-3">
      <h2 class="text-base font-semibold text-ink">Search Result</h2>
      <div class="rounded-lg bg-terminal p-4 font-mono text-xs leading-relaxed">
        <pre class="whitespace-pre-wrap break-all text-terminal-text">{{ result.output }}</pre>
      </div>
    </section>

    <EmptyState
      v-else
      icon="i-lucide-search"
      title="Search ACLs"
      description="Enter an IP address above to look up ACL entries on the device."
    />
  </div>
</template>
