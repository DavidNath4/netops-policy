// Shared sidebar state for the app shell.
//
// - `collapsed` (desktop): icon-only rail vs full menu with labels.
// - `mobileOpen` (small screens): the sidebar drawer overlay.
//
// Kept in `useState` so the header (toggle controls) and the layout/sidebar all
// read and write the same reactive state.

export function useSidebar() {
  const collapsed = useState<boolean>('sidebar:collapsed', () => false)
  const mobileOpen = useState<boolean>('sidebar:mobileOpen', () => false)

  function toggleCollapsed() {
    collapsed.value = !collapsed.value
  }

  function toggleMobile() {
    mobileOpen.value = !mobileOpen.value
  }

  function closeMobile() {
    mobileOpen.value = false
  }

  return { collapsed, mobileOpen, toggleCollapsed, toggleMobile, closeMobile }
}
