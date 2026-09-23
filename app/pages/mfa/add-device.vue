<script setup lang="ts">
// Add an ADDITIONAL MFA device (post-authentication, from the profile).
//
// Reuses the same QR + manual-key + 6-digit TOTP confirmation flow as the
// first-time setup page, but the user is already signed in: it calls the
// authenticated /api/auth/mfa/devices endpoints and returns to the app on
// success instead of creating a session. Business rule (max 2 devices) is
// enforced server-side; if the limit is already reached we bounce back.
import QRCode from 'qrcode'

definePageMeta({ layout: 'auth' })

const { addMfaDeviceBegin, verifyMfaDevice } = useAuth()
const toast = useToast()

const otpauthUri = ref<string | undefined>()
const qrDataUrl = ref<string | undefined>()
const pendingMfaId = ref<string | undefined>()
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

function errorCode(err: unknown): string | undefined {
  return (err as { data?: { error?: { code?: string } } })?.data?.error?.code
}

onMounted(async () => {
  try {
    const { mfaId, otpauthUri: uri } = await addMfaDeviceBegin()
    pendingMfaId.value = mfaId
    otpauthUri.value = uri
    // Render the QR locally as a PNG data URL — no network, secret stays in-app.
    qrDataUrl.value = await QRCode.toDataURL(uri, { width: 224, margin: 1 })
  }
  catch (err) {
    if (errorCode(err) === 'MFA_DEVICE_LIMIT_REACHED') {
      loadError.value = 'You already have the maximum of two MFA devices.'
    }
    else if (errorCode(err) === 'UNAUTHENTICATED') {
      await navigateTo('/login')
      return
    }
    else {
      loadError.value = 'Could not start device setup. Please try again.'
    }
  }
  finally {
    loading.value = false
  }
})

// This page is opened in a NEW TAB from the profile. On success or cancel we
// try to close the tab; if the browser blocks window.close() (tab not opened by
// script in some cases), fall back to a short "you can close this" message.
const finished = ref(false)

function closeTab() {
  finished.value = true
  window.close()
}

async function onVerify() {
  submitError.value = undefined
  codeError.value = /^[0-9]{6}$/.test(code.value.trim()) ? undefined : 'Enter the 6-digit code'
  if (codeError.value || !pendingMfaId.value) return

  submitting.value = true
  try {
    await verifyMfaDevice(pendingMfaId.value, code.value.trim())
    toast.add({ title: 'MFA device added', color: 'success', icon: 'i-lucide-check' })
    closeTab()
  }
  catch {
    submitError.value = 'Invalid verification code. Please try again.'
    code.value = ''
  }
  finally {
    submitting.value = false
  }
}

function onCancel() {
  closeTab()
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center px-4 py-12">
    <section class="w-full max-w-[440px]">
      <div class="rounded-2xl border border-line bg-panel p-8">
        <h1 class="text-[26px] font-semibold leading-tight text-ink">Add an MFA device</h1>
        <p class="mt-1 text-[13px] text-muted">
          Enrol another authenticator app for this account.
        </p>

        <LoadingState v-if="loading" class="mt-6" />

        <template v-else-if="finished">
          <p class="mt-6 text-sm text-muted">You can close this tab and return to your profile.</p>
        </template>

        <template v-else-if="loadError">
          <p class="mt-6 text-sm text-bad" role="alert">{{ loadError }}</p>
          <UButton class="mt-6" color="neutral" variant="outline" label="Close" @click="onCancel" />
        </template>

        <div v-else class="mt-6 flex flex-col gap-4">
          <p class="text-[13px] text-muted">
            Add this account to Google Authenticator, Microsoft Authenticator, or any
            TOTP app, then enter the 6-digit code to finish.
          </p>

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
                  :disabled="submitting"
                  :invalid="invalid"
                  @complete="onVerify"
                />
              </template>
            </FormField>

            <p v-if="submitError" class="text-sm text-bad" role="alert">{{ submitError }}</p>

            <div class="flex items-center gap-2">
              <UButton
                type="submit"
                color="primary"
                variant="solid"
                :loading="submitting"
                label="Verify & add device"
              />
              <UButton
                type="button"
                color="neutral"
                variant="ghost"
                label="Cancel"
                :disabled="submitting"
                @click="onCancel"
              />
            </div>
          </form>
        </div>
      </div>
    </section>
  </div>
</template>
