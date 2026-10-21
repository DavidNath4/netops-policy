<script setup lang="ts">
// Reusable result / alert pop-up built on UModal. Generic by design: it holds no
// ACL/route logic and only renders a variant icon + message, an optional #body
// slot for richer content (e.g. a terminal output block), and a single close
// button. Pages drive it from their own reactive dialog state via v-model:open.
const props = withDefaults(defineProps<{
  /** Controls dialog visibility (v-model:open). */
  open: boolean
  /** Dialog title. */
  title: string
  /** Visual variant — selects the header icon + accent colour. */
  variant: 'success' | 'error' | 'warning'
  /** Primary message shown beside the variant icon. */
  message?: string
}>(), {
  message: '',
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  close: []
}>()

// Writable proxy so <UModal v-model:open> reads the prop and emits updates while
// the parent owns the source of truth (mirrors NotificationModal/ConfirmDialog).
const open = computed({
  get: () => props.open,
  set: value => emit('update:open', value),
})

// Variant → icon + text colour. success/error use the ok/bad design tokens.
// EXCEPTION: there is no warning/amber design token (see app/assets/css/tailwind.css
// @theme), so the warning icon uses Tailwind's built-in text-amber-500.
const variantMap = {
  success: { icon: 'i-lucide-circle-check', color: 'text-ok' },
  error: { icon: 'i-lucide-circle-alert', color: 'text-bad' },
  warning: { icon: 'i-lucide-triangle-alert', color: 'text-amber-500' },
} as const

const variantStyle = computed(() => variantMap[props.variant])

function onClose() {
  open.value = false
  emit('close')
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="title"
    :ui="{
      content: 'bg-white text-ink ring-1 ring-line divide-y divide-line',
      header: 'text-ink',
      title: 'text-ink',
      body: 'bg-white',
      footer: 'bg-white',
    }"
  >
    <template #body>
      <div class="flex flex-col gap-3">
        <div class="flex items-start gap-3">
          <UIcon :name="variantStyle.icon" class="mt-0.5 size-5 shrink-0" :class="variantStyle.color" />
          <p class="text-sm text-ink">{{ message }}</p>
        </div>
        <!-- Optional richer content (e.g. device output terminal block). -->
        <slot name="body" />
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end">
        <UButton
          color="neutral"
          label="Close"
          aria-label="Close dialog"
          @click="onClose"
        />
      </div>
    </template>
  </UModal>
</template>
