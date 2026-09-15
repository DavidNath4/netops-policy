<script setup lang="ts">
// Dark navigation sidebar for the app shell (Figma "Network ops app").
// Dark background, light text, blue accent for the active link.
//
// Two-level structure: a parent item (itself a page) can own child items.
// "ACL Policies" owns "Add ACL"; "Routes" owns "Add Route". Parents show a
// chevron to expand/collapse their children, auto-opening on the active branch.
//
// Collapse modes:
// - Expanded (default): full labels + chevrons + inline children.
// - Rail (desktop collapsed): icon-only; labels appear as hover tooltips and
//   children are reached after expanding the sidebar again.
// The mobile drawer always renders expanded via `forceExpanded`.

interface NavLink {
  label: string
  to: string
  icon: string
  children?: NavLink[]
  // Permission code required to see this link. Omit = always visible
  // (Dashboard, Log Trail). Children carry their own permission (e.g. Add).
  permission?: string
}

const props = withDefaults(defineProps<{ forceExpanded?: boolean }>(), {
  forceExpanded: false,
})

// Emitted so the parent (default layout) can close the mobile drawer after navigation.
const emit = defineEmits<{ navigate: [] }>()

const { collapsed, toggleCollapsed } = useSidebar()

// Icon-only rail only applies on desktop collapse; the mobile drawer forces full.
const isRail = computed(() => collapsed.value && !props.forceExpanded)

// The collapse control only makes sense on desktop (the mobile drawer is always
// full and closes via the backdrop).
const showCollapseToggle = computed(() => !props.forceExpanded)

const { can } = usePermissions()

// Full menu definition with the permission each item requires. Dashboard and
// Log Trail have no permission — they are open to every authenticated user.
const allLinks: NavLink[] = [
  { label: 'Dashboard', to: '/', icon: 'i-lucide-layout-dashboard' },
  {
    label: 'ACL Policies',
    to: '/acl',
    icon: 'i-lucide-shield',
    permission: 'ACL_POLICIES_SHOW',
    children: [
      { label: 'Add ACL', to: '/acl/add', icon: 'i-lucide-shield-plus', permission: 'ACL_POLICIES_ADD' },
    ],
  },
  {
    label: 'Routes',
    to: '/routes',
    icon: 'i-lucide-route',
    permission: 'ROUTES_SHOW',
    children: [
      { label: 'Add Route', to: '/routes/add', icon: 'i-lucide-plus', permission: 'ROUTES_ADD' },
    ],
  },
  { label: 'Administration', to: '/administration', icon: 'i-lucide-users', permission: 'ADMINISTRATION_SHOW' },
  { label: 'Log Trail', to: '/logs', icon: 'i-lucide-scroll-text' },
]

// Gate by permission: a link with no `permission` is always shown; otherwise the
// user must hold it. Children are filtered the same way, and a parent with all
// children filtered out simply shows without the expandable sub-items.
const links = computed<NavLink[]>(() =>
  allLinks
    .filter(l => !l.permission || can(l.permission))
    .map(l => ({
      ...l,
      children: l.children?.filter(c => !c.permission || can(c.permission)),
    })),
)

const route = useRoute()

// Flatten to all navigable routes so we can pick a single "best match" (longest
// matching prefix). Keeps exactly one item highlighted, e.g. /acl/add lights
// "Add ACL", while /acl/123 lights "ACL Policies".
const allRoutes = computed(() =>
  links.value.flatMap(l => [l.to, ...(l.children?.map(c => c.to) ?? [])]),
)

const activeTo = computed(() => {
  const path = route.path
  let best: string | undefined
  for (const to of allRoutes.value) {
    const matches = to === '/' ? path === '/' : path === to || path.startsWith(to + '/')
    if (matches && (best === undefined || to.length > best.length)) {
      best = to
    }
  }
  return best
})

function isActive(to: string): boolean {
  return activeTo.value === to
}

// True when a parent OR any of its children is the active route.
function isBranchActive(link: NavLink): boolean {
  if (isActive(link.to)) return true
  return link.children?.some(c => isActive(c.to)) ?? false
}

// Expanded parents. Seeded so the branch containing the current route is open.
const expanded = ref<Set<string>>(new Set())

function syncExpanded() {
  for (const link of links.value) {
    if (link.children?.length && isBranchActive(link)) {
      expanded.value.add(link.to)
    }
  }
}
syncExpanded()
watch(() => route.path, syncExpanded)

function toggle(to: string) {
  if (expanded.value.has(to)) expanded.value.delete(to)
  else expanded.value.add(to)
}

function isExpanded(to: string): boolean {
  return expanded.value.has(to)
}
</script>

