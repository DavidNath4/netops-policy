<script setup lang="ts">
// Add Route form (mock data via useApi()). Wired to live /api/routes on
// task 13.2. Collects the route fields, shows a client-side command preview,
// and creates the route then returns to the list.
// _Requirements: 6.1, 6.2, 6.3, 6.8, 13.1, 13.2, 13.3, 13.4_
import type { CreateRouteInput, PolicyStatus } from '~/utils/api-types'

const api = useApi()

interface RouteForm {
  name: string
  source: string
  destination: string
  nextHop: string
  policy: string
  timeStart: string
  timeEnd: string
  changeTicket: string
}

const form = reactive<RouteForm>({
  name: '',
  source: '',
  destination: '',
  nextHop: '',
  policy: '',
  timeStart: '',
  timeEnd: '',
  changeTicket: '',
})

const errors = reactive<Record<string, string | undefined>>({})
const submitting = ref(false)
const submitError = ref<string | null>(null)

// NOTE: CLIENT-SIDE PREVIEW ONLY. Per Requirement 6.8 the authoritative command
// is SERVER-GENERATED and returned by the API (wired in task 13.2); the client
// never sets generatedCommand. This preview just shows the likely command shape
// while the operator fills in the form.
const commandPreview = computed(() => {
  const dest = form.destination.trim()
  const hop = form.nextHop.trim()
  if (!dest || !hop) return '# Enter a destination and next hop to preview the command'
  let cmd = `ip route ${dest} ${hop}`
  if (form.policy.trim()) cmd += `\npolicy ${form.policy.trim()}`
  if (form.timeStart && form.timeEnd) {
    cmd += `\ntime-range ${form.timeStart} to ${form.timeEnd}`
  }
  return cmd
})

/** Validate required fields; returns true when the form is valid. */
function validate(): boolean {
  for (const key of Object.keys(errors)) delete errors[key]

  if (!form.name.trim()) errors.name = 'Route name is required.'
  if (!form.destination.trim()) errors.destination = 'Destination is required.'
  if (!form.nextHop.trim()) errors.nextHop = 'Next hop is required.'

  return Object.keys(errors).length === 0
}

async function submit() {
  submitError.value = null
  if (!validate()) return

  submitting.value = true
  try {
    // generatedCommand / createdBy / status etc. are Server_Controlled_Fields
    // and are intentionally excluded from CreateRouteInput.
    const input: CreateRouteInput = {
      name: form.name.trim(),
      destination: form.destination.trim(),
      source: form.source.trim() || undefined,
      nextHop: form.nextHop.trim(),
      policy: form.policy.trim() || undefined,
      timeStart: form.timeStart.trim() || undefined,
      timeEnd: form.timeEnd.trim() || undefined,
      changeTicket: form.changeTicket.trim() || undefined,
      status: 'DRAFT' as PolicyStatus,
    }
    await api.routes.create(input)
    await navigateTo('/routes')
  }
  catch (e) {
    submitError.value = e instanceof Error ? e.message : 'Failed to add route.'
  }
  finally {
    submitting.value = false
  }
}

// Shared input classes (white input, border-line, rounded-6px).
const inputClass
  = 'h-[38px] w-full rounded-md border border-line bg-panel px-3 text-xs text-ink outline-none focus:border-brand'
</script>

<template>
  <div class="flex flex-col gap-6">
    <PageHeader title="Add Route" description="Define a route with policy and traceability.">
      <template #actions>
        <NuxtLink
          to="/routes"
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

    <form class="flex flex-col gap-6" @submit.prevent="submit">
      <!-- 2-column field grid -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Route" name="name" :error="errors.name" required>
          <template #default="{ id, invalid, describedBy }">
            <input
              :id="id"
              v-model="form.name"
              type="text"
              :aria-invalid="invalid"
              :aria-describedby="describedBy"
              placeholder="e.g. route-to-dc2"
              :class="inputClass"
            >
          </template>
        </FormField>

        <FormField label="Source" name="source">
          <template #default="{ id }">
            <input
              :id="id"
              v-model="form.source"
              type="text"
              placeholder="e.g. 10.0.0.0/24 (optional)"
              :class="inputClass"
            >
          </template>
        </FormField>

        <FormField label="Destination" name="destination" :error="errors.destination" required>
          <template #default="{ id, invalid, describedBy }">
            <input
              :id="id"
              v-model="form.destination"
              type="text"
              :aria-invalid="invalid"
              :aria-describedby="describedBy"
              placeholder="e.g. 192.168.10.0/24"
              :class="inputClass"
            >
          </template>
        </FormField>

        <FormField label="Next Hop" name="nextHop" :error="errors.nextHop" required>
          <template #default="{ id, invalid, describedBy }">
            <input
              :id="id"
              v-model="form.nextHop"
              type="text"
              :aria-invalid="invalid"
              :aria-describedby="describedBy"
              placeholder="e.g. 10.0.0.1"
              :class="inputClass"
            >
          </template>
        </FormField>

        <FormField label="Policy" name="policy">
          <template #default="{ id }">
            <input
              :id="id"
              v-model="form.policy"
              type="text"
              placeholder="e.g. default (optional)"
              :class="inputClass"
            >
          </template>
        </FormField>

        <FormField label="Ticket" name="changeTicket">
          <template #default="{ id }">
            <input
              :id="id"
              v-model="form.changeTicket"
              type="text"
              placeholder="e.g. CHG-00123 (optional)"
              :class="inputClass"
            >
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
      </div>

      <!-- Command Result terminal -->
      <div class="flex flex-col gap-3">
        <h2 class="text-base font-semibold text-ink">Command Result</h2>
        <div class="rounded-lg bg-terminal p-4 font-mono text-xs leading-relaxed text-terminal-text">
          <pre class="whitespace-pre-wrap break-all">{{ commandPreview }}</pre>
        </div>
        <!-- Req 6.8: the authoritative command is generated by the server on save. -->
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
          Validate &amp; Add Route
        </button>
      </div>
    </form>
  </div>
</template>
