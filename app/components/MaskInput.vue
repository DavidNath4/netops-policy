<script setup lang="ts">
// Subnet mask text input with a live CIDR badge inside the field.
// The user types the dotted-decimal mask (e.g. 255.255.255.0); a small badge
// shows the inferred prefix ("/24"). An unrecognised / malformed mask shows
// "/?" in a warning colour. The value stays a plain string via v-model, so
// callers keep sending the dotted-decimal mask unchanged.
import { maskToCidr, sanitizeIpv4Input } from '#shared/schemas/network.schema'

const props = defineProps<{
  modelValue: string
  id?: string
  placeholder?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

function onInput(e: Event) {
  const el = e.target as HTMLInputElement
  const clean = sanitizeIpv4Input(el.value)
  if (el.value !== clean) el.value = clean
  emit('update:modelValue', clean)
}

// null until something is typed; number for a valid mask; 'invalid' otherwise.
const cidr = computed<number | 'invalid' | null>(() => {
  const v = props.modelValue.trim()
  if (!v) return null
  const c = maskToCidr(v)
  return c === null ? 'invalid' : c
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
      :placeholder="placeholder ?? 'e.g. 255.255.255.0'"
      class="h-[38px] w-full rounded-md border border-line bg-panel pl-3 pr-14 text-xs text-ink outline-none focus:border-brand"
      @input="onInput"
    >
    <span
      v-if="cidr !== null"
      class="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums"
      :class="cidr === 'invalid' ? 'bg-bad/10 text-bad' : 'bg-brand/10 text-brand'"
      :title="cidr === 'invalid' ? 'Not a valid subnet mask' : `Prefix length /${cidr}`"
    >
      {{ cidr === 'invalid' ? '/?' : `/${cidr}` }}
    </span>
  </div>
</template>