<template>
  <nav
    class="flex h-full w-full flex-col overflow-y-auto bg-sidebar"
    aria-label="Primary navigation"
  >
    <!-- Section label (hidden in rail mode) -->
    <p
      v-if="!isRail"
      class="px-[22px] pt-7 pb-3 text-[10px] font-semibold uppercase tracking-wider text-sidebar-muted"
    >
      Network Control
    </p>
    <div v-else class="pt-7" />

    <!-- ======================= RAIL (icon-only) ======================= -->
    <ul v-if="isRail" class="flex-1 space-y-1">
      <li v-for="link in links" :key="link.to">
        <NuxtLink
          :to="link.to"
          :title="link.label"
          :aria-label="link.label"
          :aria-current="isBranchActive(link) ? 'page' : undefined"
          class="group mx-2 flex h-10 items-center justify-center rounded-md text-sidebar-text transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          :class="isBranchActive(link) ? 'bg-brand text-sidebar-text' : 'hover:bg-white/5'"
          @click="emit('navigate')"
        >
          <UIcon :name="link.icon" class="shrink-0 text-lg" />
        </NuxtLink>
      </li>
    </ul>

    <!-- ======================= EXPANDED (full) ======================= -->
    <ul v-else class="flex-1 space-y-1">
      <li v-for="link in links" :key="link.to">
        <!-- Parent with children: link row + chevron toggle -->
        <template v-if="link.children?.length">
          <div
            class="group mx-3 flex h-9 items-center rounded-md pr-1 text-xs font-medium text-sidebar-text transition-colors duration-150"
            :class="isBranchActive(link) ? 'bg-brand text-sidebar-text' : 'hover:bg-white/5'"
          >
            <NuxtLink
              :to="link.to"
              :aria-current="isActive(link.to) ? 'page' : undefined"
              class="flex min-w-0 flex-1 items-center gap-3 rounded-md px-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              @click="emit('navigate')"
            >
              <UIcon :name="link.icon" class="shrink-0 text-base" />
              <span class="truncate">{{ link.label }}</span>
            </NuxtLink>

            <button
              type="button"
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              :aria-label="isExpanded(link.to) ? `Collapse ${link.label}` : `Expand ${link.label}`"
              :aria-expanded="isExpanded(link.to)"
              @click="toggle(link.to)"
            >
              <UIcon
                name="i-lucide-chevron-down"
                class="text-sm transition-transform duration-150"
                :class="isExpanded(link.to) ? 'rotate-180' : ''"
              />
            </button>
          </div>

          <!-- Children -->
          <ul v-show="isExpanded(link.to)" class="mt-1 space-y-1">
            <li v-for="child in link.children" :key="child.to">
              <NuxtLink
                :to="child.to"
                :aria-current="isActive(child.to) ? 'page' : undefined"
                class="group mx-3 flex h-8 items-center gap-3 rounded-md pl-9 pr-3 text-xs font-medium text-sidebar-text transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                :class="isActive(child.to) ? 'bg-brand text-sidebar-text' : 'hover:bg-white/5'"
                @click="emit('navigate')"
              >
                <UIcon :name="child.icon" class="shrink-0 text-sm" />
                <span class="truncate">{{ child.label }}</span>
              </NuxtLink>
            </li>
          </ul>
        </template>

        <!-- Plain link (no children) -->
        <NuxtLink
          v-else
          :to="link.to"
          :aria-current="isActive(link.to) ? 'page' : undefined"
          class="group mx-3 flex h-9 items-center gap-3 rounded-md px-3 text-xs font-medium text-sidebar-text transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          :class="isActive(link.to) ? 'bg-brand text-sidebar-text' : 'hover:bg-white/5'"
          @click="emit('navigate')"
        >
          <UIcon :name="link.icon" class="shrink-0 text-base" />
          <span>{{ link.label }}</span>
        </NuxtLink>
      </li>
    </ul>

    <!-- Collapse / expand control, inside the sidebar panel -->
    <div v-if="showCollapseToggle" class="mt-auto border-t border-white/10 p-2">
      <button
        type="button"
        class="flex w-full items-center gap-3 rounded-md px-3 py-2 text-xs font-medium text-sidebar-text transition-colors hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        :class="isRail ? 'justify-center' : ''"
        :aria-label="collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
        @click="toggleCollapsed"
      >
        <UIcon
          :name="collapsed ? 'i-lucide-chevrons-right' : 'i-lucide-chevrons-left'"
          class="shrink-0 text-base"
        />
        <span v-if="!isRail">Collapse</span>
      </button>
    </div>
  </nav>
</template>
