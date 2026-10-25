<script setup lang="ts">
// One ACL row in the Bulk Add ACL list. Self-contained: it owns its row's
// fields (via v-model), its collapse/expand toggle, the per-row bidirectional
// and time-range controls, and its own inline validation hints. The parent
// (pages/acl/add-bulk.vue) owns the list, the batch-global ticket/credentials,
// the shared time-range catalog state (passed in as props), and the preview.
//
// The row data shape + validation live in composables/useAclBulkRows.ts so this
// component and the page share one source of truth.
import type { BulkRow } from '~/composables/useAclBulkRows'
import type { TimeRangeObject } from '#shared/schemas/time-range.schema'
import { bulkRowAnyAddress, bulkRowSameEndpoint, bulkRowTimeFormatValid } from '~/composables/useAclBulkRows'
import { autoCorrectAclIp } from '#shared/schemas/network.schema'

// Two-way bound row model (parent holds the array; this edits one entry).
const row = defineModel<BulkRow>({ required: true })

const props = defineProps<{
  /** Zero-based row index — used for labels/ids and the "Row #n" header. */
  index: number
  /** True when the last preview flagged THIS row as already on the device. */
  blocking: boolean
  /** Shared time-range catalog state (fetched once by the parent). */
  timeRangeItems: { label: string, detail: string, value: string }[]
  credsFilled: boolean
  timeRangeLoading: boolean
  timeRangeLoadError: boolean
  timeRangeObjects: TimeRangeObject[]
  /** When true, a batch-global time range is active — the per-row time range is
   *  disabled (the row inherits the global object). */
  timeRangeDisabled: boolean
}>()

const emit = defineEmits<{ remove: [] }>()

function toggle() {
  row.value.expanded = !row.value.expanded
}

// Clamp the manually typed time to HH:mm as the user types (digits + one colon).
function onTimeInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  let digits = raw.replace(/\D/g, '').slice(0, 4)
  if (digits.length > 2) digits = `${digits.slice(0, 2)}:${digits.slice(2)}`
  row.value.timeRangeTime = digits
}

const sameEndpoint = computed(() => bulkRowSameEndpoint(row.value))
const anyAddress = computed(() => bulkRowAnyAddress(row.value))
const timeFormatValid = computed(() => bulkRowTimeFormatValid(row.value))

const inputClass
  = 'h-[38px] w-full rounded-md border border-line bg-panel px-3 text-xs text-ink outline-none focus:border-brand disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted'
</script>

