<script setup lang="ts">
withDefaults(defineProps<{
  /** Title describing the empty condition. */
  title: string
  /** Optional supporting description. */
  description?: string
  /** Lucide icon name for the illustration. */
  icon?: string
}>(), {
  icon: 'i-lucide-inbox',
})

defineSlots<{
  /** Optional call-to-action area, e.g. a "+ Add" button. */
  action(): unknown
}>()
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-3 py-12 text-center">
    <UIcon :name="icon" class="size-10 text-muted" />
    <div>
      <p class="text-sm font-medium text-default">{{ title }}</p>
      <p v-if="description" class="mt-1 text-sm text-muted">{{ description }}</p>
    </div>
    <div v-if="$slots.action" class="mt-1">
      <slot name="action" />
    </div>
  </div>
</template>
