<script setup lang="ts">
// IPv4 text input, locked to IPv4 shape as you type.
// Only digits and dots are accepted; anything else (letters, symbols) is
// stripped on input. The value is further constrained to at most 4 octets, each
// at most 3 digits and never greater than 255 — so you physically cannot type
// an impossible address. A badge still shows ✓ when the address is complete and
// valid, or "?" while it is incomplete/empty-octet. Value stays a plain string
// via v-model, so callers send the address unchanged.
import { isValidIpv4, sanitizeIpv4Input } from '#shared/schemas/network.schema'

const props = defineProps<{
  modelValue: string
  id?: string
  placeholder?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

function onInput(e: Event) {
  const el = e.target as HTMLInputElement
  const clean = sanitizeIpv4Input(el.value)
  // Keep the DOM in sync when we rejected characters, so the caret doesn't sit
  // after a stripped char.
  if (el.value !== clean) el.value = clean
  emit('update:modelValue', clean)
}

// null until something is typed; true/false once there is input.
const valid = computed<boolean | null>(() => {
  const v = props.modelValue.trim()
  if (!v) return null
  return isValidIpv4(v)
})
</script>

<template>
  <div class="relative">
    <input
      :id="id"
      :value="modelValue"
      type="text"
      inputmode="decimal"
      autocomplete="off"
      :placeholder="placeholder ?? 'e.g. 10.100.100.100'"
      class="h-[38px] w-full rounded-md border bg-panel pl-3 pr-9 text-xs text-ink outline-none focus:border-brand"
      :class="valid === false ? 'border-bad' : 'border-line'"
      @input="onInput"
    >
    <span
      v-if="valid !== null"
      class="absolute right-2 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded font-mono text-[11px] font-semibold"
      :class="valid ? 'bg-ok/10 text-ok' : 'bg-bad/10 text-bad'"
      :title="valid ? 'Valid IPv4 address' : 'Incomplete or invalid IPv4 address'"
    >
      <UIcon :name="valid ? 'i-lucide-check' : 'i-lucide-help-circle'" class="size-3.5" />
    </span>
  </div>
</template>
