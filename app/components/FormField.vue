<script setup lang="ts">
const props = withDefaults(defineProps<{
  /** Visible field label. */
  label: string
  /** Field name; used to associate the label with the control via id/for. */
  name: string
  /** Validation error message; shown below the control when present. */
  error?: string
  /** Marks the field as required (adds an asterisk and aria-required). */
  required?: boolean
}>(), {
  required: false,
})

const controlId = computed(() => `field-${props.name}`)
const errorId = computed(() => `${controlId.value}-error`)
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <label :for="controlId" class="text-sm font-medium text-default">
      {{ label }}
      <span v-if="required" class="text-error" aria-hidden="true">*</span>
    </label>

    <!-- Consumer provides the input control, bound to controlId for accessibility. -->
    <slot
      :id="controlId"
      :name-attr="name"
      :required="required"
      :invalid="!!error"
      :described-by="error ? errorId : undefined"
    />

    <p v-if="error" :id="errorId" class="text-sm text-error" role="alert">
      {{ error }}
    </p>
  </div>
</template>
