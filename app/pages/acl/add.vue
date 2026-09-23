<script setup lang="ts">
// Add ACL Policy — Generate (server preview, redacted) → Execute (via n8n) flow.
// The command is previewed server-side (credentials shown only as ***), then on
// explicit confirmation the field payload is sent to n8n. Requirements: 4.1,
// 4.8, 4.9, 13.1–13.4, 13.12–13.15.
import type { AclPreviewInput } from '#shared/schemas/acl.schema'
import type { OperationResult } from '#shared/schemas/n8n.schema'
import type { AclAction, Protocol } from '~/utils/api-types'

definePageMeta({ middleware: 'permission', permission: 'ACL_POLICIES_ADD' })

const api = useApi()

const protocolOptions: { label: string, value: Protocol }[] = [
  { label: 'TCP', value: 'TCP' },
  { label: 'UDP', value: 'UDP' },
  { label: 'ICMP', value: 'ICMP' },
  { label: 'ANY', value: 'ANY' },
]
const actionOptions: { label: string, value: AclAction }[] = [
  { label: 'ALLOW', value: 'ALLOW' },
  { label: 'DENY', value: 'DENY' },
]
const PORTLESS: Protocol[] = ['ICMP', 'ANY']

const form = reactive({
  name: '',
  source: '',
  sourceMask: '',
  destination: '',
  destinationMask: '',
  protocol: 'TCP' as Protocol,
  port: undefined as number | undefined,
  action: 'ALLOW' as AclAction,
  timeRange: '',
  changeTicket: '',
  description: '',
  execUsername: '',
  execPassword: '',
})

const portDisabled = computed(() => PORTLESS.includes(form.protocol))
watch(() => form.protocol, (p) => {
  if (PORTLESS.includes(p)) form.port = undefined
})

// Build the field payload for preview/execute (ADD).
function buildPayload(): AclPreviewInput {
  return {
    operation: 'ADD',
    name: form.name.trim(),
    source: form.source.trim(),
    sourceMask: form.sourceMask.trim() || undefined,
    destination: form.destination.trim(),
    destinationMask: form.destinationMask.trim() || undefined,
    protocol: form.protocol,
    port: portDisabled.value ? undefined : form.port,
    action: form.action,
    timeRange: form.timeRange.trim() || undefined,
    changeTicket: form.changeTicket.trim() || undefined,
    description: form.description.trim() || undefined,
    execUsername: form.execUsername,
    execPassword: form.execPassword,
  } as AclPreviewInput
}

const preview = ref<string | null>(null)
const generating = ref(false)
const executing = ref(false)
const confirmOpen = ref(false)
const errorMsg = ref<string | null>(null)
const result = ref<OperationResult | null>(null)

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

async function onGenerate() {
  errorMsg.value = null
  result.value = null
  generating.value = true
  try {
    const { preview: text } = await api.aclOps.preview(buildPayload())
    preview.value = text
  }
  catch (e) {
    errorMsg.value = toMessage(e, 'Failed to generate the command preview.')
  }
  finally {
    generating.value = false
  }
}

