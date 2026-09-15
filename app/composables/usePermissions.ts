// Frontend permission gating for data-driven RBAC.
//
// Reads the current user's effective permission codes (resolved server-side and
// delivered via GET /api/auth/me, stored in useAuth state) and exposes simple
// checks for gating menus and buttons. This is UX only — the server re-enforces
// every permission on the corresponding request.

export function usePermissions() {
  const { permissions } = useAuth()

  const codes = computed(() => new Set(permissions.value))

  /** True when the user holds the given permission code. */
  function can(code: string): boolean {
    return codes.value.has(code)
  }

  /** True when the user holds at least one of the given codes. */
  function canAny(...wanted: string[]): boolean {
    return wanted.some(c => codes.value.has(c))
  }

  return { can, canAny }
}
