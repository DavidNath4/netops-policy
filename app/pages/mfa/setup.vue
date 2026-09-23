<script setup lang="ts">
// MFA enrollment page (pre-auth). Reached only after a valid password when the
// account has no confirmed TOTP yet. On load it asks the server for the
// otpauth:// URI, then the user confirms with the first 6-digit code. A full
// session is created only once that code verifies.
//
// The QR code is generated client-side from the otpauth URI (via `qrcode`), so
// the secret never leaves this app. The manual setup key and raw URI remain
// available as a fallback for apps that can't scan.
import QRCode from 'qrcode'

definePageMeta({ layout: 'auth' })

const { setupMfa, verifyMfaSetup, challengeExpiresAt } = useAuth()

// Countdown for the pre-auth enrollment challenge window; on expiry, back to login.
const { label: countdown, expired } = useCountdown(challengeExpiresAt)
watch(expired, (isExpired) => {
  if (isExpired) navigateTo('/login')
})

const otpauthUri = ref<string | undefined>()
const qrDataUrl = ref<string | undefined>()
const loadError = ref<string | undefined>()
const loading = ref(true)

const code = ref('')
const codeError = ref<string | undefined>()
const submitError = ref<string | undefined>()
const submitting = ref(false)

// Pull the shared secret out of the otpauth URI for manual entry.
const secret = computed(() => {
  if (!otpauthUri.value) return undefined
  try {
    return new URL(otpauthUri.value).searchParams.get('secret') ?? undefined
  }
  catch {
    return undefined
  }
})

onMounted(async () => {
  // A hard refresh drops the client-side challenge expiry; without it we can't
  // trust the pre-auth flow, so start over at login.
  if (challengeExpiresAt.value === null) {
    await navigateTo('/login')
    return
  }
  try {
    const uri = await setupMfa()
    otpauthUri.value = uri
    // Render the QR locally as a PNG data URL — no network, secret stays in-app.
    qrDataUrl.value = await QRCode.toDataURL(uri, { width: 224, margin: 1 })
  }
  catch {
    // Challenge missing/expired, or not in an enrollment flow → back to login.
    loadError.value = 'Your setup session has expired. Please sign in again.'
    setTimeout(() => navigateTo('/login'), 1500)
  }
  finally {
    loading.value = false
  }
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
    await verifyMfaSetup(code.value.trim())
    await navigateTo('/')
  }
  catch {
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
    <section class="w-full max-w-[440px]">
      <div class="rounded-2xl border border-line bg-panel p-8">
        <h1 class="text-[26px] font-semibold leading-tight text-ink">Set up two-factor auth</h1>
        <p class="mt-1 text-[13px] text-muted">
          Add this account to Google Authenticator, Microsoft Authenticator, or any
          TOTP app, then enter the 6-digit code to finish.
        </p>

        <LoadingState v-if="loading" class="mt-6" />

        <p v-else-if="loadError" class="mt-6 text-sm text-bad" role="alert">
          {{ loadError }}
        </p>

        <div v-else class="mt-6 flex flex-col gap-4">
          <div
            v-if="challengeExpiresAt"
            class="flex items-center justify-between rounded-lg border border-line bg-surface px-3 py-2"
          >
            <span class="text-[12px] text-muted">This setup session expires in</span>
            <span
              class="font-mono text-[13px] font-semibold tabular-nums"
              :class="expired ? 'text-bad' : 'text-ink'"
            >
              {{ countdown }}
            </span>
          </div>

          <div v-if="qrDataUrl" class="flex justify-center">
            <img
              :src="qrDataUrl"
              alt="TOTP setup QR code"
              width="224"
              height="224"
              class="rounded-lg border border-line bg-white p-2"
            >
          </div>

          <div v-if="secret" class="rounded-lg border border-line bg-surface p-4">
            <p class="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Manual setup key
            </p>
            <code class="mt-1 block break-all font-mono text-sm text-ink">{{ secret }}</code>
          </div>

          <details class="text-xs text-muted">
            <summary class="cursor-pointer select-none">Show otpauth URI</summary>
            <code class="mt-2 block break-all font-mono text-[11px] text-ink">{{ otpauthUri }}</code>
          </details>

          <form class="flex flex-col gap-4" novalidate @submit.prevent="onVerify">
            <FormField label="Verification code" name="code" :error="codeError" required>
              <template #default="{ invalid }">
                <MfaCodeInput
                  v-model="code"
                  :disabled="expired || submitting"
                  :invalid="invalid"
                  @complete="onVerify"
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
              label="Verify & continue"
            />
          </form>
        </div>
      </div>
    </section>
  </div>
</template>
