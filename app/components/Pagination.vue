<script setup lang="ts">
const props = withDefaults(defineProps<{
  /** Current page (1-based, v-model). */
  page: number
  /** Total number of items across all pages. */
  total: number
  /** Items shown per page. */
  itemsPerPage?: number
}>(), {
  itemsPerPage: 20,
})

const emit = defineEmits<{
  'update:page': [value: number]
}>()

const currentPage = computed({
  get: () => props.page,
  set: (value: number) => emit('update:page', value),
})

const from = computed(() =>
  props.total === 0 ? 0 : (props.page - 1) * props.itemsPerPage + 1,
)
const to = computed(() => Math.min(props.page * props.itemsPerPage, props.total))
</script>

<template>
  <div class="flex flex-col items-center justify-between gap-3 sm:flex-row">
    <p class="text-sm text-muted">
      Showing {{ from }}–{{ to }} of {{ total }}
    </p>
    <UPagination
      v-model:page="currentPage"
      :total="total"
      :items-per-page="itemsPerPage"
    />
  </div>
</template>
