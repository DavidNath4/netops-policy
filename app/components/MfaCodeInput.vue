<script setup lang="ts">
// Six-box TOTP code input, shared across the MFA setup / verify / add-device
// flows. Wraps Nuxt UI's UPinInput (which manages per-digit boxes) and exposes
// a plain string via v-model so callers keep working with the joined code.
//
// - 6 numeric boxes, one-time-code autofill, light NetOps tokens.
// - Emits `complete` when all six digits are entered so a page can auto-submit.
const props = defineProps<{
  modelValue: string
  disabled?: boolean
  invalid?: boolean
  autofocus?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'complete': [value: string]
}>()

// UPinInput works with an array of single characters; bridge it to our string.
const digits = computed<string[]>({
  get: () => props.modelValue.split('').slice(0, 6),
  set: value => emit('update:modelValue', value.join('')),
})

function onComplete(value: string[]) {
  emit('complete', value.join(''))
}
</script>

<template>
  <UPinInput
    v-model="digits"
    :length="6"
    otp
    type="text"
    placeholder="○"
    color="neutral"
    variant="outline"
    size="lg"
    :disabled="disabled"
    :highlight="invalid"
    :autofocus="autofocus"
    :aria-invalid="invalid"
    aria-label="6-digit verification code"
    :ui="{ base: 'bg-panel text-ink ring-line placeholder:text-muted' }"
    @complete="onComplete"
  />
</template>
