<script setup lang="ts">
// MFA login verification (pre-auth). Reached after a valid password when the
// account already has TOTP enabled. A full session is created only once the
// 6-digit code verifies. An invalid/expired challenge sends the user back to
// login.
definePageMeta({ layout: 'auth' })

const { verifyMfa, challengeExpiresAt } = useAuth()

const code = ref('')
const codeError = ref<string | undefined>()
const submitError = ref<string | undefined>()
const submitting = ref(false)

// Countdown for the pre-auth MFA challenge window; on expiry, back to login.
const { label: countdown, expired } = useCountdown(challengeExpiresAt)
watch(expired, (isExpired) => {
  if (isExpired) navigateTo('/login')
})

// Reaching this page without a live challenge (e.g. a hard refresh dropped the
// client-side expiry) means we can't trust the flow — start over at login.
onMounted(() => {
  if (challengeExpiresAt.value === null) navigateTo('/login')
})

async function onVerify() {
  submitError.value = undefined
  if (expired.value) {
    await navigateTo('/login')
    return
  }
  codeError.value = /^[0-9]{6}$/.test(code.value.trim()) ? undefined : 'Enter the 6-digit code'
  if (codeError.value) return

  submitting.value = true
  try {
    await verifyMfa(code.value.trim())
    await navigateTo('/')
  }
  catch (err) {
    const codeStr = (err as { data?: { error?: { code?: string } } })?.data?.error?.code
    if (codeStr === 'MFA_CHALLENGE_INVALID') {
      await navigateTo('/login')
      return
    }
    submitError.value = 'Invalid verification code. Please try again.'
    code.value = ''
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center px-4 py-12">
    <section class="w-full max-w-[400px]">
      <div class="rounded-2xl border border-line bg-panel p-8">
        <h1 class="text-[26px] font-semibold leading-tight text-ink">Verify your identity</h1>
        <p class="mt-1 text-[13px] text-muted">
          Enter the 6-digit code from your authenticator app.
        </p>

        <div
          v-if="challengeExpiresAt"
          class="mt-4 flex items-center justify-between rounded-lg border border-line bg-surface px-3 py-2"
        >
          <span class="text-[12px] text-muted">This verification session expires in</span>
          <span
            class="font-mono text-[13px] font-semibold tabular-nums"
            :class="expired ? 'text-bad' : 'text-ink'"
          >
            {{ countdown }}
          </span>
        </div>

        <form class="mt-6 flex flex-col gap-4" novalidate @submit.prevent="onVerify">
          <FormField label="Verification code" name="code" :error="codeError" required>
            <template #default="{ id, invalid, describedBy }">
              <UInput
                :id="id"
                v-model="code"
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength="6"
                placeholder="123456"
                color="neutral"
                variant="outline"
                :aria-invalid="invalid"
                :aria-describedby="describedBy"
                class="w-full"
                :ui="{ base: 'bg-panel text-ink ring-line placeholder:text-muted' }"
              />
            </template>
          </FormField>

          <p v-if="submitError" class="text-sm text-bad" role="alert">{{ submitError }}</p>

          <UButton
            type="submit"
            color="primary"
            variant="solid"
            block
            size="lg"
            :loading="submitting"
            :disabled="expired"
            label="Verify"
          />
        </form>
      </div>
    </section>
  </div>
</template>
