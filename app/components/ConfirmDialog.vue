<script setup lang="ts">
import type { ButtonProps } from '@nuxt/ui'

const props = withDefaults(defineProps<{
  /** Controls dialog visibility (v-model). */
  modelValue: boolean
  /** Dialog title. */
  title: string
  /** Body message describing the action and its consequences. */
  message: string
  /** Confirm button label. */
  confirmLabel?: string
  /** Cancel button label. */
  cancelLabel?: string
  /** Confirm button color; defaults to error for destructive actions. */
  confirmColor?: ButtonProps['color']
  /** Disables the confirm button and shows a spinner (e.g. while submitting). */
  loading?: boolean
}>(), {
  confirmLabel: 'Confirm',
  cancelLabel: 'Cancel',
  confirmColor: 'error',
  loading: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: []
  cancel: []
}>()

const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

function onConfirm() {
  emit('confirm')
}

function onCancel() {
  emit('cancel')
  open.value = false
}
</script>

<template>
  <UModal v-model:open="open" :title="title">
    <template #body>
      <p class="text-sm text-muted">{{ message }}</p>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="cancelLabel"
          :disabled="loading"
          @click="onCancel"
        />
        <UButton
          :color="confirmColor"
          :label="confirmLabel"
          :loading="loading"
          @click="onConfirm"
        />
      </div>
    </template>
  </UModal>
</template>
