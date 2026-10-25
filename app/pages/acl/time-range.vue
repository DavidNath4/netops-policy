<script setup lang="ts">
// Time Range page (under ACL Policies). Lists every device time-range object in
// a table — name, end detail, and how many ACL rules use it — loaded live from
// n8n via the Device Session Credentials (set once per session, like Show ACL).
// Clicking a row opens a pop-up of the ACL rules that reference it (max ~5 then
// scroll, searchable IN-MEMORY — no extra API call) plus a Delete action
// (ACL_POLICIES_DELETE, disabled while usageCount > 0). Below the table, an Add
// form creates a standalone time-range object (date mode = name derived from the
// date, like ACL Add "Create New"; named mode = typed name).
import type { TimeRangeAddInput, TimeRangeBlockingRule, TimeRangeOverview } from '#shared/schemas/time-range.schema'

definePageMeta({ middleware: 'permission', permission: 'ACL_POLICIES_SHOW' })

const api = useApi()
const { can } = usePermissions()
const canAdd = computed(() => can('ACL_POLICIES_ADD'))
const canDelete = computed(() => can('ACL_POLICIES_DELETE'))

// Device credentials are now set GLOBALLY from the head bar; this page only
// reads the status to gate loading and surface a hint when they're missing.
const { isSet, ensureLoaded } = useDeviceCredentials()

onMounted(ensureLoaded)

// --- Overview table -----------------------------------------------------------
const loading = ref(false)
const error = ref<string | null>(null)
const items = ref<TimeRangeOverview[]>([])
const loaded = ref(false)

// In-memory table search (filters the already-loaded list; never hits the API).
const tableSearch = ref('')
const filteredItems = computed(() => {
  const q = tableSearch.value.trim().toLowerCase()
  if (!q) return items.value
  return items.value.filter(o =>
    o.name.toLowerCase().includes(q)
    || endsDetail(o).toLowerCase().includes(q),
  )
})

/** End-detail cell: "ends <date> <time>", falling back to the raw config. */
function endsDetail(o: TimeRangeOverview): string {
  if (o.endDate || o.endTime) return `${o.endDate ?? '?'} ${o.endTime ?? ''}`.trim()
  return o.rawConfig ?? '—'
}

async function loadOverview() {
  if (!isSet.value) {
    error.value = 'Set your device credentials from the key icon in the top bar, then refresh.'
    return
  }
  loading.value = true
  error.value = null
  try {
    const res = await api.aclOps.timeRangeOverview()
    items.value = res.items
    loaded.value = true
  }
  catch (e) {
    const code = (e as { data?: { error?: { code?: string } } })?.data?.error?.code
    if (code === 'DEVICE_CREDENTIALS_REQUIRED') {
      await ensureLoaded()
      error.value = 'Your device credentials expired. Set them again from the key icon in the top bar.'
      items.value = []
      loaded.value = false
    }
    else {
      const msg = (e as { data?: { error?: { message?: string } } })?.data?.error?.message
      error.value = msg ?? (e instanceof Error ? e.message : 'Failed to load time ranges.')
    }
  }
  finally {
    loading.value = false
  }
}

// Load once credentials are known to be set (globally, from the head bar).
watch(isSet, (set) => {
  if (set && !loaded.value) void loadOverview()
}, { immediate: true })

// --- Usage pop-up (row click → the ACL rules that use this object) ------------
const usageModalOpen = ref(false)
const usageObject = ref<TimeRangeOverview | null>(null)
const usageSearch = ref('')

function openUsage(o: TimeRangeOverview) {
  usageObject.value = o
  usageSearch.value = ''
  usageModalOpen.value = true
}

// Client-side filter over the already-loaded raw commands (never hits the API).
const filteredUsage = computed(() => {
  const o = usageObject.value
  if (!o) return []
  const q = usageSearch.value.trim().toLowerCase()
  if (!q) return o.rawCommands
  return o.rawCommands.filter(c => c.toLowerCase().includes(q))
})

// --- Delete (from the usage pop-up) -------------------------------------------
// Delete is disabled up front when the selected object is still used by ACL
// rules (usageCount > 0); n8n also refuses server-side as a safety net. A click
// opens a confirmation; on a server refusal we open a warning pop-up listing the
// blocking ACL rules.
const deleteConfirmOpen = ref(false)
const deleting = ref(false)
const warningOpen = ref(false)
const warningMessage = ref('')
const warningRules = ref<TimeRangeBlockingRule[]>([])

