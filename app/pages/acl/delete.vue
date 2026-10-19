<script setup lang="ts">
// Delete ACL Policy — Generate (server preview, redacted) → Execute (via n8n).
// Fields follow the n8n acl/delete contract: source + destination (IP + mask),
// plus execution credentials (user/pass). Credentials show only as *** in the
// preview; the field payload is sent to n8n on explicit confirmation.
import type { AclPreviewInput } from '#shared/schemas/acl.schema'
import type { ItopTicketSummary } from '#shared/schemas/itop.schema'
import type { OperationResult } from '#shared/schemas/n8n.schema'
import { isValidIpv4 } from '#shared/schemas/network.schema'

definePageMeta({ middleware: 'permission', permission: 'ACL_POLICIES_DELETE' })

const api = useApi()

const form = reactive({
  source: '',
  sourceMask: '',
  destination: '',
  destinationMask: '',
  changeTicket: '',
  execUsername: '',
  execPassword: '',
})

const showPassword = ref(false)

// Change ticket is picked from iTop (read-only); form.changeTicket holds the
// selected ref (the audited/submitted value), selectedTicket the richer summary.
const ticketModalOpen = ref(false)
const selectedTicket = ref<ItopTicketSummary | null>(null)
function onTicketSelected(t: ItopTicketSummary) {
  selectedTicket.value = t
  form.changeTicket = t.ref
}

// Build the field payload for preview/execute (DELETE).
function buildPayload(): AclPreviewInput {
  return {
    operation: 'DELETE',
    source: form.source.trim(),
    sourceMask: form.sourceMask.trim() || undefined,
    destination: form.destination.trim(),
    destinationMask: form.destinationMask.trim() || undefined,
    changeTicket: form.changeTicket,
    execUsername: form.execUsername,
    execPassword: form.execPassword,
  }
}

const preview = ref<string | null>(null)
const { aclExists } = useOpsPrecheck()

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

// Invalidate a stale preview whenever the form changes.
watch(form, () => {
  preview.value = null
  result.value = null
})

// Block submit on malformed IPs (defense-in-depth; the server re-validates too).
const ipsValid = computed(() =>
  isValidIpv4(form.source) && isValidIpv4(form.destination),
)

async function onGenerate() {
  result.value = null
  if (!ipsValid.value) {
    showDialog('error', 'Invalid input', 'Enter a valid IPv4 address for Source and Destination.')
    return
  }
  generating.value = true
  try {
    // Pre-check: a DELETE must already exist. Look it up first.
    const exists = await aclExists(form.source, form.destination)
    if (!exists) {
      showDialog('warning', 'Nothing to delete', 'This ACL (source → destination) does not exist. Nothing to delete.')
      return
    }
    const { preview: text } = await api.aclOps.preview(buildPayload())
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
  selectedTicket.value = null
}

async function onExecuteConfirmed() {
  executing.value = true
  try {
    const res = await api.aclOps.execute(buildPayload())
    confirmOpen.value = false
    // On success, clear the form fields. The form watcher wipes `result`/`preview`
    // when the fields change, so re-assign `result` after the reset settles to
    // keep the success/failure output visible on an emptied form.
    if (res.status === 'SUCCESS') {
      resetFields()
      await nextTick()
    }
    result.value = res
    showDialog(
      res.status === 'SUCCESS' ? 'success' : 'error',
      res.status === 'SUCCESS' ? 'Execution succeeded' : 'Execution failed',
      res.status === 'SUCCESS' ? 'The ACL delete executed via automation.' : 'The ACL delete could not be completed.',
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
      title="Delete ACL Policy"
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
            <IpInput :id="id" v-model="form.source" placeholder="e.g. 10.100.100.100" />
          </template>
        </FormField>

        <FormField label="Source Mask" name="sourceMask">
          <template #default="{ id }">
            <MaskInput :id="id" v-model="form.sourceMask" />
          </template>
        </FormField>

        <FormField label="Destination" name="destination" required>
          <template #default="{ id }">
            <IpInput :id="id" v-model="form.destination" placeholder="e.g. 10.200.200.200" />
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
      </div>

      <ItopTicketModal v-model="ticketModalOpen" @selected="onTicketSelected" />

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
            :disabled="generating || !ipsValid || !form.changeTicket"
            class="inline-flex h-[38px] items-center gap-1.5 rounded-md bg-brand px-4 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-60"
          >
            <UIcon :name="generating ? 'i-lucide-loader-circle' : 'i-lucide-terminal'" class="size-4" :class="{ 'animate-spin': generating }" />
            Generate
          </button>
          <button
            v-else
            type="button"
            :disabled="executing"
            class="inline-flex h-[38px] items-center gap-1.5 rounded-md bg-bad px-4 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-60"
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
      title="Execute ACL delete?"
      message="This will remove the previewed ACL entry on the target device via automation. This action changes device configuration."
      confirm-label="Delete"
      confirm-color="error"
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
        <div class="rounded-lg bg-terminal p-4 font-mono text-xs leading-relaxed">
          <pre v-if="result.output" class="whitespace-pre-wrap break-all text-terminal-text">{{ result.output }}</pre>
          <pre v-else-if="result.error" class="whitespace-pre-wrap break-all text-bad">{{ result.error }}</pre>
        </div>
      </template>
    </ResultDialog>
  </div>
</template>
