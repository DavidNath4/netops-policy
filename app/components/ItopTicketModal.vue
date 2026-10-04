<script setup lang="ts">
// iTop ticket picker. Search the read-only iTop ticket store by ref/title,
// pick a result to preview its details, then confirm the selection. The parent
// sets form.changeTicket = ticket.ref from the `selected` event.
//
// SECURITY: iTop stores several fields as rich text and MAY contain HTML or
// script. EVERY iTop-sourced string here is rendered via escaped `{{ }}` only —
// never v-html or any raw-HTML sink.
import type { ItopTicketDetail, ItopTicketSummary } from '#shared/schemas/itop.schema'

const props = defineProps<{
  /** Controls visibility (v-model). */
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** Parent sets form.changeTicket = ticket.ref. */
  'selected': [ticket: ItopTicketSummary]
}>()

const open = computed({
  get: () => props.modelValue,
  set: v => emit('update:modelValue', v),
})

const { itop } = useApi()

const query = ref('')
const results = ref<ItopTicketSummary[]>([])
const searched = ref(false)
const searching = ref(false)
const searchError = ref<string | null>(null)

const detail = ref<ItopTicketDetail | null>(null)
const previewing = ref(false)
const previewError = ref<string | null>(null)
const activeRef = ref<string | null>(null)

function toMessage(e: unknown, fallback: string): string {
  const msg = (e as { data?: { error?: { message?: string } } })?.data?.error?.message
  if (msg) return msg
  return e instanceof Error ? e.message : fallback
}

// Reset everything each time the modal opens so no stale search/preview leaks.
watch(open, (isOpen) => {
  if (isOpen) {
    query.value = ''
    results.value = []
    searched.value = false
    searchError.value = null
    detail.value = null
    previewError.value = null
    activeRef.value = null
  }
})

async function onSearch() {
  const q = query.value.trim()
  if (!q) return
  searching.value = true
  searchError.value = null
  detail.value = null
  previewError.value = null
  activeRef.value = null
  try {
    results.value = await itop.searchTickets(q)
    searched.value = true
  }
  catch (e) {
    searchError.value = toMessage(e, 'Could not search iTop tickets.')
  }
  finally {
    searching.value = false
  }
}

async function onPick(ticket: ItopTicketSummary) {
  activeRef.value = ticket.ref
  previewing.value = true
  previewError.value = null
  detail.value = null
  try {
    detail.value = await itop.getTicket(ticket.ref)
  }
  catch (e) {
    previewError.value = toMessage(e, 'Could not load the ticket details.')
  }
  finally {
    previewing.value = false
  }
}

function onUse() {
  const d = detail.value
  if (!d) return
  emit('selected', {
    ref: d.ref,
    title: d.title,
    type: d.type,
    operationalStatus: d.operationalStatus,
    startDate: d.startDate,
    endDate: d.endDate,
  })
  open.value = false
}

// Present detail-block fields (label + value) for display, in a stable order.
const detailFields = computed(() => {
  const d = detail.value?.detail
  if (!d) return []
  const order: { key: keyof NonNullable<typeof d>, label: string }[] = [
    { key: 'status', label: 'Status' },
    { key: 'impact', label: 'Impact' },
    { key: 'priority', label: 'Priority' },
    { key: 'urgency', label: 'Urgency' },
    { key: 'origin', label: 'Origin' },
    { key: 'reason', label: 'Reason' },
    { key: 'outage', label: 'Outage' },
    { key: 'fallback', label: 'Fallback' },
    { key: 'acceptanceComment', label: 'Acceptance Comment' },
    { key: 'resolutionCode', label: 'Resolution Code' },
    { key: 'solution', label: 'Solution' },
  ]
  return order
    .map(f => ({ label: f.label, value: d[f.key] }))
    .filter((f): f is { label: string, value: string } => typeof f.value === 'string' && f.value.length > 0)
})
</script>

