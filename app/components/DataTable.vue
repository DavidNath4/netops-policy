<script setup lang="ts" generic="T extends Record<string, unknown>">
/** A column definition for the table. */
export interface DataTableColumn {
  /** Key into each row object. */
  key: string
  /** Human-readable column header. */
  label: string
}

const props = withDefaults(defineProps<{
  /** Column definitions in display order. */
  columns: DataTableColumn[]
  /** Row data. */
  rows: T[]
  /** When true, shows a loading placeholder instead of rows. */
  loading?: boolean
  /** Message shown when there are no rows and not loading. */
  emptyLabel?: string
}>(), {
  loading: false,
  emptyLabel: 'No data to display.',
})

// Named cell slots so callers can customize any column, e.g. #cell-status.
defineSlots<{
  [K: `cell-${string}`]: (props: { row: T; value: unknown; column: DataTableColumn }) => unknown
  empty(): unknown
  loading(): unknown
}>()

const skeletonRows = computed(() => Array.from({ length: 5 }, (_, i) => i))
</script>

<template>
  <div class="overflow-x-auto rounded-lg ring ring-default">
    <table class="min-w-full divide-y divide-default text-sm">
      <thead class="bg-elevated/50">
        <tr>
          <th
            v-for="col in props.columns"
            :key="col.key"
            scope="col"
            class="px-4 py-3 text-left font-medium text-muted whitespace-nowrap"
          >
            {{ col.label }}
          </th>
        </tr>
      </thead>
      <tbody class="divide-y divide-default">
        <!-- Loading state -->
        <template v-if="props.loading">
          <slot name="loading">
            <tr v-for="n in skeletonRows" :key="`sk-${n}`">
              <td v-for="col in props.columns" :key="col.key" class="px-4 py-3">
                <USkeleton class="h-4 w-full" />
              </td>
            </tr>
          </slot>
        </template>

        <!-- Empty state -->
        <tr v-else-if="props.rows.length === 0">
          <td :colspan="props.columns.length" class="px-4 py-8 text-center text-muted">
            <slot name="empty">{{ props.emptyLabel }}</slot>
          </td>
        </tr>

        <!-- Data rows -->
        <template v-else>
          <tr
            v-for="(row, rowIndex) in props.rows"
            :key="rowIndex"
            class="hover:bg-elevated/50 transition-colors"
          >
            <td
              v-for="col in props.columns"
              :key="col.key"
              class="px-4 py-3 text-default whitespace-nowrap"
            >
              <slot
                :name="`cell-${col.key}`"
                :row="row"
                :value="row[col.key]"
                :column="col"
              >
                {{ row[col.key] }}
              </slot>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>
