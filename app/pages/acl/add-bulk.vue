<script setup lang="ts">
// Bulk Add ACL — add several source↔destination pairs in ONE batch under ONE
// iTop ticket and ONE set of device credentials. Each row (AclBulkRowCard) has
// the same fields as a single ADD (source + mask, destination + mask, per-row
// bidirectional, optional time range). Flow:
//   Generate → server classifies every row NEW/EXISTS + per-row command preview.
//   If ANY row is EXISTS, Execute is blocked (hard gate): the operator must
//   remove the highlighted rows before the batch can run. Only when every row is
//   NEW does Execute run — the server re-enforces the same all-or-nothing gate.
import type { BulkRow } from '~/composables/useAclBulkRows'
import type { AclBulkExecuteInput } from '#shared/schemas/acl.schema'
import type { AclBulkExecuteResult, AclBulkPreviewResult } from '#shared/schemas/n8n.schema'
import type { ItopTicketSummary } from '#shared/schemas/itop.schema'
import type { TimeRangeObject } from '#shared/schemas/time-range.schema'
import { bulkRowToItem, bulkRowValid, emptyBulkRow } from '~/composables/useAclBulkRows'
import { ACL_BULK_MAX_DIRECTIONS } from '#shared/schemas/acl.schema'

definePageMeta({ middleware: 'permission', permission: 'ACL_POLICIES_ADD' })

const api = useApi()

// Batch-global fields (bidirectional is per row, inside each card).
const creds = reactive({ execUsername: '', execPassword: '' })
const changeTicket = ref('')
const rows = reactive<BulkRow[]>([emptyBulkRow()])

// Seed the batch credentials from the global head-bar credentials. Keep
// `refillCreds` to re-seed after a successful execute clears the form.
const { fill: refillCreds } = useAutofillDeviceCreds(creds)

const showPassword = ref(false)

// How many DIRECTIONS the batch would run: SUM over rows (each row is 1, or 2
// when its own bidirectional is on). A mixed batch can total an odd number.
const directionCount = computed(() => rows.reduce((sum, r) => sum + (r.bidirectional ? 2 : 1), 0))
// A new row is always one-way at first (+1), so it fits whenever there is at
// least one direction of headroom.
const canAddRow = computed(() => directionCount.value + 1 <= ACL_BULK_MAX_DIRECTIONS)
const overLimit = computed(() => directionCount.value > ACL_BULK_MAX_DIRECTIONS)

function addRow() {
  if (canAddRow.value) rows.push(emptyBulkRow())
}
function removeRow(i: number) {
  rows.splice(i, 1)
  if (rows.length === 0) rows.push(emptyBulkRow())
}
function expandAll() {
  rows.forEach(r => (r.expanded = true))
}
function collapseAll() {
  rows.forEach(r => (r.expanded = false))
}

// --- Change ticket (iTop, read-only pick) -------------------------------------
const ticketModalOpen = ref(false)
const selectedTicket = ref<ItopTicketSummary | null>(null)
function onTicketSelected(t: ItopTicketSummary) {
  selectedTicket.value = t
  changeTicket.value = t.ref
}

// --- Time-range catalog (shared across rows, loaded once per credentials) -----
// The n8n time/show webhook authenticates, so the catalog is fetched using the
// batch credentials once they are filled and at least one row is in "existing"
// mode. One fetch serves every row card's Select Existing dropdown.
const timeRangeObjects = ref<TimeRangeObject[]>([])
const timeRangeLoading = ref(false)
const timeRangeLoadError = ref(false)
const timeRangeLoaded = ref(false)

const credsFilled = computed(() => creds.execUsername.trim() !== '' && creds.execPassword !== '')

// Batch-global time range (existing-only). When enabled + an object is picked,
// it applies to EVERY row and the per-row time-range control is disabled. This
// is the recommended way to give many rows the SAME schedule without each row
// creating a duplicate "new" object.
const globalTimeRange = reactive({ enabled: false, objectName: '' })
// Active only when enabled AND an object is actually chosen.
const globalTimeRangeActive = computed(() => globalTimeRange.enabled && globalTimeRange.objectName !== '')

// The catalog is needed when the global picker is on, or any row uses existing.
const anyExistingMode = computed(() =>
  globalTimeRange.enabled || rows.some(r => r.timeRangeEnabled && r.timeRangeMode === 'existing'),
)

