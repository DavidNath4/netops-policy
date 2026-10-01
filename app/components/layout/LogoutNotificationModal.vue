<script setup lang="ts">
const props = defineProps<{
  open: boolean
  loading?: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'confirm': []
}>()

const open = computed({
  get: () => props.open,
  set: value => emit('update:open', value),
})

function onConfirm() {
  emit('confirm')
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="Confirm Logout"
    :ui="{
      content: 'w-full max-w-sm bg-white text-ink ring-1 ring-line divide-y divide-line',
      header: 'text-ink',
      title: 'text-ink',
      body: 'bg-white',
      footer: 'bg-white',
    }"
  >
    
    <template #footer>
      <div class="flex w-full justify-center gap-2">
        <UButton
          color="neutral"
          variant="outline"
          label="Cancel"
          :disabled="loading"
          @click="open = false"
        />

        <UButton
          color="error"
          variant="solid"
          label="Logout"
          icon="i-lucide-log-out"
          :loading="loading"
          @click="onConfirm"
        />
      </div>
    </template>
  </UModal>
</template>