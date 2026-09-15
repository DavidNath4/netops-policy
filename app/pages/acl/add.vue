<script setup lang="ts">
// Add ACL Policy form with a live client-side "Generated Command" preview.
// Mock-data only via useApi(); real endpoint is wired in task 13.2.
// Requirements: 4.1, 4.2, 4.3, 4.11, 13.1, 13.2, 13.3, 13.4
import type { AclAction, CreateAclInput, PolicyStatus, Protocol } from '~/utils/api-types'

definePageMeta({ middleware: 'permission', permission: 'ACL_POLICIES_ADD' })

const api = useApi()

const protocolOptions: { label: string; value: Protocol }[] = [
  { label: 'TCP', value: 'TCP' },
  { label: 'UDP', value: 'UDP' },
  { label: 'ICMP', value: 'ICMP' },
  { label: 'ANY', value: 'ANY' },
]

const actionOptions: { label: string; value: AclAction }[] = [
  { label: 'ALLOW', value: 'ALLOW' },
  { label: 'DENY', value: 'DENY' },
]

// Protocols that do not carry a port; the port field is disabled/cleared.
const PORTLESS: Protocol[] = ['ICMP', 'ANY']

interface AclForm {
  name: string
  source: string
  destination: string
  protocol: Protocol
  port: number | undefined
  action: AclAction
  timeStart: string
  timeEnd: string
  changeTicket: string
  description: string
}

const form = reactive<AclForm>({
  name: '',
  source: '',
  destination: '',
  protocol: 'TCP',
  port: undefined,
  action: 'ALLOW',
  timeStart: '',
  timeEnd: '',
  changeTicket: '',
  description: '',
})

const portDisabled = computed(() => PORTLESS.includes(form.protocol))

// Clear the port whenever the protocol becomes portless (ICMP/ANY).
watch(
  () => form.protocol,
  (proto) => {
    if (PORTLESS.includes(proto)) form.port = undefined
  },
)

// --- Live client-side command preview (UX only) ---------------------------
// NOTE: This preview is client-side ONLY, for immediate feedback while typing.
// Per Req 4.11 the real `generatedCommand` is authoritative and produced by the
// server; the API returns it on create (wired in task 13.2). We never submit
// this string — it is display-only.
const commandPreview = computed(() => {
  const name = form.name.trim() || '<name>'
  const verb = form.action === 'ALLOW' ? 'permit' : 'deny'
  const proto = form.protocol.toLowerCase()
  const source = form.source.trim() || '<source>'
  const destination = form.destination.trim() || '<destination>'
  let cmd = `access-list ${name} ${verb} ${proto} ${source} host ${destination}`
  if (!portDisabled.value && form.port != null) cmd += ` eq ${form.port}`
  if (form.timeStart && form.timeEnd) {
    cmd += `\ntime-range ${form.timeStart} to ${form.timeEnd}`
  }
  return cmd
})

// --- Validation ------------------------------------------------------------
const errors = reactive<Record<string, string>>({})

function validate(): boolean {
  for (const k of Object.keys(errors)) delete errors[k]

  if (!form.name.trim()) errors.name = 'Name is required.'
  if (!form.source.trim()) errors.source = 'Source is required.'
  if (!form.destination.trim()) errors.destination = 'Destination is required.'

  if (portDisabled.value) {
    // ICMP/ANY must not carry a port.
    if (form.port != null) errors.port = 'Port must be empty for ICMP/ANY.'
  }
  else {
    // TCP/UDP require a valid port.
    if (form.port == null) errors.port = 'Port is required for TCP/UDP.'
    else if (form.port < 1 || form.port > 65535) errors.port = 'Port must be between 1 and 65535.'
  }

  return Object.keys(errors).length === 0
}

const submitting = ref(false)
const submitError = ref<string | null>(null)

async function onSubmit() {
  submitError.value = null
  if (!validate()) return

  submitting.value = true
  try {
    const input: CreateAclInput = {
      name: form.name.trim(),
      source: form.source.trim(),
      destination: form.destination.trim(),
      protocol: form.protocol,
      port: portDisabled.value ? undefined : form.port,
      action: form.action,
      timeStart: form.timeStart || undefined,
      timeEnd: form.timeEnd || undefined,
      changeTicket: form.changeTicket.trim() || undefined,
      description: form.description.trim() || undefined,
      status: 'DRAFT' as PolicyStatus,
    }
    await api.acl.create(input)
    await navigateTo('/acl')
  }
  catch (e) {
    submitError.value = e instanceof Error ? e.message : 'Failed to create ACL policy.'
  }
  finally {
    submitting.value = false
  }
}