async function loadTimeRanges() {
  if (!credsFilled.value || timeRangeLoaded.value || timeRangeLoading.value) return
  timeRangeLoading.value = true
  timeRangeLoadError.value = false
  try {
    const { objects } = await api.aclOps.timeRanges({
      execUsername: creds.execUsername,
      execPassword: creds.execPassword,
    })
    timeRangeObjects.value = objects
    timeRangeLoaded.value = true
  }
  catch {
    timeRangeLoadError.value = true
  }
  finally {
    timeRangeLoading.value = false
  }
}

function timeRangeDetail(o: TimeRangeObject): string {
  if (o.endDate || o.endTime) return `ends ${o.endDate ?? '?'} ${o.endTime ?? ''}`.trim()
  return o.rawConfig ?? ''
}
const timeRangeItems = computed(() =>
  timeRangeObjects.value.map(o => ({ label: o.name, detail: timeRangeDetail(o), value: o.name })),
)

// A credential change invalidates the loaded catalog (fetched as another user).
watch([() => creds.execUsername, () => creds.execPassword], () => {
  timeRangeLoaded.value = false
  timeRangeObjects.value = []
  timeRangeLoadError.value = false
})
// Auto-load when credentials are filled and a row needs the existing catalog.
watch(
  () => credsFilled.value && anyExistingMode.value,
  (ready) => { if (ready) void loadTimeRanges() },
  { immediate: true },
)

// --- Validity (defense-in-depth; server re-validates) -------------------------
const allRowsValid = computed(() => rows.every(bulkRowValid))
// Generate is allowed once credentials + ticket are set, every row is valid, and
// the batch is within the direction ceiling.
const canGenerate = computed(() =>
  credsFilled.value && changeTicket.value !== '' && allRowsValid.value && !overLimit.value,
)

// --- Build the API payload ----------------------------------------------------
function buildPayload(): AclBulkExecuteInput {
  return {
    items: rows.map(bulkRowToItem),
    changeTicket: changeTicket.value,
    globalTimeRange: globalTimeRangeActive.value
      ? { mode: 'existing', objectName: globalTimeRange.objectName }
      : undefined,
    execUsername: creds.execUsername,
    execPassword: creds.execPassword,
  }
}

// --- Generate / preview -------------------------------------------------------
const generating = ref(false)
const executing = ref(false)
const confirmOpen = ref(false)
const previewResult = ref<AclBulkPreviewResult | null>(null)
const executeResult = ref<AclBulkExecuteResult | null>(null)

// Indexes of rows the last preview flagged as EXISTS — highlighted in the list.
const blockingIndexes = computed(() =>
  (previewResult.value?.rows ?? []).filter(r => r.status === 'EXISTS').map(r => r.index),
)
function isRowBlocking(i: number): boolean {
  return blockingIndexes.value.includes(i)
}
// Execute is allowed only when a clean preview exists (no EXISTS row).
const canExecute = computed(() => previewResult.value !== null && !previewResult.value.hasBlocking)

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

// Only DATA changes invalidate a stale preview — not UI-only expand/collapse.
// Serialize every field except `expanded` into a signature the watcher tracks.
const rowsDataSignature = computed(() =>
  JSON.stringify(rows.map(({ expanded, ...data }) => data)),
)
watch([rowsDataSignature, creds, changeTicket, globalTimeRange], () => {
  previewResult.value = null
  executeResult.value = null
}, { deep: true })

async function onGenerate() {
  if (!canGenerate.value) {
    showDialog('error', 'Complete the form', 'Fill in the credentials, pick a ticket, and fix any invalid rows before Generate.')
    return
  }
  generating.value = true
  executeResult.value = null
  try {
    const res = await api.aclOps.bulkPreview(buildPayload())
    previewResult.value = res
    if (res.hasBlocking) {
      // Auto-expand every blocking row so the operator can find and fix them.
      const blocked = res.rows.filter(r => r.status !== 'NEW')
      blocked.forEach((r) => { if (rows[r.index]) rows[r.index]!.expanded = true })
      const list = blocked
        .map(r => `#${r.index + 1}  ${r.source} → ${r.destination} — ${r.reason ?? 'blocked'}`)
        .join('\n')
      showDialog(
        'warning',
        'Some rows are blocked',
        `The following rows are blocked (highlighted red in the list). `
        + `Fix or remove them, then Generate again:\n\n${list}`,
      )
    }
  }
  catch (e) {
    showDialog('error', 'Generate failed', toMessage(e, 'Failed to build the batch preview.'))
  }
  finally {
    generating.value = false
  }
}