<template>
  <div
    class="flex flex-col rounded-lg border bg-panel"
    :class="blocking ? 'border-bad ring-1 ring-bad' : 'border-line'"
  >
    <!-- Card header: collapse/expand toggle + summary + remove. -->
    <div class="flex items-center justify-between gap-2 p-3">
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-2 text-left"
        :aria-expanded="row.expanded"
        @click="toggle"
      >
        <UIcon :name="row.expanded ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-4 shrink-0 text-muted" />
        <span class="shrink-0 text-xs font-semibold text-muted">Row #{{ index + 1 }}</span>
        <span class="truncate text-xs text-ink">
          {{ row.source || '—' }} → {{ row.destination || '—' }}
        </span>
        <span v-if="row.bidirectional" class="shrink-0 rounded bg-brand/10 px-1.5 py-0.5 text-[10px] font-semibold text-brand">Bidirectional</span>
        <span v-if="row.timeRangeEnabled" class="shrink-0 rounded bg-brand/10 px-1.5 py-0.5 text-[10px] font-semibold text-brand">Time Range</span>
        <span v-if="blocking" class="shrink-0 rounded bg-bad/10 px-1.5 py-0.5 text-[10px] font-semibold text-bad">
          ALREADY EXISTS — remove this row
        </span>
      </button>
      <UButton
        color="error"
        variant="ghost"
        size="xs"
        icon="i-lucide-trash-2"
        :aria-label="`Remove row ${index + 1}`"
        @click="emit('remove')"
      />
    </div>

    <!-- Card body: full form, only when expanded. -->
    <div v-show="row.expanded" class="flex flex-col gap-3 border-t border-line p-4">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Source" :name="`source-${index}`" required>
          <template #default="{ id }">
            <IpInput :id="id" v-model="row.source" placeholder="e.g. 10.100.100.100" @blur="row.source = autoCorrectAclIp(row.source)" />
          </template>
        </FormField>
        <FormField label="Source Mask" :name="`sourceMask-${index}`">
          <template #default="{ id }">
            <MaskInput :id="id" v-model="row.sourceMask" />
          </template>
        </FormField>
        <FormField label="Destination" :name="`destination-${index}`" required>
          <template #default="{ id }">
            <IpInput :id="id" v-model="row.destination" placeholder="e.g. 10.200.200.200" @blur="row.destination = autoCorrectAclIp(row.destination)" />
          </template>
        </FormField>
        <FormField label="Destination Mask" :name="`destinationMask-${index}`">
          <template #default="{ id }">
            <MaskInput :id="id" v-model="row.destinationMask" />
          </template>
        </FormField>
      </div>

      <p v-if="anyAddress" class="text-[11px] text-bad" role="alert">
        0.0.0.0/0 (any) is not allowed — use a specific address and mask.
      </p>
      <p v-else-if="sameEndpoint" class="text-[11px] text-bad" role="alert">
        Source and Destination must not use the same IP address.
      </p>

      <!-- Per-row bidirectional: THIS row also adds destination → source. -->
      <label class="flex items-center gap-2 text-sm font-medium text-ink">
        <input
          v-model="row.bidirectional"
          type="checkbox"
          class="size-3.5 rounded border-line text-brand focus:ring-brand"
        >
        Bidirectional (also add destination → source, masks swapped)
      </label>

      <!-- Per-row optional time range (same modes as single add). Capped to about
           half the row (aligned with the Source/Destination fields), not the full
           width. Disabled when a batch-global time range is active. -->
      <div class="flex flex-col gap-1.5 sm:max-w-[calc(50%-0.5rem)]">
        <label
          class="flex items-center gap-2 text-sm font-medium"
          :class="timeRangeDisabled ? 'cursor-not-allowed text-muted' : 'text-ink'"
        >
          <input
            v-model="row.timeRangeEnabled"
            type="checkbox"
            :disabled="timeRangeDisabled"
            class="size-3.5 rounded border-line text-brand focus:ring-brand disabled:cursor-not-allowed"
          >
          Time Range (optional)
        </label>

        <p v-if="timeRangeDisabled" class="text-[11px] text-muted">
          A global time range is applied to all rows; per-row time range is disabled.
        </p>

        <template v-else-if="row.timeRangeEnabled">
          <div
            class="grid grid-cols-2 gap-1 rounded-md border border-line bg-surface p-1"
            role="tablist"
            aria-label="Time Range mode"
          >
            <button
              type="button"
              role="tab"
              :aria-selected="row.timeRangeMode === 'existing'"
              class="rounded px-3 py-1.5 text-xs font-semibold transition-colors"
              :class="row.timeRangeMode === 'existing' ? 'bg-panel text-brand shadow-sm' : 'text-muted hover:text-ink'"
              @click="row.timeRangeMode = 'existing'"
            >
              Select Existing
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="row.timeRangeMode === 'new'"
              class="rounded px-3 py-1.5 text-xs font-semibold transition-colors"
              :class="row.timeRangeMode === 'new' ? 'bg-panel text-brand shadow-sm' : 'text-muted hover:text-ink'"
              @click="row.timeRangeMode = 'new'"
            >
              Create New
            </button>
          </div>

          <div v-if="row.timeRangeMode === 'existing'" class="flex flex-col gap-1">
            <USelectMenu
              v-model="row.timeRangeObject"
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
              :ui="{ base: 'bg-panel text-ink ring-line', content: 'bg-panel ring-line', viewport: 'max-h-[20rem]' }"
            >
              <template #item-label="{ item }">
                <div class="flex flex-col">
                  <span class="text-xs text-ink">{{ item.label }}</span>
                  <span v-if="item.detail" class="text-[10px] text-muted">{{ item.detail }}</span>
                </div>
              </template>
            </USelectMenu>
            <p v-if="!credsFilled" class="text-[11px] text-muted">
              Fill in Username &amp; Password first to load the time range list.
            </p>
            <p v-else-if="timeRangeLoading" class="text-[11px] text-muted">
              Loading existing time range objects...
            </p>
            <p v-else-if="timeRangeLoadError || timeRangeObjects.length === 0" class="text-[11px] text-muted">
              No existing time range objects could be loaded. Use Create New instead.
            </p>
          </div>

          <div v-else class="flex flex-col gap-1">
            <div class="flex items-center gap-2">
              <input
                v-model="row.timeRangeDate"
                type="date"
                aria-label="Time range date"
                :class="inputClass"
              >
              <input
                v-model="row.timeRangeTime"
                type="text"
                inputmode="numeric"
                maxlength="5"
                placeholder="23:59"
                aria-label="Time range time (HH:mm, 24-hour)"
                :class="[inputClass, 'w-24', !timeFormatValid ? 'border-bad' : '']"
                @input="onTimeInput"
              >
            </div>
            <p v-if="!row.timeRangeDate" class="text-[11px] text-muted">
              Pick a date; time defaults to 23:59.
            </p>
            <p v-else-if="!timeFormatValid" class="text-[11px] text-bad" role="alert">
              Time must be HH:mm (24-hour), e.g. 23:59.
            </p>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
