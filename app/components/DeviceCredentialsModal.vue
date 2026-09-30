<script setup lang="ts">
// Pop-up to set the engineer's device credentials for ACL/Route search.
// Entered once per session; stored encrypted server-side (30-min TTL) and
// auto-filled for subsequent searches. Password has a show/hide eye toggle.
const props = defineProps<{
  /** Controls visibility (v-model). */
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** Emitted after credentials are successfully saved. */
  'saved': []
}>()

const open = computed({
  get: () => props.modelValue,
  set: v => emit('update:modelValue', v),
})

const { set } = useDeviceCredentials()

const username = ref('')
const password = ref('')
const showPassword = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)

watch(open, (isOpen) => {
  if (isOpen) {
    // Never prefill the password; start clean each time the modal opens.
    username.value = ''
    password.value = ''
    showPassword.value = false
    error.value = null
  }
})

async function onSave() {
  error.value = null
  if (!username.value.trim() || !password.value) {
    error.value = 'Username and password are required.'
    return
  }
  saving.value = true
  try {
    await set(username.value.trim(), password.value)
    // Clear the local password immediately after it's stored server-side.
    password.value = ''
    open.value = false
    emit('saved')
  }
  catch (e) {
    // Prefer the server's message (e.g. n8n "Invalid username or password").
    const msg = (e as { data?: { error?: { message?: string } } })?.data?.error?.message
    error.value = msg ?? (e instanceof Error ? e.message : 'Failed to save credentials.')
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Device Credentials">
    <template #body>
      <div class="flex flex-col gap-4">
        <p class="text-sm text-muted">
          Enter your device username and password. They are used to run searches
          on your behalf, kept encrypted for this session only (30 minutes), and
          never stored in plain text or shown in logs.
        </p>

        <UAlert
          v-if="error"
          color="error"
          variant="soft"
          icon="i-lucide-circle-alert"
          :description="error"
        />

        <FormField label="Username" name="deviceUsername" required>
          <template #default="{ id }">
            <UInput
              :id="id"
              v-model="username"
              color="neutral"
              variant="outline"
              autocomplete="off"
              placeholder="Device username"
              :ui="{ base: 'bg-panel text-ink ring-line placeholder:text-muted' }"
            />
          </template>
        </FormField>

        <FormField label="Password" name="devicePassword" required>
          <template #default="{ id }">
            <UInput
              :id="id"
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              color="neutral"
              variant="outline"
              autocomplete="off"
              placeholder="Device password"
              :ui="{ base: 'bg-panel text-ink ring-line placeholder:text-muted' }"
              @keydown.enter="onSave"
            >
              <template #trailing>
                <button
                  type="button"
                  tabindex="-1"
                  :aria-label="showPassword ? 'Hide password' : 'Show password'"
                  class="text-muted hover:text-ink"
                  @click="showPassword = !showPassword"
                >
                  <UIcon :name="showPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'" class="size-4" />
                </button>
              </template>
            </UInput>
          </template>
        </FormField>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" :disabled="saving" @click="open = false" />
        <UButton
          color="primary"
          class="bg-brand text-white hover:bg-brand/90"
          :ui="{ label: 'text-white' }"
          label="Save & Continue"
          :loading="saving"
          @click="onSave"
        />
      </div>
    </template>
  </UModal>
</template>