function resetAll() {
  creds.execUsername = ''
  creds.execPassword = ''
  changeTicket.value = ''
  selectedTicket.value = null
  globalTimeRange.enabled = false
  globalTimeRange.objectName = ''
  rows.splice(0, rows.length, emptyBulkRow())
  // Re-seed the batch credentials from the global head-bar creds (just cleared);
  // a no-op if the global creds have since expired.
  void refillCreds()
}

async function onExecuteConfirmed() {
  executing.value = true
  try {
    const res = await api.aclOps.bulkExecute(buildPayload())
    confirmOpen.value = false
    executeResult.value = res
    if (res.allOk) {
      resetAll()
      await nextTick()
      executeResult.value = res
    }
    showDialog(
      res.allOk ? 'success' : 'error',
      res.allOk ? 'Batch succeeded' : 'Some rows failed',
      res.allOk
        ? `${res.rows.length} row(s) executed via automation.`
        : 'Some rows failed to execute. See the per-row detail below.',
    )
  }
  catch (e) {
    confirmOpen.value = false
    showDialog('error', 'Execution failed', toMessage(e, 'Batch execution failed.'))
  }
  finally {
    executing.value = false
  }
}

const inputClass
  = 'h-[38px] w-full rounded-md border border-line bg-panel px-3 text-xs text-ink outline-none focus:border-brand disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted'
</script>