// Shared input classes (white input, border-line, rounded-6px).
const inputClass
  = 'h-[38px] w-full rounded-md border border-line bg-panel px-3 text-xs text-ink outline-none focus:border-brand disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted'
</script>

<template>
  <div class="flex flex-col gap-6">
    <PageHeader
      title="Add ACL Policy"
      description="Create an access rule and preview the generated command."
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
      v-if="submitError"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      :description="submitError"
    />

    <form class="flex flex-col gap-6" @submit.prevent="onSubmit">
      <!-- 2-column field grid -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Name" name="name" :error="errors.name" required>
          <template #default="{ id, invalid, describedBy }">
            <input
              :id="id"
              v-model="form.name"
              type="text"
              :aria-invalid="invalid"
              :aria-describedby="describedBy"
              placeholder="e.g. allow-web"
              :class="inputClass"
            >
          </template>
        </FormField>

        <FormField label="Source IP" name="source" :error="errors.source" required>
          <template #default="{ id, invalid, describedBy }">
            <input
              :id="id"
              v-model="form.source"
              type="text"
              :aria-invalid="invalid"
              :aria-describedby="describedBy"
              placeholder="e.g. 192.168.1.0/24"
              :class="inputClass"
            >
          </template>
        </FormField>

        <FormField label="Destination IP" name="destination" :error="errors.destination" required>
          <template #default="{ id, invalid, describedBy }">
            <input
              :id="id"
              v-model="form.destination"
              type="text"
              :aria-invalid="invalid"
              :aria-describedby="describedBy"
              placeholder="e.g. 10.0.0.0/24"
              :class="inputClass"
            >
          </template>
        </FormField>

        <FormField label="Protocol" name="protocol" required>
          <template #default="{ id }">
            <select :id="id" v-model="form.protocol" :class="inputClass">
              <option v-for="opt in protocolOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </template>
        </FormField>

        <FormField label="Port" name="port" :error="errors.port">
          <template #default="{ id, invalid, describedBy }">
            <input
              :id="id"
              v-model.number="form.port"
              type="number"
              min="1"
              max="65535"
              :disabled="portDisabled"
              :aria-invalid="invalid"
              :aria-describedby="describedBy"
              placeholder="e.g. 443"
              :class="inputClass"
            >
          </template>
        </FormField>

        <FormField label="Action" name="action" required>
          <template #default="{ id }">
            <select :id="id" v-model="form.action" :class="inputClass">
              <option v-for="opt in actionOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </template>
        </FormField>

        <FormField label="Start Time" name="timeStart">
          <template #default="{ id }">
            <input :id="id" v-model="form.timeStart" type="time" :class="inputClass">
          </template>
        </FormField>

        <FormField label="End Time" name="timeEnd">
          <template #default="{ id }">
            <input :id="id" v-model="form.timeEnd" type="time" :class="inputClass">
          </template>
        </FormField>

        <FormField label="Ticket Change" name="changeTicket">
          <template #default="{ id }">
            <input
              :id="id"
              v-model="form.changeTicket"
              type="text"
              placeholder="e.g. CHG-00123"
              :class="inputClass"
            >
          </template>
        </FormField>

        <FormField label="Description" name="description" class="sm:col-span-2">
          <template #default="{ id }">
            <textarea
              :id="id"
              v-model="form.description"
              rows="3"
              placeholder="Optional notes about this policy"
              :class="inputClass"
              class="!h-auto py-2"
            />
          </template>
        </FormField>
      </div>

      <!-- Generated Command terminal -->
      <div class="flex flex-col gap-3">
        <h2 class="text-base font-semibold text-ink">Generated Command</h2>
        <div class="rounded-lg bg-terminal p-4 font-mono text-xs leading-relaxed text-terminal-text">
          <pre class="whitespace-pre-wrap break-all">{{ commandPreview }}</pre>
        </div>
        <!-- Req 4.11: the authoritative command is generated by the server on save. -->
        <p class="text-[10px] text-muted">
          Preview only. The authoritative command is generated by the server on save.
        </p>
      </div>

      <div class="flex justify-end">
        <button
          type="submit"
          :disabled="submitting"
          class="inline-flex h-[38px] items-center gap-1.5 rounded-md bg-brand px-4 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-60"
        >
          <UIcon
            :name="submitting ? 'i-lucide-loader-circle' : 'i-lucide-check'"
            class="size-4"
            :class="{ 'animate-spin': submitting }"
          />
          Validate &amp; Add Policy
        </button>
      </div>
    </form>
  </div>
</template>
