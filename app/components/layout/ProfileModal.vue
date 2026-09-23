<script setup lang="ts">
// Profile modal opened by clicking the username in the header.
//
// Shows the authenticated identity (email/name from the real session), a few
// account controls, and the user's real MFA devices (list/add/remove). Role and
// the "email notifications" switch remain UI-only placeholders for now.
import type { MfaDevice } from '~/composables/useAuth'

const MFA_DEVICE_LIMIT = 2

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

// Writable proxy: parent owns visibility via v-model:open.
const open = computed({
  get: () => props.open,
  set: value => emit('update:open', value),
})

const { user, listMfaDevices, deleteMfaDevice } = useAuth()
const toast = useToast()

const email = computed(() => user.value?.email ?? '—')
const name = computed(() => user.value?.displayName ?? '—')
// AD username (sAMAccountName). LOCAL accounts have none, so the row is hidden.
const username = computed(() => user.value?.username ?? null)

// Real role from the authenticated session (RBAC). Falls back gracefully.
const role = computed(() => user.value?.roleName ?? user.value?.roleCode ?? '—')

// Local-only switch (not persisted yet).
const emailNotifications = ref(true)

// ---- MFA devices (real data) --------------------------------------------
const devices = ref<MfaDevice[]>([])
const devicesLoading = ref(false)
const devicesError = ref(false)

// Only confirmed devices count toward the add/remove business rules.
const enabledDevices = computed(() => devices.value.filter(d => d.isEnabled))
const canAddDevice = computed(() => enabledDevices.value.length < MFA_DEVICE_LIMIT)
// A user must always keep at least one device, so removal needs 2+.
const canRemoveDevice = computed(() => enabledDevices.value.length > 1)

async function loadDevices() {
  devicesLoading.value = true
  devicesError.value = false
  try {
    devices.value = await listMfaDevices()
  }
  catch {
    devicesError.value = true
  }
  finally {
    devicesLoading.value = false
  }
}

// Load whenever the modal opens (and refresh in case a device was just added).
watch(open, (isOpen) => {
  if (isOpen) void loadDevices()
})

// When the user finishes adding a device in the other tab and switches back,
// refresh the list so the new device (or the unchanged state) is accurate.
function onWindowFocus() {
  if (open.value) void loadDevices()
}
onMounted(() => window.addEventListener('focus', onWindowFocus))
onBeforeUnmount(() => window.removeEventListener('focus', onWindowFocus))

// Format the enrolled date for display (e.g. "Added 14 Sep 2026").
function formatAdded(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `Added ${d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}`
}

// ---- Add device: yes/no confirm, then redirect to the setup page ---------
const addConfirmOpen = ref(false)

function onAddClick() {
  if (!canAddDevice.value) return
  addConfirmOpen.value = true
}

function onConfirmAdd() {
  addConfirmOpen.value = false
  // Open the setup flow in a NEW TAB (white, centered card via the auth layout).
  // The profile modal stays open here; the list refreshes when the user returns
  // to this tab (see the focus/visibility handlers below).
  window.open('/mfa/add-device', '_blank', 'noopener')
}

// ---- Remove device: confirm, then delete ---------------------------------
const removeConfirmOpen = ref(false)
const removeTarget = ref<MfaDevice | null>(null)
const removing = ref(false)

function onRemoveClick(device: MfaDevice) {
  if (!canRemoveDevice.value) return
  removeTarget.value = device
  removeConfirmOpen.value = true
}

async function onConfirmRemove() {
  const target = removeTarget.value
  if (!target) return
  removing.value = true
  try {
    await deleteMfaDevice(target.mfaId)
    toast.add({ title: 'MFA device removed', color: 'success', icon: 'i-lucide-check' })
    removeConfirmOpen.value = false
    await loadDevices()
  }
  catch {
    toast.add({
      title: 'Error',
      description: 'Could not remove the device.',
      color: 'error',
      icon: 'i-lucide-circle-alert',
    })
  }
  finally {
    removing.value = false
  }
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
          <div v-if="username" class="flex items-center justify-between px-4 py-3">
            <dt class="text-[13px] font-medium text-muted">Username</dt>
            <dd class="text-[13px] font-semibold text-ink">{{ username }}</dd>
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
            <div class="min-w-0">
              <p class="text-[13px] font-semibold text-ink">MFA devices</p>
              <p class="text-[12px] text-muted">You can register up to {{ MFA_DEVICE_LIMIT }} devices.</p>
            </div>
            <UButton
              icon="i-lucide-plus"
              size="xs"
              color="neutral"
              variant="ghost"
              label="Add more"
              class="font-semibold text-brand hover:bg-brand/10"
              :disabled="!canAddDevice || devicesLoading"
              :title="canAddDevice ? undefined : `Maximum of ${MFA_DEVICE_LIMIT} devices reached`"
              @click="onAddClick"
            />
          </div>

          <!-- Loading -->
          <div v-if="devicesLoading" class="px-4 py-6">
            <LoadingState />
          </div>

          <!-- Error -->
          <div v-else-if="devicesError" class="flex items-center justify-between px-4 py-4">
            <p class="text-[13px] text-bad" role="alert">Could not load your MFA devices.</p>
            <UButton size="xs" color="neutral" variant="outline" label="Retry" @click="loadDevices" />
          </div>

          <!-- Empty (shouldn't normally happen — a user always has ≥1) -->
          <div v-else-if="devices.length === 0" class="px-4 py-6 text-center">
            <p class="text-[13px] text-muted">No MFA devices registered yet.</p>
          </div>

          <!-- Device list -->
          <ul v-else class="flex flex-col divide-y divide-line">
            <li v-for="d in devices" :key="d.mfaId" class="flex items-center gap-3 px-4 py-3">
              <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                <UIcon name="i-lucide-smartphone" class="text-base" />
              </div>
              <div class="min-w-0 flex-1">
                <p class="truncate text-[13px] font-medium text-ink">{{ d.label }}</p>
                <p class="text-[12px] text-muted">
                  {{ d.mfaType }}
                  <template v-if="d.isEnabled">· {{ formatAdded(d.createdAt) }}</template>
                  <template v-else>· Pending setup</template>
                </p>
              </div>
              <UButton
                icon="i-lucide-trash-2"
                size="xs"
                color="error"
                variant="ghost"
                aria-label="Remove device"
                :disabled="!canRemoveDevice"
                :title="canRemoveDevice ? 'Remove device' : 'You must keep at least one device'"
                @click="onRemoveClick(d)"
              />
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

  <!-- Add-device confirm popup (yes/no). On "yes" we redirect to the setup page. -->
  <UModal
    v-model:open="addConfirmOpen"
    title="Set up a new MFA device?"
    description="You'll scan a new QR code and enter a 6-digit code, just like your first setup."
  >
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="No" @click="addConfirmOpen = false" />
        <UButton label="Yes, set up" @click="onConfirmAdd" />
      </div>
    </template>
  </UModal>

  <!-- Remove-device confirmation (shared destructive-action dialog). -->
  <ConfirmDialog
    v-model="removeConfirmOpen"
    title="Remove MFA device?"
    :message="`This removes ${removeTarget?.label ?? 'this device'} from your account. You'll no longer be able to use it for sign-in.`"
    confirm-label="Remove"
    confirm-color="error"
    :loading="removing"
    @confirm="onConfirmRemove"
  />
</template>
