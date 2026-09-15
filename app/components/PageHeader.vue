<script setup lang="ts">
defineProps<{
  /** Page title shown as the main heading. */
  title: string
  /** Optional supporting text shown beneath the title. */
  description?: string
}>()

defineSlots<{
  /** Right-aligned actions area, e.g. a "+ Add" button. */
  actions(): unknown
}>()
</script>

<template>
  <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    <div class="min-w-0">
      <h1 class="text-xl font-semibold text-ink truncate">
        {{ title }}
      </h1>
      <p v-if="description" class="mt-1 text-sm text-muted">
        {{ description }}
      </p>
    </div>
    <div v-if="$slots.actions" class="flex shrink-0 items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
