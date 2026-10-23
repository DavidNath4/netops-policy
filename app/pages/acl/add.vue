<script setup lang="ts">
// Add ACL Policy — Generate (server preview, redacted) → Execute (via n8n) flow.
// Fields follow the n8n acl/add contract: source + destination (IP + mask),
// plus execution credentials (user/pass). The command is previewed server-side
// (credentials shown only as ***), then on explicit confirmation the field
// payload is sent to n8n.
import type { AclPreviewInput } from '#shared/schemas/acl.schema'
import type { ItopTicketSummary } from '#shared/schemas/itop.schema'
import type { OperationResult } from '#shared/schemas/n8n.schema'
import type { TimeRangeObject } from '#shared/schemas/time-range.schema'
import { autoCorrectAclIp, isValidIpv4 } from '#shared/schemas/network.schema'

definePageMeta({ middleware: 'permission', permission: 'ACL_POLICIES_ADD' })

const api = useApi()

// Existing on-device time-range objects for the "Select Existing" dropdown.
// The n8n `time/show` webhook now authenticates, so the catalog can no longer be
// fetched on mount (no credentials yet) — it is loaded on demand once the Add
// page's device credentials (Username + Password) are filled and the engineer
// is in "Select Existing" mode. `timeRangeLoaded` guards against re-fetching the
// same credentials repeatedly; a credential change invalidates it (see watcher).
const timeRangeObjects = ref<TimeRangeObject[]>([])
const timeRangeLoading = ref(false)
const timeRangeLoadError = ref(false)
const timeRangeLoaded = ref(false)

/** True once both device-credential fields are filled on this page. */
const credsForTimeRangeFilled = computed(() =>
  form.execUsername.trim() !== '' && form.execPassword !== '',
)

/**
 * Load the on-device time-range catalog using the credentials typed on this
 * page. No-op when credentials are missing or the catalog was already loaded for
 * the current credentials. Never throws (server returns an empty list on any
 * failure); `timeRangeLoadError` flips so the UI can suggest "Create New".
 */