<template>
  <div class="flex flex-col gap-6">
    <PageHeader
      title="Bulk Add ACL Policy"
      description="Add several source → destination pairs in one batch under one ticket."
    >
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

    <form class="flex flex-col gap-5" @submit.prevent="onGenerate">
      <!-- Batch-global credentials (forwarded to automation; never stored). -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Username" name="execUsername" required>
          <template #default="{ id }">
            <UInput
              :id="id"
              v-model="creds.execUsername"
              type="text"
              autocomplete="off"
              color="neutral"
              variant="outline"
              class="w-full"
              :ui="{ base: 'bg-panel text-ink ring-line placeholder:text-muted' }"
            />
          </template>
        </FormField>
        <FormField label="Password" name="execPassword" required>
          <template #default="{ id }">
            <UInput
              :id="id"
              v-model="creds.execPassword"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="off"
              color="neutral"
              variant="outline"
              class="w-full"
              :ui="{ base: 'bg-panel text-ink ring-line placeholder:text-muted' }"
            >
              <template #trailing>
                <UButton
                  :icon="showPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                  color="neutral"
                  variant="link"
                  size="sm"
                  :aria-label="showPassword ? 'Hide password' : 'Show password'"
                  :aria-pressed="showPassword"
                  tabindex="-1"
                  @click="showPassword = !showPassword"
                />
              </template>
            </UInput>
          </template>
        </FormField>
      </div>

      <!-- Batch-global ticket (bidirectional is per row, inside each card). -->  
      <!-- Ticket Change + Global Time Range -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">

        <!-- LEFT: Ticket Change -->
        <FormField label="Ticket Change" name="changeTicket" required>
          <template #default="{ id }">
            <div class="flex items-center gap-2">
              <input
                :id="id"
                :value="changeTicket"
                type="text"
                readonly
                placeholder="No ticket selected"
                :class="inputClass"
              >
              <UButton
                color="neutral"
                variant="outline"
                label="Select ticket"
                @click="ticketModalOpen = true"
              />
            </div>
            <p v-if="!changeTicket" class="mt-1 text-[11px] text-muted">
              One ticket tracks the whole batch.
            </p>
          </template>
        </FormField>

        <!-- RIGHT: Global Time Range -->
        <div class="flex flex-col gap-2">

          <!-- Checkbox + Label -->
          <label class="flex min-h-[20px] items-center gap-2 text-xs font-medium text-ink">
            <input
              v-model="globalTimeRange.enabled"
              type="checkbox"
              class="size-3.5 rounded border-line text-brand focus:ring-brand"
            >
            Apply one time range to all rows (Select Existing)
          </label>

          <!-- Select appears only when checked -->
          <template v-if="globalTimeRange.enabled">
            <USelectMenu
              v-model="globalTimeRange.objectName"
              :items="timeRangeItems"
              value-key="value"
              label-key="label"
              :filter-fields="['label', 'detail']"
              :search-input="{ placeholder: 'Search time range...' }"
              placeholder="Select time range for all rows..."
              color="neutral"
              variant="outline"
              class="w-full"
              aria-label="Global time range object"
              :ui="{
                base: 'bg-panel text-ink ring-line min-h-[38px]',
                content: 'bg-panel ring-line',
                viewport: 'max-h-[20rem]'
              }"
            >
              <template #item-label="{ item }">
                <div class="flex flex-col">
                  <span class="text-xs text-ink">{{ item.label }}</span>
                  <span v-if="item.detail" class="text-[10px] text-muted">
                    {{ item.detail }}
                  </span>
                </div>
              </template>
            </USelectMenu>

            <p v-if="!credsFilled" class="text-[11px] text-muted">
              Fill in Username &amp; Password first to load the time range list.
            </p>
            <p v-else-if="timeRangeLoading" class="text-[11px] text-muted">
              Loading existing time range objects...
            </p>
            <p
              v-else-if="timeRangeLoadError || timeRangeObjects.length === 0"
              class="text-[11px] text-muted"
            >
              No existing time range objects could be loaded.
            </p>
            <p v-else class="text-[11px] text-muted">
              This time range applies to every row; per-row time range is disabled while this is on.
            </p>
          </template>
        </div>
      </div>

      <ItopTicketModal
        v-model="ticketModalOpen"
        @selected="onTicketSelected"
      />


      <ItopTicketModal v-model="ticketModalOpen" @selected="onTicketSelected" />

      <!-- Row list -->
      <div class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-3">
            <h2 class="text-base font-semibold text-ink">ACL Rows</h2>
            <span class="text-[11px]" :class="overLimit ? 'text-bad' : 'text-muted'">
              {{ directionCount }} / {{ ACL_BULK_MAX_DIRECTIONS }} directions
            </span>
          </div>
          <div class="flex items-center gap-2">
            <UButton color="neutral" variant="ghost" size="xs" icon="i-lucide-chevrons-up" label="Collapse all" @click="collapseAll" />
            <UButton color="neutral" variant="ghost" size="xs" icon="i-lucide-chevrons-down" label="Expand all" @click="expandAll" />
            <UButton
              color="neutral"
              variant="outline"
              size="xs"
              icon="i-lucide-plus"
              label="Add row"
              :disabled="!canAddRow"
              @click="addRow"
            />
          </div>
        </div>

        <!-- Scroll container: shows ~5 cards, the rest scroll (keeps the page
             from growing unbounded with 20 rows). -->
        <div class="flex max-h-[34rem] flex-col gap-3 overflow-y-auto pr-1">
          <AclBulkRowCard
            v-for="(row, i) in rows"
            :key="i"
            v-model="rows[i]!"
            :index="i"
            :blocking="isRowBlocking(i)"
            :time-range-items="timeRangeItems"
            :creds-filled="credsFilled"
            :time-range-loading="timeRangeLoading"
            :time-range-load-error="timeRangeLoadError"
            :time-range-objects="timeRangeObjects"
            :time-range-disabled="globalTimeRangeActive"
            @remove="removeRow(i)"
          />
        </div>
      </div>

      <!-- Preview -->
      <div class="flex flex-col gap-3">
        <h2 class="text-base font-semibold text-ink">Generated Commands</h2>
        <div v-if="previewResult" class="flex flex-col gap-2">
          <div
            v-for="prow in previewResult.rows"
            :key="prow.index"
            class="rounded-lg border p-4 font-mono text-xs leading-relaxed"
            :class="prow.status !== 'NEW'
              ? 'border-bad bg-bad/5 text-bad'
              : 'border-line bg-terminal text-terminal-text'"
          >
            <div class="mb-2 flex flex-col gap-1 font-sans">
              <div class="flex items-center gap-2">
                <span
                  class="rounded px-1.5 py-0.5 text-[10px] font-semibold"
                  :class="prow.status !== 'NEW' ? 'bg-bad/10 text-bad' : 'bg-ok/10 text-ok'"
                >{{ prow.status }}</span>
                <span class="text-[11px] font-semibold" :class="prow.status !== 'NEW' ? 'text-bad' : 'text-muted'">
                  Row #{{ prow.index + 1 }} · {{ prow.source }} → {{ prow.destination }}
                </span>
              </div>
              <p v-if="prow.reason" class="text-[11px] text-bad">{{ prow.reason }}</p>
            </div>
            <pre class="whitespace-pre-wrap break-words">{{ prow.command.join('\n') }}</pre>
          </div>

          <div
            v-if="previewResult.hasBlocking"
            class="flex items-start gap-2 rounded-md border border-bad bg-bad/5 p-3 text-xs text-bad"
            role="alert"
          >
            <UIcon name="i-lucide-triangle-alert" class="mt-0.5 size-4 shrink-0" />
            <span>
              Some rows are blocked (highlighted red) — they already exist or create a
              duplicate time-range name. Fix or remove them, then Generate again. The
              batch cannot be executed while any row is blocked.
            </span>
          </div>
        </div>
        <div v-else class="rounded-lg bg-terminal p-4 font-mono text-xs text-terminal-text/60">
          Fill the rows and click Generate to preview each command.
        </div>

        <div class="flex justify-end gap-2">
          <button
            v-if="!canExecute"
            type="submit"
            :disabled="generating || !canGenerate"
            class="inline-flex h-[38px] items-center gap-1.5 rounded-md bg-brand px-4 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-60"
          >
            <UIcon :name="generating ? 'i-lucide-loader-circle' : 'i-lucide-terminal'" class="size-4" :class="{ 'animate-spin': generating }" />
            Generate
          </button>
          <button
            v-else
            type="button"
            :disabled="executing"
            class="inline-flex h-[38px] items-center gap-1.5 rounded-md bg-brand px-4 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-60"
            @click="confirmOpen = true"
          >
            <UIcon name="i-lucide-play" class="size-4" />
            Execute Batch
          </button>
        </div>
      </div>
    </form>

    <ConfirmDialog
      v-model="confirmOpen"
      title="Execute bulk ACL batch?"
      message="This will run every previewed command on the target device via automation. This action changes device configuration."
      confirm-label="Execute"
      confirm-color="primary"
      :loading="executing"
      @confirm="onExecuteConfirmed"
    />

    <ResultDialog
      v-model:open="dialog.open"
      :variant="dialog.variant"
      :title="dialog.title"
      :message="dialog.message"
    >
      <template v-if="executeResult" #body>
        <div class="flex flex-col gap-2">
          <div
            v-for="erow in executeResult.rows"
            :key="erow.index"
            class="rounded-lg border border-line p-3"
          >
            <p class="mb-1 text-[11px] font-semibold text-muted">
              Row #{{ erow.index + 1 }} · {{ erow.source }} → {{ erow.destination }}
              · <span :class="erow.forward.status === 'SUCCESS' ? 'text-ok' : 'text-bad'">{{ erow.forward.status }}</span>
              <template v-if="erow.reverse">
                / reverse <span :class="erow.reverse.status === 'SUCCESS' ? 'text-ok' : 'text-bad'">{{ erow.reverse.status }}</span>
              </template>
            </p>
            <div class="rounded bg-terminal p-2 font-mono text-[11px] leading-relaxed">
              <pre v-if="erow.forward.output" class="whitespace-pre-wrap break-words text-terminal-text">{{ erow.forward.output }}</pre>
              <pre v-else-if="erow.forward.error" class="whitespace-pre-wrap break-words text-bad">{{ erow.forward.error }}</pre>
              <pre v-if="erow.reverse?.output" class="whitespace-pre-wrap break-words text-terminal-text">{{ erow.reverse.output }}</pre>
              <pre v-else-if="erow.reverse?.error" class="whitespace-pre-wrap break-words text-bad">{{ erow.reverse.error }}</pre>
            </div>
          </div>
        </div>
      </template>
    </ResultDialog>
  </div>
</template>
