<script setup lang="ts">
// App shell (Figma "Network ops app"): a sticky white header spans the top, and
// a sticky dark sidebar sits on the left below it. Only the main content area
// scrolls — the header and sidebar stay fixed in place.
//
// The sidebar collapses to an icon-only rail on desktop (shared state via
// useSidebar) and becomes an overlay drawer on small screens.

const { collapsed, mobileOpen, closeMobile } = useSidebar()

// Close the mobile drawer whenever the route changes (e.g. after tapping a link).
const route = useRoute()
watch(() => route.path, closeMobile)

// Desktop sidebar width follows the collapsed state.
const sidebarWidth = computed(() => (collapsed.value ? '64px' : '215px'))
</script>

<template>
  <div class="flex min-h-screen flex-col bg-surface">
    <!-- Sticky header across the full width -->
    <LayoutAppHeader class="sticky top-0 z-30 shrink-0" />

    <!-- Row below the header: sticky sidebar (left) + scrollable content -->
    <div class="flex flex-1">
      <!-- Desktop sidebar: sticky under the header, width follows collapse -->
      <aside
        class="hidden shrink-0 transition-[width] duration-200 lg:block"
        :style="{ width: sidebarWidth }"
      >
        <div
          class="sticky top-16 h-[calc(100vh-4rem)] transition-[width] duration-200"
          :style="{ width: sidebarWidth }"
        >
          <LayoutAppSidebar />
        </div>
      </aside>

      <!-- Mobile drawer + backdrop -->
      <div v-if="mobileOpen" class="lg:hidden">
        <div
          class="fixed inset-0 z-40 bg-black/50"
          aria-hidden="true"
          @click="closeMobile"
        />
        <aside class="fixed bottom-0 left-0 top-16 z-50 w-[215px]">
          <LayoutAppSidebar :force-expanded="true" @navigate="closeMobile" />
        </aside>
      </div>

      <!-- Scrollable main content -->
      <main class="min-w-0 flex-1 p-6">
        <slot />
      </main>
    </div>
  </div>
</template>
