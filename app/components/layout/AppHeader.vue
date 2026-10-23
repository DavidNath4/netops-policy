<script setup lang="ts">
// Sticky white top header (Figma "Network ops app"): app title on the left;
// sidebar toggles, notifications, identity, and logout on the right.
//
// - Mobile: hamburger opens the sidebar drawer.
// - Desktop: a toggle collapses the sidebar to an icon-only rail.
// - Bell opens the notifications modal; the username opens the profile modal.

const { toggleMobile } = useSidebar()
const { user, logout } = useAuth()

// Global Device Session Credentials — one place to set them (this head bar),
// auto-filled everywhere. The chip shows the status + a live countdown; when the
// TTL elapses the modal re-opens to prompt for fresh credentials.
const { isActive, isExpired, countdown, status, ensureLoaded } = useDeviceCredentials()
const credModalOpen = ref(false)
onMounted(ensureLoaded)

// When the countdown hits zero (creds just expired), re-prompt automatically —
// but only once per expiry and not while the user already has the modal open.
const wasExpired = ref(false)
watch(isExpired, (expired) => {
  if (expired && !wasExpired.value && !credModalOpen.value) {
    credModalOpen.value = true
  }
  wasExpired.value = expired
})

// Display name of the authenticated user (falls back to email local-part).
const displayName = computed(() => {
  const u = user.value
  if (!u) return ''
  return u.displayName || u.email.split('@')[0] || u.email
})

// Unread notification count. Placeholder for now — the notifications feature is
// out of scope for the current phase; wire this to a real source later.
const notificationCount = ref(3)

const notifOpen = ref(false)
const profileOpen = ref(false)
const logoutOpen = ref(false)
const loggingOut = ref(false)

async function onLogout() {
  // logout() clears auth state and navigates to /login itself.
  loggingOut.value = true
  try {
    await logout()
  }
  finally {
    loggingOut.value = false
    logoutOpen.value = false
  }
}
</script>

<template>
  <header
    class="flex h-16 items-center gap-3 border-b border-line bg-panel px-4 sm:px-6"
  >
    <!-- Mobile: open the sidebar drawer -->
    <UButton
      icon="i-lucide-menu"
      color="neutral"
      variant="ghost"
      class="text-ink hover:bg-black/5 lg:hidden"
      aria-label="Open navigation"
      @click="toggleMobile"
    />

    <!-- Title -->
    <h1 class="text-[19px] font-semibold text-ink">
      NetOps Policy Manager
    </h1>

    <div class="ml-auto flex items-center gap-2 sm:gap-3">
      <!-- Global device credentials: status + live TTL countdown. Click to set
           or update; the chip turns amber when expired/unset. Auto-filled into
           every device call and credential form. -->
      <button
        type="button"
        class="flex h-9 items-center gap-2 rounded-md border px-2.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        :class="isActive
          ? 'border-line text-ink hover:bg-black/5'
          : 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100'"
        :aria-label="isActive
          ? `Device credentials set${status.username ? ` for ${status.username}` : ''}, expires in ${countdown}`
          : 'Set device credentials'"
        @click="credModalOpen = true"
      >
        <UIcon name="i-lucide-key-round" class="size-4 shrink-0" />
        <template v-if="isActive">
          <span class="hidden sm:inline">{{ status.username ?? 'Device creds' }}</span>
          <span class="font-mono tabular-nums text-muted">{{ countdown }}</span>
        </template>
        <span v-else class="whitespace-nowrap">Set credentials</span>
      </button>

      <!-- Notifications: bell with an unread indicator -->
      <button
        type="button"
        class="relative flex h-9 w-9 items-center justify-center rounded-md text-ink transition-colors hover:bg-black/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        :aria-label="notificationCount > 0
          ? `Notifications, ${notificationCount} unread`
          : 'Notifications'"
        @click="notifOpen = true"
      >
        <UIcon name="i-lucide-bell" class="text-lg" />
        <span
          v-if="notificationCount > 0"
          class="absolute -right-0.5 -top-0.5 flex min-w-[16px] items-center justify-center rounded-full bg-bad px-1 text-[10px] font-semibold leading-none text-white"
        >
          {{ notificationCount > 9 ? '9+' : notificationCount }}
        </span>
      </button>

      <!-- Identity: clickable, opens the profile modal -->
      <button
        v-if="displayName"
        type="button"
        class="rounded-md px-2 py-1 text-xs font-medium text-ink transition-colors hover:bg-black/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        aria-label="Open profile"
        @click="profileOpen = true"
      >
        {{ displayName }}
      </button>

      <!-- Logout -->
      <UButton
        icon="i-lucide-log-out"
        color="neutral"
        variant="ghost"
        aria-label="Logout"
        class="text-ink hover:bg-black/5"
        @click="logoutOpen = true"
      />
    </div>

    <!-- Modals -->
    <DeviceCredentialsModal v-model="credModalOpen" />
    <LayoutNotificationModal v-model:open="notifOpen" :count="notificationCount" />
    <LayoutProfileModal v-model:open="profileOpen" />
    <LayoutLogoutNotificationModal
      v-model:open="logoutOpen"
      :loading="loggingOut"
      @confirm="onLogout"
    />
  </header>
</template>