<template>
  <UModal v-model:open="open" title="Select Change Ticket">
    <template #body>
      <div class="flex flex-col gap-4">
        <p class="text-sm text-muted">
          Search iTop by ticket reference or title, select a ticket to preview it,
          then use it as the change ticket for this action.
        </p>

        <FormField label="Search" name="ticketSearch">
          <template #default="{ id }">
            <div class="flex items-center gap-2">
              <UInput
                :id="id"
                v-model="query"
                color="neutral"
                variant="outline"
                autocomplete="off"
                placeholder="e.g. C-035919 or part of the title"
                class="w-full"
                :ui="{ base: 'bg-panel text-ink ring-line placeholder:text-muted' }"
                @keydown.enter.prevent="onSearch"
              />
              <UButton
                color="primary"
                class="bg-brand text-white hover:bg-brand/90"
                :ui="{ label: 'text-white' }"
                icon="i-lucide-search"
                label="Search"
                :loading="searching"
                :disabled="!query.trim()"
                @click="onSearch"
              />
            </div>
          </template>
        </FormField>

        <!-- Search states -->
        <LoadingState v-if="searching" message="Searching tickets…" />
        <ErrorState
          v-else-if="searchError"
          :message="searchError"
          title="iTop search failed"
          @retry="onSearch"
        />
        <EmptyState
          v-else-if="searched && results.length === 0"
          title="No tickets found"
          description="Try a different reference or title."
          icon="i-lucide-ticket"
        />

        <!-- Results list -->
        <ul v-else-if="results.length > 0" class="flex max-h-64 flex-col gap-1 overflow-y-auto">
          <li v-for="t in results" :key="t.ref">
            <button
              type="button"
              class="flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors hover:bg-surface"
              :class="activeRef === t.ref ? 'border-brand bg-surface' : 'border-line bg-panel'"
              @click="onPick(t)"
            >
              <span class="font-mono text-xs font-semibold text-ink">{{ t.ref }}</span>
              <span class="rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] text-muted">{{ t.type }}</span>
              <span class="min-w-0 flex-1 truncate text-sm text-ink">{{ t.title }}</span>
            </button>
          </li>
        </ul>

        <!-- Preview states -->
        <LoadingState v-if="previewing" message="Loading ticket…" />
        <ErrorState
          v-else-if="previewError && activeRef"
          :message="previewError"
          title="Could not load ticket"
          :retryable="false"
        />

        <!-- Preview card -->
        <div
          v-else-if="detail"
          class="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
        >
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-mono text-sm font-semibold text-ink">{{ detail.ref }}</span>
            <span class="rounded-full border border-line bg-panel px-2 py-0.5 text-[11px] text-muted">{{ detail.type }}</span>
            <span v-if="detail.operationalStatus" class="text-[11px] text-muted">{{ detail.operationalStatus }}</span>
          </div>

          <p class="text-sm font-semibold text-ink">{{ detail.title }}</p>

          <dl class="grid grid-cols-1 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-2">
            <div v-if="detail.caller.name" class="flex gap-1">
              <dt class="text-muted">Caller:</dt>
              <dd class="text-ink">{{ detail.caller.name }}</dd>
            </div>
            <div v-if="detail.caller.email" class="flex gap-1">
              <dt class="text-muted">Email:</dt>
              <dd class="text-ink">{{ detail.caller.email }}</dd>
            </div>
            <div v-if="detail.organization.name" class="flex gap-1">
              <dt class="text-muted">Organization:</dt>
              <dd class="text-ink">{{ detail.organization.name }}</dd>
            </div>
            <div v-if="detail.startDate" class="flex gap-1">
              <dt class="text-muted">Start:</dt>
              <dd class="text-ink">{{ detail.startDate }}</dd>
            </div>
            <div v-if="detail.endDate" class="flex gap-1">
              <dt class="text-muted">End:</dt>
              <dd class="text-ink">{{ detail.endDate }}</dd>
            </div>
            <div v-for="f in detailFields" :key="f.label" class="flex gap-1">
              <dt class="text-muted">{{ f.label }}:</dt>
              <dd class="text-ink">{{ f.value }}</dd>
            </div>
          </dl>

          <div v-if="detail.description" class="flex flex-col gap-1">
            <p class="text-[11px] font-semibold uppercase tracking-wide text-muted">Description</p>
            <p class="whitespace-pre-wrap text-[13px] text-ink">{{ detail.description }}</p>
          </div>

          <div class="flex justify-end">
            <UButton
              color="primary"
              class="bg-brand text-white hover:bg-brand/90"
              :ui="{ label: 'text-white' }"
              icon="i-lucide-check"
              label="Use this ticket"
              @click="onUse"
            />
          </div>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end">
        <UButton color="neutral" variant="ghost" label="Close" @click="open = false" />
      </div>
    </template>
  </UModal>
</template>