const deleteDisabled = computed(() =>
  !canDelete.value || deleting.value || (usageObject.value?.usageCount ?? 0) > 0,
)

function askDelete() {
  if (deleteDisabled.value) return
  deleteConfirmOpen.value = true
}

async function onDeleteConfirmed() {
  const o = usageObject.value
  if (!o) return
  deleting.value = true
  try {
    const res = await api.aclOps.timeRangeDelete({ objectName: o.name })
    deleteConfirmOpen.value = false
    if (res.status === 'SUCCESS') {
      usageModalOpen.value = false
      showDialog('success', 'Time range deleted', `Object "${res.objectName}" was deleted from the device.`)
      loaded.value = false
      await loadOverview()
    }
    else {
      // Device/n8n refused (e.g. still in use, or an ASA error) — warn with the
      // blocking rules when present.
      warningMessage.value = res.message ?? 'The device refused to delete the time range.'
      warningRules.value = res.blockingRules
      warningOpen.value = true
    }
  }
  catch (e) {
    deleteConfirmOpen.value = false
    warningMessage.value = toMessage(e, 'Failed to delete the time range.')
    warningRules.value = []
    warningOpen.value = true
  }
  finally {
    deleting.value = false
  }
}

// --- Add time-range form ------------------------------------------------------
const addForm = reactive({
  mode: 'date' as 'date' | 'named',
  objectName: '',
  date: '',
  time: '23:59',
})
const adding = ref(false)

const dialog = reactive({
  open: false,
  variant: 'success' as 'success' | 'error' | 'warning',
  title: '',
  message: '',
})
function showDialog(variant: 'success' | 'error' | 'warning', title: string, message: string) {
  dialog.variant = variant
  dialog.title = title
  dialog.message = message
  dialog.open = true
}
function toMessage(e: unknown, fallback: string): string {
  if (e && typeof e === 'object' && 'data' in e) {
    const data = (e as { data?: { error?: { message?: string } } }).data
    if (data?.error?.message) return data.error.message
  }
  return e instanceof Error ? e.message : fallback
}

// Manual HH:mm typing (digits + single colon), same behavior as ACL Add.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
function onTimeInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  let digits = raw.replace(/\D/g, '').slice(0, 4)
  if (digits.length > 2) digits = `${digits.slice(0, 2)}:${digits.slice(2)}`
  addForm.time = digits
}
const timeFormatValid = computed(() => addForm.time === '' || TIME_RE.test(addForm.time))

// A typed name: no spaces, safe character set (mirrors the server schema).
const NAME_RE = /^[A-Za-z0-9._-]+$/
const nameValid = computed(() => addForm.mode !== 'named' || NAME_RE.test(addForm.objectName.trim()))

// Client-side duplicate guard against the already-loaded list (the server
// re-checks). Only meaningful in named mode; date mode derives the name server-
// side, where the same guard runs.
const nameDuplicate = computed(() =>
  addForm.mode === 'named'
  && addForm.objectName.trim() !== ''
  && items.value.some(o => o.name === addForm.objectName.trim()),
)

// Generate is allowed once the inputs are valid; Execute runs after a preview.
const canGenerate = computed(() => {
  if (!canAdd.value || generating.value) return false
  if (addForm.date === '' || !timeFormatValid.value) return false
  if (addForm.mode === 'named' && (!nameValid.value || nameDuplicate.value)) return false
  return true
})

/** Build the add/preview payload from the form. */
function buildAddPayload(): TimeRangeAddInput {
  return addForm.mode === 'named'
    ? { mode: 'named', objectName: addForm.objectName.trim(), date: addForm.date, time: addForm.time || '23:59' }
    : { mode: 'date', date: addForm.date, time: addForm.time || '23:59' }
}

const generating = ref(false)
const confirmOpen = ref(false)
const preview = ref<string | null>(null)

// Any form change invalidates a stale preview.
watch(addForm, () => { preview.value = null })

async function onGenerate() {
  if (!canGenerate.value) return
  generating.value = true
  try {
    const { preview: text } = await api.aclOps.timeRangePreview(buildAddPayload())
    preview.value = text
  }
  catch (e) {
    showDialog('error', 'Generate failed', toMessage(e, 'Failed to build the command preview.'))
  }
  finally {
    generating.value = false
  }
}

