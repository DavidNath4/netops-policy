<script setup lang="ts">
// Add ACL Policy — Generate (server preview, redacted) → Execute (via n8n) flow.
// Fields follow the n8n acl/add contract: source + destination (IP + mask),
// plus execution credentials (user/pass). The command is previewed server-side
// (credentials shown only as ***), then on explicit confirmation the field
// payload is sent to n8n.
import type { AclPreviewInput } from '#shared/schemas/acl.schema'
import type { ItopTicketSummary } from '#shared/schemas/itop.schema'
import type { OperationResult } from '#shared/schemas/n8n.schema'
import { autoCorrectAclIp, isValidIpv4 } from '#shared/schemas/network.schema'

definePageMeta({ middleware: 'permission', permission: 'ACL_POLICIES_ADD' })

const api = useApi()

const form = reactive({
  source: '',
  sourceMask: '',
  destination: '',
  destinationMask: '',
  changeTicket: '',
  execUsername: '',
  execPassword: '',
  // Optional time-range (ACL ADD only). `enabled` toggles the extra fields;
  // when on, `date` (ISO yyyy-mm-dd) is required and `time` is typed manually
  // (HH:mm, 24h) and defaults to 23:59.
  timeRangeEnabled: false,
  timeRangeDate: '',
  timeRangeTime: '23:59',
  // Bidirectional ADD (ACL ADD only): when on, the server ALSO adds the reverse
  // direction (source/destination + masks swapped) as a second independent
  // call. This checkbox reflects the user's INTENT and is never auto-toggled —
  // even when the pre-check finds one direction already exists, the plan below
  // narrows what actually runs while the checkbox stays as the user set it.
  bidirectional: false,
})

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
// included ONLY when the toggle is on and a date is picked; otherwise the three
// keys are omitted entirely so the body stays { source, destination, ... } as
// today. The server derives the exact wire format (objectName/date/time).
function buildPayload(plan: RunPlan = runPlan.value): AclPreviewInput {
  const timeRange = form.timeRangeEnabled && form.timeRangeDate
    ? { date: form.timeRangeDate, time: form.timeRangeTime || '23:59' }
    : undefined
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
  runPlan.value = 'forward'
})

// Block submit on malformed IPs (defense-in-depth; the server re-validates too).
const ipsValid = computed(() =>
  isValidIpv4(form.source) && isValidIpv4(form.destination),
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

// When the time range is enabled a date must be picked and, if a time was typed,
// it must be a valid HH:mm (an empty time falls back to 23:59, so it never
// blocks). When disabled, the time range never blocks Generate.
const timeRangeValid = computed(() =>
  !form.timeRangeEnabled || (form.timeRangeDate !== '' && timeFormatValid.value),
)

async function onGenerate() {
  result.value = null
  if (!ipsValid.value) {
    showDialog('error', 'Invalid input', 'Enter a valid IPv4 address for Source and Destination.')
    return
  }
  generating.value = true
  try {
    if (form.bidirectional) {
      // Bidirectional pre-check: look up BOTH directions. The checkbox stays ON
      // in every case; `runPlan` narrows what actually runs so an already-present
      // direction is skipped rather than re-added.
      const [forwardExists, reverseExists] = await Promise.all([
        aclExists(form.source, form.destination),
        aclExists(form.destination, form.source),
      ])

      if (forwardExists && reverseExists) {
        // Both present: nothing to do. Stop without a preview.
        preview.value = null
        showDialog('warning', 'Nothing to add', 'Both directions already exist. Nothing to add.')
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
    const exists = await aclExists(form.source, form.destination)
    if (exists) {
      showDialog('warning', 'Nothing to add', 'This ACL (source → destination) already exists. Nothing to add.')
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

          <div class="flex items-center gap-2">
            <input
              v-model="form.timeRangeDate"
              type="date"
              aria-label="Time range date"
              :disabled="!form.timeRangeEnabled"
              :class="inputClass"
            >
            <input
              v-model="form.timeRangeTime"
              type="text"
              inputmode="numeric"
              maxlength="5"
              placeholder="23:59"
              aria-label="Time range time (HH:mm, 24-hour)"
              :disabled="!form.timeRangeEnabled"
              :class="[inputClass, 'w-24', form.timeRangeEnabled && !timeFormatValid ? 'border-bad' : '']"
              @input="onTimeInput"
            >
          </div>

          <p v-if="form.timeRangeEnabled && !form.timeRangeDate" class="text-[11px] text-muted">
            Pick a date; time defaults to 23:59.
          </p>
          <p v-else-if="form.timeRangeEnabled && !timeFormatValid" class="text-[11px] text-bad" role="alert">
            Time must be HH:mm (24-hour), e.g. 23:59.
          </p>
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
            :disabled="generating || !ipsValid || !form.changeTicket || !timeRangeValid"
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
          <!-- Primary (forward) direction. When a reverse result is present this
               block is labelled so the two directions read as distinct runs. -->
          <div class="flex flex-col gap-1.5">
            <p v-if="result.reverse" class="text-[11px] font-semibold text-muted">
              Source → Destination · {{ result.status }}
            </p>
            <div class="rounded-lg bg-terminal p-4 font-mono text-xs leading-relaxed">
              <pre v-if="result.output" class="whitespace-pre-wrap break-all text-terminal-text">{{ result.output }}</pre>
              <pre v-else-if="result.error" class="whitespace-pre-wrap break-all text-bad">{{ result.error }}</pre>
            </div>
          </div>

          <!-- Reverse direction (bidirectional runs only): its own status + output. -->
          <div v-if="result.reverse" class="flex flex-col gap-1.5">
            <p class="text-[11px] font-semibold text-muted">
              Destination → Source · {{ result.reverse.status }}
            </p>
            <div class="rounded-lg bg-terminal p-4 font-mono text-xs leading-relaxed">
              <pre v-if="result.reverse.output" class="whitespace-pre-wrap break-all text-terminal-text">{{ result.reverse.output }}</pre>
              <pre v-else-if="result.reverse.error" class="whitespace-pre-wrap break-all text-bad">{{ result.reverse.error }}</pre>
            </div>
          </div>
        </div>
      </template>
    </ResultDialog>
  </div>
</template>