async function loadTimeRanges() {
  if (!credsForTimeRangeFilled.value || timeRangeLoaded.value || timeRangeLoading.value) return
  timeRangeLoading.value = true
  timeRangeLoadError.value = false
  try {
    const { objects } = await api.aclOps.timeRanges({
      execUsername: form.execUsername,
      execPassword: form.execPassword,
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

/** The end-detail line shown under each object name (fallback to raw config). */
function timeRangeDetail(o: TimeRangeObject): string {
  if (o.endDate || o.endTime) {
    return `ends ${o.endDate ?? '?'} ${o.endTime ?? ''}`.trim()
  }
  return o.rawConfig ?? ''
}

// Items for the searchable Select Existing dropdown. Built once from the loaded
// catalog (no extra API hit — the search filters this in-memory list). Each item
// carries the object `name` as its value plus a `detail` line (end date/time or
// raw config) rendered as a small description; both are searchable.
const timeRangeItems = computed(() =>
  timeRangeObjects.value.map(o => ({
    label: o.name,
    detail: timeRangeDetail(o),
    value: o.name,
  })),
)

const form = reactive({
  source: '',
  sourceMask: '',
  destination: '',
  destinationMask: '',
  changeTicket: '',
  execUsername: '',
  execPassword: '',
  // Optional time-range (ACL ADD only). `enabled` toggles the extra fields; it
  // then runs in ONE of two modes:
  // - 'existing' (default): pick an on-device object by name (`timeRangeObject`).
  // - 'new': define a new object — `date` (ISO yyyy-mm-dd) is required and
  //   `time` is typed manually (HH:mm, 24h), defaulting to 23:59.
  timeRangeEnabled: false,
  timeRangeMode: 'existing' as 'existing' | 'new',
  timeRangeObject: '',
  timeRangeDate: '',
  timeRangeTime: '23:59',
  // Bidirectional ADD (ACL ADD only): when on, the server ALSO adds the reverse
  // direction (source/destination + masks swapped) as a second independent
  // call. This checkbox reflects the user's INTENT and is never auto-toggled —
  // even when the pre-check finds one direction already exists, the plan below
  // narrows what actually runs while the checkbox stays as the user set it.
  bidirectional: false,
})

// Seed execUsername/execPassword from the global head-bar credentials.
useAutofillDeviceCreds(form)

// Which direction(s) the generated preview covers and the next Execute will
// send. Set by onGenerate from the four pre-check cases; a plain one-way ADD
// uses 'forward'. 'both' sends bidirectional:true; 'forward'/'reverse' send a
// normal one-way ADD (reverse = source/destination swapped).
type RunPlan = 'forward' | 'reverse' | 'both'
const runPlan = ref<RunPlan>('forward')

const showPassword = ref(false)

// Change ticket is picked from iTop (read-only); form.changeTicket holds the
// selected ref (the audited/submitted value), selectedTicket the richer summary.
const ticketModalOpen = ref(false)
const selectedTicket = ref<ItopTicketSummary | null>(null)
function onTicketSelected(t: ItopTicketSummary) {
  selectedTicket.value = t
  form.changeTicket = t.ref
}

// Build the field payload for preview/execute (ADD). The time-range unit is
// included ONLY when the toggle is on and the active mode has a value; otherwise
// it is omitted so the body stays { source, destination, ... } as today.
// - 'existing' → { mode: 'existing', objectName } (server sends ONLY the name).
// - 'new'      → { mode: 'new', date, time } (server derives objectName/date/time).
type AddTimeRange = Extract<AclPreviewInput, { operation: 'ADD' }>['timeRange']
function buildPayload(plan: RunPlan = runPlan.value): AclPreviewInput {
  let timeRange: AddTimeRange
  if (form.timeRangeEnabled) {
    if (form.timeRangeMode === 'existing' && form.timeRangeObject) {
      timeRange = { mode: 'existing', objectName: form.timeRangeObject }
    }
    else if (form.timeRangeMode === 'new' && form.timeRangeDate) {
      timeRange = { mode: 'new', date: form.timeRangeDate, time: form.timeRangeTime || '23:59' }
    }
  }
  const src = form.source.trim()
  const srcMask = form.sourceMask.trim() || undefined
  const dst = form.destination.trim()
  const dstMask = form.destinationMask.trim() || undefined

  // 'reverse' = add the swapped direction only, as a normal one-way ADD.
  // 'both'    = one request with bidirectional:true (server runs both).
  // 'forward' = ordinary one-way ADD (today's behavior).
  if (plan === 'reverse') {
    return {
      operation: 'ADD',
      source: dst,
      sourceMask: dstMask,
      destination: src,
      destinationMask: srcMask,
      changeTicket: form.changeTicket,
      execUsername: form.execUsername,
      execPassword: form.execPassword,
      timeRange,
    }
  }

  return {
    operation: 'ADD',
    source: src,
    sourceMask: srcMask,
    destination: dst,
    destinationMask: dstMask,
    changeTicket: form.changeTicket,
    execUsername: form.execUsername,
    execPassword: form.execPassword,
    timeRange,
    bidirectional: plan === 'both' || undefined,
  }
}

// Auto-correct Source/Destination on blur: ticket IPs on the 10.197.x scheme are
// rewritten to the real device 10.71.x scheme (first three octets mapped, 4th
// kept). Non-matching or invalid input is left as typed. The server re-applies
// the same mapping, so preview/execute always use the corrected IP.
function correctSource() {
  form.source = autoCorrectAclIp(form.source)
}
function correctDestination() {
  form.destination = autoCorrectAclIp(form.destination)
}

const { aclExists } = useOpsPrecheck()

const preview = ref<string | null>(null)
const generating = ref(false)
const executing = ref(false)
const confirmOpen = ref(false)
const result = ref<OperationResult | null>(null)

// The IP (+ optional mask) pair processed by each direction of the last execute,
// captured BEFORE resetFields() wipes the form so the result pop-up can show
// exactly what succeeded. `reverse` is set only on a bidirectional run.
// IPs are run through autoCorrectAclIp to mirror the server's correction.
const resultDirections = ref<{ forward: string, reverse: string | null } | null>(null)

/** Format an "IP mask" endpoint (mask omitted when blank). */
function fmtEndpoint(ip: string, mask: string): string {
  const ipC = autoCorrectAclIp(ip.trim())
  const m = mask.trim()
  return m ? `${ipC} ${m}` : ipC
}

/** "src → dst" line for one direction, using the corrected IPs. */
function fmtDirection(srcIp: string, srcMask: string, dstIp: string, dstMask: string): string {
  return `${fmtEndpoint(srcIp, srcMask)} → ${fmtEndpoint(dstIp, dstMask)}`
}

// Single result/alert pop-up driving ResultDialog; replaces the two in-page
// UAlert (error/warning) blocks. `showDialog` opens it with a variant + copy.
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

// Invalidate a stale preview whenever the form changes. The run plan is
// recomputed by onGenerate; reset it so a stale plan never leaks into Execute.
watch(form, () => {
  preview.value = null
  result.value = null
  resultDirections.value = null
  runPlan.value = 'forward'
})

// Device credentials drive the time-range fetch, so a credential change
// invalidates the loaded catalog (it was fetched as a different engineer).
// Clearing `timeRangeLoaded` lets the auto-load watcher re-fetch when both
// fields are filled again.
watch([() => form.execUsername, () => form.execPassword], () => {
  timeRangeLoaded.value = false
  timeRangeObjects.value = []
  timeRangeLoadError.value = false
})

// Auto-load the catalog the moment the engineer is in "Select Existing" mode
// (with the time range enabled) AND both credentials are filled. Running on
// demand keeps credentials sourced from THIS page and avoids fetching for an
// operator who only ever uses "Create New". `immediate` covers the case where
// credentials are already filled when the mode is switched on.
watch(
  () => form.timeRangeEnabled && form.timeRangeMode === 'existing' && credsForTimeRangeFilled.value,
  (ready) => {
    if (ready) void loadTimeRanges()
  },
  { immediate: true },
)

// Block submit on malformed IPs (defense-in-depth; the server re-validates too).
const ipsValid = computed(() =>
  isValidIpv4(form.source) && isValidIpv4(form.destination),
)

// Generate runs an n8n pre-check (acl/show) that now authenticates with the
// credentials typed on THIS page, so both must be filled before Generate.
const credsFilled = computed(() =>
  form.execUsername.trim() !== '' && form.execPassword !== '',
)

// Time is typed manually (no rolling picker). Keep only digits and a single ":",
// clamp to HH:mm shape (2 digits + ":" + 2 digits). The server re-validates.
function onTimeInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  let digits = raw.replace(/\D/g, '').slice(0, 4) // HHmm, at most 4 digits
  if (digits.length > 2) digits = `${digits.slice(0, 2)}:${digits.slice(2)}`
  form.timeRangeTime = digits
}

// HH:mm in 24-hour form. Empty is treated as "use the 23:59 default".
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const timeFormatValid = computed(() =>
  form.timeRangeTime === '' || TIME_RE.test(form.timeRangeTime),
)

// When the time range is enabled it must be complete for the active mode:
// - 'existing' → an object must be selected.
// - 'new'      → a date must be picked and, if a time was typed, it must be a
//   valid HH:mm (an empty time falls back to 23:59, so it never blocks).
// When disabled, the time range never blocks Generate.
const timeRangeValid = computed(() => {
  if (!form.timeRangeEnabled) return true
  if (form.timeRangeMode === 'existing') return form.timeRangeObject !== ''
  return form.timeRangeDate !== '' && timeFormatValid.value
})

async function onGenerate() {
  result.value = null
  if (!ipsValid.value) {
    showDialog('error', 'Invalid input', 'Enter a valid IPv4 address for Source and Destination.')
    return
  }
  // Block identical endpoints: Source and Destination may not resolve to the
  // same IPv4 address. Compare AFTER auto-correction (ticket IP vs its corrected
  // form), so this runs for both one-way and bidirectional before any pre-check.
  if (autoCorrectAclIp(form.source.trim()) === autoCorrectAclIp(form.destination.trim())) {
    showDialog(
      'warning',
      'Source dan Destination sama',
      'Source dan Destination tidak boleh menggunakan IP yang sama. Perbaiki salah satu alamat sebelum melanjutkan.',
    )
    return
  }
  generating.value = true
  try {
    if (form.bidirectional) {
      // Bidirectional pre-check: look up BOTH directions. The checkbox stays ON
      // in every case; `runPlan` narrows what actually runs so an already-present
      // direction is skipped rather than re-added.
      const creds = { execUsername: form.execUsername, execPassword: form.execPassword }
      const [forwardExists, reverseExists] = await Promise.all([
        aclExists(form.source, form.destination, creds),
        aclExists(form.destination, form.source, creds),
      ])

      if (forwardExists && reverseExists) {
        // Both present: nothing to do. Stop without a preview.
        preview.value = null
        showDialog(
          'warning',
          'ACL sudah ada',
          'Kedua arah (Source → Destination dan sebaliknya) sudah ada di perangkat. Untuk mengganti subnet atau time range-nya, hapus dulu entri yang ada melalui menu Delete ACL, lalu tambahkan kembali.',
        )
        return
      }
      if (forwardExists) {
        // Only forward exists → add the reverse direction only (normal ADD).
        runPlan.value = 'reverse'
        showDialog(
          'warning',
          'One direction skipped',
          'Source → destination already exists and will be skipped; only destination → source will be added.',
        )
        const { preview: text } = await api.aclOps.preview(buildPayload('reverse'))
        preview.value = text
        return
      }
      if (reverseExists) {
        // Only reverse exists → add the forward direction only (normal ADD).
        runPlan.value = 'forward'
        showDialog(
          'warning',
          'One direction skipped',
          'Destination → source already exists and will be skipped; only source → destination will be added.',
        )
        const { preview: text } = await api.aclOps.preview(buildPayload('forward'))
        preview.value = text
        return
      }
      // Neither exists → add both directions in one server-looped request.
      runPlan.value = 'both'
      const { preview: text } = await api.aclOps.preview(buildPayload('both'))
      preview.value = text
      return
    }

    // One-way ADD (checkbox off): today's exact behavior.
    runPlan.value = 'forward'
    const exists = await aclExists(form.source, form.destination, {
      execUsername: form.execUsername,
      execPassword: form.execPassword,
    })
    if (exists) {
      showDialog(
        'warning',
        'ACL sudah ada',
        'ACL untuk Source → Destination ini sudah ada di perangkat. Untuk mengganti subnet atau time range-nya, hapus dulu entri yang ada melalui menu Delete ACL, lalu tambahkan kembali.',
      )
      return
    }
    const { preview: text } = await api.aclOps.preview(buildPayload('forward'))
    preview.value = text
  }
  catch (e) {
    showDialog('error', 'Generate failed', toMessage(e, 'Failed to generate the command preview.'))
  }
  finally {
    generating.value = false
  }
}

/** Clear every form field (after a successful execute). */
function resetFields() {
  form.source = ''
  form.sourceMask = ''
  form.destination = ''
  form.destinationMask = ''
  form.changeTicket = ''
  form.execUsername = ''
  form.execPassword = ''
  form.timeRangeEnabled = false
  form.timeRangeMode = 'existing'
  form.timeRangeObject = ''
  form.timeRangeDate = ''
  form.timeRangeTime = '23:59'
  form.bidirectional = false
  runPlan.value = 'forward'
  selectedTicket.value = null
}

async function onExecuteConfirmed() {
  executing.value = true
  try {
    // ONE request matching the plan: 'both' → bidirectional:true (the server
    // loops both directions); 'forward'/'reverse' → a normal one-way ADD.
    // Execute is never called twice from the client.
    const res = await api.aclOps.execute(buildPayload())
    confirmOpen.value = false
    // Capture which IP (+ mask) pairs were processed BEFORE the form is reset,
    // so the pop-up shows the exact directions that ran. 'reverse' is the only
    // plan that sends the swapped direction as the single/forward run; 'both'
    // adds the swapped direction as the nested reverse result.
    const plan = runPlan.value
    const forwardLine = plan === 'reverse'
      ? fmtDirection(form.destination, form.destinationMask, form.source, form.sourceMask)
      : fmtDirection(form.source, form.sourceMask, form.destination, form.destinationMask)
    const reverseLine = res.reverse
      ? fmtDirection(form.destination, form.destinationMask, form.source, form.sourceMask)
      : null
    // Combined outcome: the whole operation is a failure if EITHER direction
    // failed (the reverse direction is present only on a bidirectional run).
    const allOk = res.status === 'SUCCESS' && (!res.reverse || res.reverse.status === 'SUCCESS')
    // On overall success, clear the form fields. The form watcher wipes
    // `result`/`preview` when the fields change, so re-assign `result` after the
    // reset settles to keep the output visible on an emptied form.
    if (allOk) {
      resetFields()
      await nextTick()
    }
    result.value = res
    resultDirections.value = { forward: forwardLine, reverse: reverseLine }
    showDialog(
      allOk ? 'success' : 'error',
      allOk ? 'Execution succeeded' : 'Execution failed',
      allOk ? 'The ACL command executed via automation.' : 'The ACL command could not be completed.',
    )
  }
  catch (e) {
    confirmOpen.value = false
    showDialog('error', 'Execution failed', toMessage(e, 'Execution failed.'))
  }
  finally {
    executing.value = false
  }
}

const inputClass
  = 'h-[38px] w-full rounded-md border border-line bg-panel px-3 text-xs text-ink outline-none focus:border-brand disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted'
</script>

<template>
  <div class="flex flex-col gap-6" style="zoom: 1.3">
    <PageHeader
      title="Add ACL Policy"
      description="Fill the fields, generate the command, then execute via automation."
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
      <!-- Execution credentials (forwarded to automation; never stored). -->
      
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Username" name="execUsername" required>
            <template #default="{ id }">
              <UInput
                :id="id"
                v-model="form.execUsername"
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
                v-model="form.execPassword"
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

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Source" name="source" required>
          <template #default="{ id }">
            <IpInput :id="id" v-model="form.source" placeholder="e.g. 10.100.100.100" @blur="correctSource" />
          </template>
        </FormField>

        <FormField label="Source Mask" name="sourceMask">
          <template #default="{ id }">
            <MaskInput :id="id" v-model="form.sourceMask" />
          </template>
        </FormField>

        <FormField label="Destination" name="destination" required>
          <template #default="{ id }">
            <IpInput :id="id" v-model="form.destination" placeholder="e.g. 10.200.200.200" @blur="correctDestination" />
          </template>
        </FormField>

        <FormField label="Destination Mask" name="destinationMask">
          <template #default="{ id }">
            <MaskInput :id="id" v-model="form.destinationMask" />
          </template>
        </FormField>

        <FormField label="Ticket Change" name="changeTicket" required>
          <template #default="{ id }">
            <div class="flex items-center gap-2">
              <input
                :id="id"
                :value="form.changeTicket"
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
            <p v-if="!form.changeTicket" class="mt-1 text-[11px] text-muted">
              Select a change ticket to enable Generate.
            </p>
          </template>
        </FormField>

        <!-- Optional time range (ACL ADD only), sits beside Ticket Change. The
             enable toggle lives on the LABEL row (like other fields' labels) so
             the date/time inputs align with the "Select ticket" control next to
             them. When off, the ADD body stays { user, pass, source, destination }
             exactly as today; when on, the picked date + typed time flow to the
             server, which derives the three exact n8n keys. -->
        <div class="flex flex-col gap-1.5">
          <label class="flex items-center gap-2 text-sm font-medium text-ink">
            <input
              v-model="form.timeRangeEnabled"
              type="checkbox"
              class="size-3.5 rounded border-line text-brand focus:ring-brand"
            >
            Time Range (optional)
          </label>

          <!-- Two modes, tabbed. Select Existing is the default/first tab (pick
               an object already on the device); Create New is second (today's
               date + HH:mm, which the server derives into a new object). Only
               shown while the checkbox is on. -->
          <template v-if="form.timeRangeEnabled">
            <div
              class="grid grid-cols-2 gap-1 rounded-md border border-line bg-surface p-1"
              role="tablist"
              aria-label="Time Range mode"
            >
              <button
                type="button"
                role="tab"
                :aria-selected="form.timeRangeMode === 'existing'"
                class="rounded px-3 py-1.5 text-xs font-semibold transition-colors"
                :class="form.timeRangeMode === 'existing' ? 'bg-panel text-brand shadow-sm' : 'text-muted hover:text-ink'"
                @click="form.timeRangeMode = 'existing'"
              >
                Select Existing
              </button>
              <button
                type="button"
                role="tab"
                :aria-selected="form.timeRangeMode === 'new'"
                class="rounded px-3 py-1.5 text-xs font-semibold transition-colors"
                :class="form.timeRangeMode === 'new' ? 'bg-panel text-brand shadow-sm' : 'text-muted hover:text-ink'"
                @click="form.timeRangeMode = 'new'"
              >
                Create New
              </button>
            </div>

            <!-- Select Existing: searchable combobox over the catalog loaded on
                 demand (once Username + Password are filled and this mode is
                 active; the n8n time/show webhook now authenticates). The search
                 filters this in-memory list (name + detail) — it never hits the
                 API again. The panel shows ~10 rows then scrolls (max-height on
                 the content viewport). -->
            <div v-if="form.timeRangeMode === 'existing'" class="flex flex-col gap-1">
              <USelectMenu
                v-model="form.timeRangeObject"
                :items="timeRangeItems"
                value-key="value"
                label-key="label"
                :filter-fields="['label', 'detail']"
                :search-input="{ placeholder: 'Search time range...' }"
                placeholder="Select time range..."
                color="neutral"
                variant="outline"
                class="w-full"
                aria-label="Time range object"
                :ui="{
                  base: 'bg-panel text-ink ring-line',
                  content: 'bg-panel ring-line',
                  viewport: 'max-h-[20rem]',
                }"
              >
                <template #item-label="{ item }">
                  <div class="flex flex-col">
                    <span class="text-xs text-ink">{{ item.label }}</span>
                    <span v-if="item.detail" class="text-[10px] text-muted">{{ item.detail }}</span>
                  </div>
                </template>
              </USelectMenu>
              <p v-if="!credsForTimeRangeFilled" class="text-[11px] text-muted">
                Isi Username &amp; Password dulu untuk memuat daftar time range dari perangkat.
              </p>
              <p v-else-if="timeRangeLoading" class="text-[11px] text-muted">
                Loading existing time range objects...
              </p>
              <p v-else-if="timeRangeLoadError || timeRangeObjects.length === 0" class="text-[11px] text-muted">
                No existing time range objects could be loaded. Use Create New instead.
              </p>
              <p v-else class="text-[11px] text-muted">
                Select a previously created time range object.
              </p>
            </div>

            <!-- Create New: unchanged date + HH:mm behavior. -->
            <div v-else class="flex flex-col gap-1">
              <div class="flex items-center gap-2">
                <input
                  v-model="form.timeRangeDate"
                  type="date"
                  aria-label="Time range date"
                  :class="inputClass"
                >
                <input
                  v-model="form.timeRangeTime"
                  type="text"
                  inputmode="numeric"
                  maxlength="5"
                  placeholder="23:59"
                  aria-label="Time range time (HH:mm, 24-hour)"
                  :class="[inputClass, 'w-24', !timeFormatValid ? 'border-bad' : '']"
                  @input="onTimeInput"
                >
              </div>
              <p v-if="!form.timeRangeDate" class="text-[11px] text-muted">
                Pick a date; time defaults to 23:59.
              </p>
              <p v-else-if="!timeFormatValid" class="text-[11px] text-bad" role="alert">
                Time must be HH:mm (24-hour), e.g. 23:59.
              </p>
            </div>
          </template>
        </div>
      </div>

      <ItopTicketModal v-model="ticketModalOpen" @selected="onTicketSelected" />

      <!-- Bidirectional toggle (ACL ADD only). Styled like the Time Range enable
           row: a label-row checkbox. Lives OUTSIDE the fields grid, below Ticket
           Change and above Generate. Reflects intent only — it is never toggled
           by the pre-check; the run plan decides which direction(s) actually run. -->
      <label class="flex items-center gap-2 text-sm font-medium text-ink">
        <input
          v-model="form.bidirectional"
          type="checkbox"
          class="size-3.5 rounded border-line text-brand focus:ring-brand"
        >
        Bidirectional (also add destination → source, masks swapped)
      </label>

      <!-- Generated command preview + primary action -->
      <div class="flex flex-col gap-3">
        <h2 class="text-base font-semibold text-ink">Generated Command</h2>
        <div class="rounded-lg bg-terminal p-4 font-mono text-xs leading-relaxed text-terminal-text">
          <pre v-if="preview" class="whitespace-pre-wrap break-all">{{ preview }}</pre>
          <p v-else class="text-terminal-text/60">Fill the form and click Generate to preview the command.</p>
        </div>

        <div class="flex justify-end gap-2">
          <button
            v-if="!preview"
            type="submit"
            :disabled="generating || !credsFilled || !ipsValid || !form.changeTicket || !timeRangeValid"
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
            Execute Command
          </button>
        </div>
      </div>
    </form>

    <ConfirmDialog
      v-model="confirmOpen"
      title="Execute ACL command?"
      message="This will run the previewed command on the target device via automation. This action changes device configuration."
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
      <template v-if="result" #body>
        <div class="flex flex-col gap-3">
          <!-- Primary direction. The heading reads "Source → Destination" and the
               body line shows the exact IP (+ mask) pair that was processed, so
               the operator sees what succeeded even when the device returns no
               output. When a reverse result is present the heading labels it. -->
          <div class="flex flex-col gap-1.5">
            <p v-if="result.reverse" class="text-[11px] font-semibold text-muted">
              Source → Destination · {{ result.status }}
            </p>
            <div class="rounded-lg bg-terminal p-4 font-mono text-xs leading-relaxed">
              <pre v-if="resultDirections" class="whitespace-pre-wrap break-all text-terminal-text">{{ resultDirections.forward }}</pre>
              <pre v-if="result.output" class="whitespace-pre-wrap break-all text-terminal-text">{{ result.output }}</pre>
              <pre v-else-if="result.error" class="whitespace-pre-wrap break-all text-bad">{{ result.error }}</pre>
            </div>
          </div>

          <!-- Reverse direction (bidirectional runs only): its own status + the
               swapped IP (+ mask) pair. Heading also reads "Source → Destination"
               per the requested copy. -->
          <div v-if="result.reverse" class="flex flex-col gap-1.5">
            <p class="text-[11px] font-semibold text-muted">
              Source → Destination · {{ result.reverse.status }}
            </p>
            <div class="rounded-lg bg-terminal p-4 font-mono text-xs leading-relaxed">
              <pre v-if="resultDirections?.reverse" class="whitespace-pre-wrap break-all text-terminal-text">{{ resultDirections.reverse }}</pre>
              <pre v-if="result.reverse.output" class="whitespace-pre-wrap break-all text-terminal-text">{{ result.reverse.output }}</pre>
              <pre v-else-if="result.reverse.error" class="whitespace-pre-wrap break-all text-bad">{{ result.reverse.error }}</pre>
            </div>
          </div>
        </div>
      </template>
    </ResultDialog>
  </div>
</template>
