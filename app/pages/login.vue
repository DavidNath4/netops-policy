<script setup lang="ts">
// Login page. Uses the bare `auth` layout (bg-surface). Single light panel:
// left branding, right white sign-in card — matching the Figma "Network ops
// app" login frame. First factor only: on success the backend issues a
// short-lived MFA challenge and we route to the correct MFA step. No session is
// created here, and the password is dropped once the request completes.
definePageMeta({ layout: 'auth' })

const { login } = useAuth()

const email = ref('')
const password = ref('')
const showPassword = ref(false)
const errors = reactive<{ email?: string, password?: string }>({})
const submitError = ref<string | undefined>()
const loading = ref(false)

function validate(): boolean {
  errors.email = email.value.trim() ? undefined : 'Email is required'
  errors.password = password.value ? undefined : 'Password is required'
  return !errors.email && !errors.password
}

async function onSubmit() {
  submitError.value = undefined
  if (!validate()) return

  loading.value = true
  try {
    const status = await login(email.value.trim(), password.value)
    // Don't retain the password after the request.
    password.value = ''
    if (status === 'MFA_SETUP_REQUIRED') {
      await navigateTo('/mfa/setup')
    }
    else {
      await navigateTo('/mfa/verify')
    }
  }
  catch {
    password.value = ''
    submitError.value = 'Invalid credentials. Please try again.'
  }
  finally {
    loading.value = false
  }
}
</script>

<template>
  <!-- Figma "01 Login": #F5F7FA canvas, left branding + right 400x500 card,
       centered together on the page. -->
  <div class="flex min-h-screen items-center justify-center bg-surface px-6">
    <div
      class="flex w-full max-w-[960px] flex-col items-center gap-12 lg:flex-row lg:items-center lg:justify-between lg:gap-16"
    >
      <!-- Left: branding (Figma title 34/600, subtitle 16/400) -->
      <section class="w-full max-w-[480px] text-center lg:-translate-y-[180px] lg:translate-x-[10px] lg:text-left">
        <h1 class="text-[34px] font-semibold leading-[41px] text-ink">
          NetOps Policy Manager
        </h1>
        <p class="mt-3 text-[16px] leading-[19px] text-muted">ACL &amp; Route Management</p>
      </section>

      <!-- Right: sign-in card (Figma 400x500, radius 16, border #DEE3EB) -->
      <section class="w-full max-w-[400px]">
        <div class="min-h-[500px] rounded-2xl border border-line bg-panel px-[50px] py-[55px]">
          <h2 class="text-[28px] font-semibold leading-[34px] text-ink">Sign in</h2>
          <p class="mt-2 text-[13px] leading-4 text-muted">
            Use your authorized account to continue.
          </p>

          <form class="mt-8 flex flex-col gap-5" novalidate @submit.prevent="onSubmit">
            <FormField label="Email" name="email" :error="errors.email" required>
              <template #default="{ id, invalid, describedBy }">
                <UInput
                  :id="id"
                  v-model="email"
                  type="email"
                  autocomplete="username"
                  placeholder="Enter email"
                  color="neutral"
                  variant="outline"
                  :aria-invalid="invalid"
                  :aria-describedby="describedBy"
                  class="w-full"
                  :ui="{ base: 'bg-panel text-ink ring-line placeholder:text-muted' }"
                />
              </template>
            </FormField>

            <FormField label="Password" name="password" :error="errors.password" required>
              <template #default="{ id, invalid, describedBy }">
                <UInput
                  :id="id"
                  v-model="password"
                  :type="showPassword ? 'text' : 'password'"
                  autocomplete="current-password"
                  placeholder="Enter password"
                  color="neutral"
                  variant="outline"
                  :aria-invalid="invalid"
                  :aria-describedby="describedBy"
                  class="w-full"
                  :ui="{ base: 'bg-panel text-ink ring-line placeholder:text-muted' }"
                >
                  <template #trailing>
                    <UButton
                      :icon="showPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                      color="neutral"
                      variant="link"
                      size="sm"
                      :aria-label="showPassword ? 'Hide password' : 'Show password'"
                      :aria-pressed="showPassword"
                      tabindex="-1"
                      @click="showPassword = !showPassword"
                    />
                  </template>
                </UInput>
              </template>
            </FormField>

            <p v-if="submitError" class="text-sm text-bad" role="alert">
              {{ submitError }}
            </p>

            <UButton
              type="submit"
              color="primary"
              variant="solid"
              block
              size="lg"
              :loading="loading"
              label="Login"
              class="mt-2"
            />
          </form>

          <p class="mt-6 text-[11px] leading-[13px] text-muted">
            SSO / MFA enabled for privileged access
          </p>
        </div>
      </section>
    </div>
  </div>
</template>
