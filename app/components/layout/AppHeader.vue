<script setup lang="ts">
// Sticky white top header (Figma "Network ops app"): app title on the left;
// sidebar toggles, notifications, identity, and logout on the right.
//
// - Mobile: hamburger opens the sidebar drawer.
// - Desktop: a toggle collapses the sidebar to an icon-only rail.
// - Bell opens the notifications modal; the username opens the profile modal.

const { toggleMobile } = useSidebar()
const { user, logout } = useAuth()

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

async function onLogout() {
  // logout() clears auth state and navigates to /login itself.
  await logout()
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
        @click="onLogout"
      />
    </div>

    <!-- Modals -->
    <LayoutNotificationModal v-model:open="notifOpen" :count="notificationCount" />
    <LayoutProfileModal v-model:open="profileOpen" />
  </header>
</template>
