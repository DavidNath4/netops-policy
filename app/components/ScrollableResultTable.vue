<script setup lang="ts" generic="T">
// Fixed-height table whose BODY scrolls (sticky header) so a large result set
// doesn't push the page down. Generic: pass column defs + rows; render each cell
// via the `cell` slot. Rows are clickable and highlight the selected one.

interface Column {
  key: string
  label: string
  /** Tailwind grid fraction, e.g. '1.2fr'. */
  width: string
}

const props = defineProps<{
  columns: Column[]
  rows: T[]
  /** Index of the selected row, or null. */
  selected: number | null
  /** Max body height (Tailwind class), default caps ~10 rows. */
  maxHeight?: string
}>()

const emit = defineEmits<{ select: [index: number] }>()

const gridCols = computed(() => props.columns.map(c => c.width).join(' '))
const bodyMaxH = computed(() => props.maxHeight ?? 'max-h-[420px]')
</script>

<template>
  <div class="overflow-hidden rounded-lg border border-line">
    <!-- Sticky header -->
    <div
      class="grid gap-3 border-b border-line bg-surface px-4 py-2.5 text-[11px] font-semibold text-muted"
      :style="{ gridTemplateColumns: gridCols }"
    >
      <span v-for="col in columns" :key="col.key" class="truncate">{{ col.label }}</span>
    </div>

    <!-- Scrollable body -->
    <div class="overflow-y-auto" :class="bodyMaxH">
      <button
        v-for="(row, i) in rows"
        :key="i"
        type="button"
        :aria-pressed="selected === i"
        class="grid w-full items-center gap-3 border-b border-line px-4 py-3 text-left text-[11px] text-ink transition-colors last:border-b-0 hover:bg-surface"
        :class="selected === i ? 'bg-brand/5' : 'bg-panel'"
        :style="{ gridTemplateColumns: gridCols }"
        @click="emit('select', i)"
      >
        <slot name="cell" :row="row" :index="i" />
      </button>
    </div>
  </div>
</template>