async function onExecuteConfirmed() {
  errorMsg.value = null
  executing.value = true
  try {
    result.value = await api.aclOps.execute(buildPayload())
    confirmOpen.value = false
  }
  catch (e) {
    confirmOpen.value = false
    errorMsg.value = toMessage(e, 'Execution failed.')
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

    <UAlert
      v-if="errorMsg"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      :description="errorMsg"
    />

    <form class="flex flex-col gap-6" @submit.prevent="onGenerate">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Name" name="name" required>
          <template #default="{ id }">
            <input :id="id" v-model="form.name" type="text" placeholder="e.g. KSEI-JMP" :class="inputClass">
          </template>
        </FormField>

        <FormField label="Protocol" name="protocol" required>
          <template #default="{ id }">
            <select :id="id" v-model="form.protocol" :class="inputClass">
              <option v-for="opt in protocolOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </template>
        </FormField>

        <FormField label="Source" name="source" required>
          <template #default="{ id }">
            <input :id="id" v-model="form.source" type="text" placeholder="e.g. 10.100.100.100" :class="inputClass">
          </template>
        </FormField>

        <FormField label="Source Mask" name="sourceMask">
          <template #default="{ id }">
            <input :id="id" v-model="form.sourceMask" type="text" placeholder="e.g. 255.255.255.255" :class="inputClass">
          </template>
        </FormField>

        <FormField label="Destination" name="destination" required>
          <template #default="{ id }">
            <input :id="id" v-model="form.destination" type="text" placeholder="e.g. 10.200.200.200" :class="inputClass">
          </template>
        </FormField>

        <FormField label="Destination Mask" name="destinationMask">
          <template #default="{ id }">
            <input :id="id" v-model="form.destinationMask" type="text" placeholder="e.g. 255.255.255.255" :class="inputClass">
          </template>
        </FormField>

        <FormField label="Port" name="port">
          <template #default="{ id }">
            <input
              :id="id"
              v-model.number="form.port"
              type="number"
              min="1"
              max="65535"
              :disabled="portDisabled"
              placeholder="e.g. 443"
              :class="inputClass"
            >
          </template>
        </FormField>

        <FormField label="Action" name="action" required>
          <template #default="{ id }">
            <select :id="id" v-model="form.action" :class="inputClass">
              <option v-for="opt in actionOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </template>
        </FormField>

        <FormField label="Time Range" name="timeRange">
          <template #default="{ id }">
            <input :id="id" v-model="form.timeRange" type="text" placeholder="e.g. 31-May-26" :class="inputClass">
          </template>
        </FormField>

        <FormField label="Ticket Change" name="changeTicket">
          <template #default="{ id }">
            <input :id="id" v-model="form.changeTicket" type="text" placeholder="e.g. CHG-123456" :class="inputClass">
          </template>
        </FormField>

        <FormField label="Description" name="description" class="sm:col-span-2">
          <template #default="{ id }">
            <textarea :id="id" v-model="form.description" rows="2" placeholder="Optional notes" :class="inputClass" class="!h-auto py-2" />
          </template>
        </FormField>
      </div>

      <!-- Execution credentials (forwarded to automation; never stored). -->
      <div class="rounded-lg border border-line bg-panel p-4">
        <h2 class="mb-3 text-sm font-semibold text-ink">Execution Credentials</h2>
        <p class="mb-3 text-[11px] text-muted">
          Your device login, used only to run this command. Shown as *** in the preview and never stored.
        </p>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Username" name="execUsername" required>
            <template #default="{ id }">
              <input :id="id" v-model="form.execUsername" type="text" autocomplete="off" :class="inputClass">
            </template>
          </FormField>
          <FormField label="Password" name="execPassword" required>
            <template #default="{ id }">
              <input :id="id" v-model="form.execPassword" type="password" autocomplete="off" :class="inputClass">
            </template>
          </FormField>
        </div>
      </div>

      <!-- Generated command preview + primary action -->
      <div class="flex flex-col gap-3">
        <h2 class="text-base font-semibold text-ink">Generated Command</h2>
        <div class="rounded-lg bg-terminal p-4 font-mono text-xs leading-relaxed text-terminal-text">
          <pre v-if="preview" class="whitespace-pre-wrap break-all">{{ preview }}</pre>
          <p v-else class="text-terminal-text/60">Fill the form and click Generate to preview the command.</p>
        </div>

        <div v-if="result" class="rounded-lg bg-terminal p-4 font-mono text-xs leading-relaxed">
          <p :class="result.status === 'SUCCESS' ? 'text-ok' : 'text-bad'">
            {{ result.status === 'SUCCESS' ? '✓ Execution succeeded' : '✗ Execution failed' }}
          </p>
          <pre v-if="result.output" class="mt-1 whitespace-pre-wrap break-all text-terminal-text">{{ result.output }}</pre>
          <pre v-else-if="result.error" class="mt-1 whitespace-pre-wrap break-all text-bad">{{ result.error }}</pre>
        </div>

        <div class="flex justify-end gap-2">
          <button
            v-if="!preview"
            type="submit"
            :disabled="generating"
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
  </div>
</template>
