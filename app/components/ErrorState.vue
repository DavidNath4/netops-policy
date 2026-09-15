<script setup lang="ts">
withDefaults(defineProps<{
  /** Error message to display. */
  message: string
  /** Optional title above the message. */
  title?: string
  /** Lucide icon name. */
  icon?: string
  /** Whether to show the retry button. */
  retryable?: boolean
  /** Retry button label. */
  retryLabel?: string
}>(), {
  title: 'Something went wrong',
  icon: 'i-lucide-circle-alert',
  retryable: true,
  retryLabel: 'Try again',
})

const emit = defineEmits<{
  retry: []
}>()
</script>

<template>
  <div
    class="flex flex-col items-center justify-center gap-3 py-12 text-center"
    role="alert"
  >
    <UIcon :name="icon" class="size-10 text-error" />
    <div>
      <p class="text-sm font-medium text-default">{{ title }}</p>
      <p class="mt-1 text-sm text-muted">{{ message }}</p>
    </div>
    <UButton
      v-if="retryable"
      color="neutral"
      variant="outline"
      icon="i-lucide-refresh-cw"
      :label="retryLabel"
      class="mt-1"
      @click="emit('retry')"
    />
  </div>
</template>
