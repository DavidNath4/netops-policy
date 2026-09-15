<script setup lang="ts">
withDefaults(defineProps<{
  /** Optional message shown beneath the spinner. */
  message?: string
}>(), {
  message: 'Loading…',
})
</script>

<template>
  <div
    class="flex flex-col items-center justify-center gap-3 py-12 text-muted"
    role="status"
    aria-live="polite"
  >
    <UIcon name="i-lucide-loader-circle" class="size-8 animate-spin text-primary" />
    <p v-if="message" class="text-sm">{{ message }}</p>
    <span class="sr-only">{{ message }}</span>
  </div>
</template>
