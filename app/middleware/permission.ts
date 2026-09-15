// Named route middleware for permission-gated pages (UX only — the server
// re-enforces every action). Attach via:
//   definePageMeta({ middleware: 'permission', permission: 'ADMINISTRATION_SHOW' })
//
// Runs after auth.global (which resolves the session + permissions), so by the
// time this runs the user's effective permissions are already loaded. A user
// missing the required permission is bounced to the dashboard (always allowed).
export default defineNuxtRouteMiddleware((to) => {
  const required = to.meta.permission as string | undefined
  if (!required) return

  const { can } = usePermissions()
  if (!can(required)) {
    return navigateTo('/')
  }
})
