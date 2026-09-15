<script setup lang="ts">
// Profile modal opened by clicking the username in the header.
//
// Shows the authenticated identity (email/name from the real session) plus a
// few account controls. Role, the "email notifications" switch, and the MFA
// device list are UI-only placeholders for now — RBAC and notification/MFA-device
// management are out of scope for the current phase and not yet persisted.

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

// Writable proxy: parent owns visibility via v-model:open.
const open = computed({
  get: () => props.open,
  set: value => emit('update:open', value),
})

const { user } = useAuth()

const email = computed(() => user.value?.email ?? '—')
const name = computed(() => user.value?.displayName ?? '—')

// Placeholder until RBAC exists (no role field on the Dev 1 user model).
const role = 'Administrator'

// Local-only switch (not persisted yet).
const emailNotifications = ref(true)

interface MfaDevice {
  id: string
  label: string
  type: string
  addedAt: string
}

// Dummy device list. In a real flow this comes from user_mfa + future device rows.
const mfaDevices = ref<MfaDevice[]>([
  { id: 'd1', label: 'Authenticator app', type: 'TOTP', addedAt: 'Added Sep 2026' },
])

function addMfaDevice() {
  // Placeholder: real enrollment goes through the MFA setup flow.
  const n = mfaDevices.value.length + 1
  mfaDevices.value.push({
    id: `d${n}`,
    label: `Authenticator app ${n}`,
    type: 'TOTP',
    addedAt: 'Pending setup',
  })
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="Profile"
  >
    <template #body>
      <div class="flex flex-col gap-5">
        <!-- Identity -->
        <div class="flex items-center gap-3">
          <div class="flex h-12 w-12 items-center justify-center rounded-full bg-brand/10 text-brand">
            <UIcon name="i-lucide-user" class="text-xl" />
          </div>
          <div class="min-w-0">
            <p class="truncate text-base font-semibold text-ink">{{ name }}</p>
            <p class="truncate text-[13px] text-muted">{{ email }}</p>
          </div>
        </div>

        <!-- Info rows -->
        <dl class="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface">
          <div class="flex items-center justify-between px-4 py-3">
            <dt class="text-[13px] font-medium text-muted">Email</dt>
            <dd class="text-[13px] font-semibold text-ink">{{ email }}</dd>
          </div>
          <div class="flex items-center justify-between px-4 py-3">
            <dt class="text-[13px] font-medium text-muted">Name</dt>
            <dd class="text-[13px] font-semibold text-ink">{{ name }}</dd>
          </div>
          <div class="flex items-center justify-between px-4 py-3">
            <dt class="text-[13px] font-medium text-muted">Role</dt>
            <dd class="text-[13px] font-semibold text-ink">{{ role }}</dd>
          </div>
        </dl>

        <!-- Email notifications toggle -->
        <div class="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3">
          <div class="min-w-0 pr-4">
            <p class="text-[13px] font-semibold text-ink">Notification to email</p>
            <p class="text-[12px] text-muted">Receive account and policy alerts by email.</p>
          </div>
          <USwitch v-model="emailNotifications" aria-label="Toggle email notifications" />
        </div>

        <!-- MFA devices -->
        <div class="rounded-xl border border-line bg-surface">
          <div class="flex items-center justify-between border-b border-line px-4 py-3">
            <p class="text-[13px] font-semibold text-ink">MFA devices</p>
            <UButton
              icon="i-lucide-plus"
              size="xs"
              color="neutral"
              variant="ghost"
              label="Add more"
              class="font-semibold text-brand hover:bg-brand/10"
              @click="addMfaDevice"
            />
          </div>
          <ul class="flex flex-col divide-y divide-line">
            <li v-for="d in mfaDevices" :key="d.id" class="flex items-center gap-3 px-4 py-3">
              <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                <UIcon name="i-lucide-smartphone" class="text-base" />
              </div>
              <div class="min-w-0 flex-1">
                <p class="truncate text-[13px] font-medium text-ink">{{ d.label }}</p>
                <p class="text-[12px] text-muted">{{ d.type }} · {{ d.addedAt }}</p>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end">
        <UButton
          color="neutral"
          variant="ghost"
          label="Close"
          class="font-semibold text-brand hover:bg-brand/10"
          @click="open = false"
        />
      </div>
    </template>
  </UModal>
</template>