async function onExecuteConfirmed() {
  adding.value = true
  try {
    const res = await api.aclOps.timeRangeAdd(buildAddPayload())
    confirmOpen.value = false
    if (res.status === 'SUCCESS') {
      showDialog('success', 'Time range created', `Object "${res.objectName}" was created on the device.`)
      addForm.mode = 'date'
      addForm.objectName = ''
      addForm.date = ''
      addForm.time = '23:59'
      preview.value = null
      loaded.value = false
      await loadOverview()
    }
    else {
      showDialog('error', 'Failed to create time range', res.message ?? 'The device refused to create the time range.')
    }
  }
  catch (e) {
    confirmOpen.value = false
    showDialog('error', 'Failed to create time range', toMessage(e, 'Failed to create the time range.'))
  }
  finally {
    adding.value = false
  }
}

const inputClass
  = 'h-[38px] w-full rounded-md border border-line bg-panel px-3 text-xs text-ink outline-none focus:border-brand disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted'
</script>

<template>
  <div class="flex flex-col gap-6" style="zoom: 1.3">
    <PageHeader title="Time Range" description="Device time-range objects and the ACL rules that use them.">
      <template #actions>
        <NuxtLink
          to="/acl"
          class="inline-flex h-[38px] items-center gap-1.5 rounded-md border border-line bg-panel px-4 text-xs font-semibold text-ink transition-colors hover:bg-surface"
        >
          <UIcon name="i-lucide-arrow-left" class="size-4" />
          Back
        </NuxtLink>
      </template>
    </PageHeader>

    <!-- Search bar + Refresh (same layout as Show ACL / Show Routes). The search
         filters the already-loaded objects client-side; Refresh re-fetches. -->
    <div class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4 sm:flex-row sm:items-end">
      <div class="flex flex-col gap-1.5 sm:flex-1">
        <label for="tr-table-search" class="text-[11px] font-semibold text-muted">Search time range objects</label>
        <input
          id="tr-table-search"
          v-model="tableSearch"
          type="text"
          placeholder="Search by name or end detail…"
          class="h-7 rounded-[5px] border border-line bg-panel px-2.5 text-xs text-ink outline-none focus:border-brand"
        >
      </div>
      <button
        type="button"
        :disabled="!isSet || loading"
        class="inline-flex h-7 items-center gap-1.5 rounded-[5px] border border-line px-4 text-xs font-semibold text-ink transition-colors hover:bg-surface disabled:opacity-60"
        @click="loadOverview"
      >
        <UIcon name="i-lucide-refresh-cw" class="size-3.5" :class="{ 'animate-spin': loading }" />
        Refresh
      </button>
    </div>

    <UAlert v-if="error" color="error" variant="soft" icon="i-lucide-circle-alert" :description="error" />

    <LoadingState v-if="loading" message="Loading time ranges…" />

    <!-- Table -->
    <section v-else-if="loaded" class="flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <h2 class="text-base font-semibold text-ink">Time Range Objects</h2>
        <span class="text-xs text-muted">{{ filteredItems.length }} / {{ items.length }} shown</span>
      </div>

      <EmptyState
        v-if="items.length === 0"
        icon="i-lucide-clock"
        title="No time range objects"
        description="The device returned no time-range objects. Create one below."
      />

      <!-- Up to ~20 rows visible, then the body scrolls. Header stays sticky. -->
      <div v-else class="overflow-hidden rounded-lg border border-line">
        <div class="max-h-[24rem] overflow-y-auto">
          <table class="w-full text-left text-xs">
            <thead class="sticky top-0 z-10 bg-surface text-[11px] font-semibold text-muted">
              <tr>
                <th class="px-4 py-2.5">Object Name</th>
                <th class="px-4 py-2.5">Ends</th>
                <th class="px-4 py-2.5 text-right">Rules</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="o in filteredItems"
                :key="o.name"
                class="cursor-pointer border-t border-line transition-colors hover:bg-surface"
                @click="openUsage(o)"
              >
                <td class="px-4 py-2.5 font-mono text-ink">{{ o.name }}</td>
                <td class="px-4 py-2.5 text-muted">{{ endsDetail(o) }}</td>
                <td class="px-4 py-2.5 text-right">
                  <span
                    class="inline-flex min-w-6 items-center justify-center rounded px-1.5 py-0.5 text-[11px] font-semibold"
                    :class="o.usageCount > 0 ? 'bg-brand/10 text-brand' : 'bg-surface text-muted'"
                  >{{ o.usageCount }}</span>
                </td>
              </tr>
              <tr v-if="filteredItems.length === 0">
                <td colspan="3" class="px-4 py-6 text-center text-xs text-muted">No object matches your search.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <EmptyState
      v-else
      icon="i-lucide-clock"
      title="Time ranges"
      description="Set your device credentials to load the device's time-range objects."
    />

    <!-- Add time-range form -->
    <section v-if="canAdd" class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4">
      <h2 class="text-base font-semibold text-ink">Add Time Range</h2>

      <!-- Mode tabs: date (derive name) / named (type the name). -->
      <div class="grid max-w-sm grid-cols-2 gap-1 rounded-md border border-line bg-surface p-1" role="tablist" aria-label="Add mode">
        <button
          type="button"
          role="tab"
          :aria-selected="addForm.mode === 'date'"
          class="rounded px-3 py-1.5 text-xs font-semibold transition-colors"
          :class="addForm.mode === 'date' ? 'bg-panel text-brand shadow-sm' : 'text-muted hover:text-ink'"
          @click="addForm.mode = 'date'"
        >
          From Date
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="addForm.mode === 'named'"
          class="rounded px-3 py-1.5 text-xs font-semibold transition-colors"
          :class="addForm.mode === 'named' ? 'bg-panel text-brand shadow-sm' : 'text-muted hover:text-ink'"
          @click="addForm.mode = 'named'"
        >
          Custom Name
        </button>
      </div>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div v-if="addForm.mode === 'named'" class="flex flex-col gap-1.5">
          <label for="tr-name" class="text-sm font-medium text-ink">Object Name</label>
          <input
            id="tr-name"
            v-model="addForm.objectName"
            type="text"
            placeholder="e.g. maintenance-window"
            :class="[inputClass, (!nameValid || nameDuplicate) && addForm.objectName ? 'border-bad' : '']"
          >
          <p v-if="addForm.objectName && !nameValid" class="text-[11px] text-bad" role="alert">
            Gunakan huruf, angka, titik, underscore, atau tanda hubung (tanpa spasi).
          </p>
          <p v-else-if="nameDuplicate" class="text-[11px] text-bad" role="alert">
            This object name already exists on the device.
          </p>
        </div>

        <div class="flex flex-col gap-1.5">
          <label for="tr-date" class="text-sm font-medium text-ink">End Date</label>
          <input id="tr-date" v-model="addForm.date" type="date" :class="inputClass">
        </div>

        <div class="flex flex-col gap-1.5">
          <label for="tr-time" class="text-sm font-medium text-ink">End Time</label>
          <input
            id="tr-time"
            v-model="addForm.time"
            type="text"
            inputmode="numeric"
            maxlength="5"
            placeholder="23:59"
            :class="[inputClass, !timeFormatValid ? 'border-bad' : '']"
            @input="onTimeInput"
          >
          <p v-if="!timeFormatValid" class="text-[11px] text-bad" role="alert">
            Time must be HH:mm (24-hour), e.g. 23:59.
          </p>
        </div>
      </div>

      <!-- Generated command preview (same Generate → Execute flow as Add ACL). -->
      <div class="flex flex-col gap-2">
        <h3 class="text-sm font-semibold text-ink">Generated Command</h3>
        <div class="rounded-lg bg-terminal p-4 font-mono text-xs leading-relaxed text-terminal-text">
          <pre v-if="preview" class="whitespace-pre-wrap break-words">{{ preview }}</pre>
          <p v-else class="text-terminal-text/60">Fill the fields and click Generate to preview the command.</p>
        </div>
      </div>

      <div class="flex justify-end">
        <button
          v-if="!preview"
          type="button"
          :disabled="!canGenerate"
          class="inline-flex h-[38px] items-center gap-1.5 rounded-md bg-brand px-4 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-60"
          @click="onGenerate"
        >
          <UIcon :name="generating ? 'i-lucide-loader-circle' : 'i-lucide-terminal'" class="size-4" :class="{ 'animate-spin': generating }" />
          Generate
        </button>
        <button
          v-else
          type="button"
          :disabled="adding"
          class="inline-flex h-[38px] items-center gap-1.5 rounded-md bg-brand px-4 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-60"
          @click="confirmOpen = true"
        >
          <UIcon name="i-lucide-play" class="size-4" />
          Create Time Range
        </button>
      </div>
    </section>

    <ConfirmDialog
      v-model="confirmOpen"
      title="Create time range?"
      message="This will create the previewed time-range object on the device via automation."
      confirm-label="Create"
      confirm-color="primary"
      :loading="adding"
      @confirm="onExecuteConfirmed"
    />

    <!-- Usage pop-up: the ACL rules using the selected object. -->
    <UModal
      v-model:open="usageModalOpen"
      :title="usageObject ? `Rules using ${usageObject.name}` : 'Rules'"
      :ui="{ content: 'bg-white text-ink ring-1 ring-line divide-y divide-line', title: 'text-ink', body: 'bg-white' }"
    >
      <template #body>
        <div class="flex flex-col gap-3">
          <p class="text-xs text-muted">
            {{ usageObject?.usageCount ?? 0 }} ACL rule(s) reference this time range.
          </p>
          <input
            v-model="usageSearch"
            type="text"
            placeholder="Search rules…"
            class="h-[34px] w-full rounded-md border border-line bg-panel px-3 text-xs text-ink outline-none focus:border-brand"
          >
          <!-- Max ~5 rows then scroll. -->
          <div class="max-h-[15rem] overflow-y-auto rounded-md border border-line">
            <ul v-if="filteredUsage.length > 0" class="divide-y divide-line">
              <li v-for="(cmd, i) in filteredUsage" :key="i" class="px-3 py-2 font-mono text-[11px] leading-relaxed text-ink">
                {{ cmd }}
              </li>
            </ul>
            <p v-else class="px-3 py-4 text-center text-xs text-muted">
              {{ (usageObject?.rawCommands.length ?? 0) === 0 ? 'No ACL rule uses this time range.' : 'No rule matches your search.' }}
            </p>
          </div>

          <!-- Delete action (ACL_POLICIES_DELETE only; disabled while in use). -->
          <div v-if="canDelete" class="flex items-center justify-between gap-3 border-t border-line pt-3">
            <p v-if="(usageObject?.usageCount ?? 0) > 0" class="text-[11px] text-muted">
              Still used by {{ usageObject?.usageCount }} ACL rule(s) — remove those rules first (via Delete ACL) before this object can be deleted.
            </p>
            <p v-else class="text-[11px] text-muted">
              This object is not used by any rule and is safe to delete.
            </p>
            <button
              type="button"
              :disabled="deleteDisabled"
              class="inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-md bg-bad px-4 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50"
              @click="askDelete"
            >
              <UIcon :name="deleting ? 'i-lucide-loader-circle' : 'i-lucide-trash-2'" class="size-3.5" :class="{ 'animate-spin': deleting }" />
              Delete
            </button>
          </div>
        </div>
      </template>
    </UModal>

    <!-- Delete confirmation. -->
    <ConfirmDialog
      v-model="deleteConfirmOpen"
      title="Delete time range?"
      :message="`This will remove the time-range object '${usageObject?.name ?? ''}' from the device via automation.`"
      confirm-label="Delete"
      confirm-color="error"
      :loading="deleting"
      @confirm="onDeleteConfirmed"
    />

    <!-- Warning when the device/n8n refused the delete (e.g. still in use). -->
    <UModal
      v-model:open="warningOpen"
      title="Cannot delete time range"
      :ui="{ content: 'bg-white text-ink ring-1 ring-line divide-y divide-line', title: 'text-ink', body: 'bg-white' }"
    >
      <template #body>
        <div class="flex flex-col gap-3">
          <div class="flex items-start gap-3">
            <UIcon name="i-lucide-triangle-alert" class="mt-0.5 size-5 shrink-0 text-amber-500" />
            <p class="text-sm text-ink">{{ warningMessage }}</p>
          </div>
          <div v-if="warningRules.length > 0" class="flex flex-col gap-1">
            <p class="text-[11px] font-semibold text-muted">ACL rules still using this object:</p>
            <div class="max-h-[15rem] overflow-y-auto rounded-md border border-line">
              <ul class="divide-y divide-line">
                <li v-for="(r, i) in warningRules" :key="i" class="px-3 py-2 font-mono text-[11px] leading-relaxed text-ink">
                  <span v-if="r.aclName" class="text-muted">[{{ r.aclName }}] </span>{{ r.rawRule }}
                </li>
              </ul>
            </div>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end">
          <UButton color="neutral" label="Close" @click="warningOpen = false" />
        </div>
      </template>
    </UModal>

    <ResultDialog
      v-model:open="dialog.open"
      :variant="dialog.variant"
      :title="dialog.title"
      :message="dialog.message"
    />
  </div>
</template>
