<script setup lang="ts">
// Add Route — Generate (server preview, redacted) → Execute (via n8n) flow.
// Mirror of the ACL add page. Requirements: 6.1, 6.6, 6.7, 13.1–13.4, 13.12–13.15.
import type { RoutePreviewInput } from '#shared/schemas/route.schema'
import type { OperationResult } from '#shared/schemas/n8n.schema'

definePageMeta({ middleware: 'permission', permission: 'ROUTES_ADD' })

const api = useApi()

const form = reactive({
  name: '',
  destination: '',
  source: '',
  nextHop: '',
  policy: '',
  timeRange: '',
  changeTicket: '',
  execUsername: '',
  execPassword: '',
})

function buildPayload(): RoutePreviewInput {
  return {
    operation: 'ADD',
    name: form.name.trim(),
    destination: form.destination.trim(),
    source: form.source.trim() || undefined,
    nextHop: form.nextHop.trim(),
    policy: form.policy.trim() || undefined,
    timeRange: form.timeRange.trim() || undefined,
    changeTicket: form.changeTicket.trim() || undefined,
    execUsername: form.execUsername,
    execPassword: form.execPassword,
  } as RoutePreviewInput
}

const preview = ref<string | null>(null)
const generating = ref(false)
const executing = ref(false)
const confirmOpen = ref(false)
const errorMsg = ref<string | null>(null)
const result = ref<OperationResult | null>(null)

function toMessage(e: unknown, fallback: string): string {
  const msg = (e as { data?: { error?: { message?: string } } })?.data?.error?.message
  if (msg) return msg
  return e instanceof Error ? e.message : fallback
}

watch(form, () => {
  preview.value = null
  result.value = null
})

async function onGenerate() {
  errorMsg.value = null
  result.value = null
  generating.value = true
  try {
    const { preview: text } = await api.routeOps.preview(buildPayload())
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
    result.value = await api.routeOps.execute(buildPayload())
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
      title="Add Route"
      description="Fill the fields, generate the command, then execute via automation."
    >
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
            <input :id="id" v-model="form.name" type="text" placeholder="e.g. to-dc2" :class="inputClass">
          </template>
        </FormField>

        <FormField label="Destination (CIDR)" name="destination" required>
          <template #default="{ id }">
            <input :id="id" v-model="form.destination" type="text" placeholder="e.g. 10.200.0.0/16" :class="inputClass">
          </template>
        </FormField>

        <FormField label="Next Hop" name="nextHop" required>
          <template #default="{ id }">
            <input :id="id" v-model="form.nextHop" type="text" placeholder="e.g. 10.71.34.1" :class="inputClass">
          </template>
        </FormField>

        <FormField label="Source" name="source">
          <template #default="{ id }">
            <input :id="id" v-model="form.source" type="text" placeholder="optional" :class="inputClass">
          </template>
        </FormField>

        <FormField label="Policy" name="policy">
          <template #default="{ id }">
            <input :id="id" v-model="form.policy" type="text" placeholder="optional" :class="inputClass">
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
      </div>

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
      title="Execute route command?"
      message="This will run the previewed command on the target device via automation. This action changes device configuration."
      confirm-label="Execute"
      confirm-color="primary"
      :loading="executing"
      @confirm="onExecuteConfirmed"
    />
  </div>
</template>
