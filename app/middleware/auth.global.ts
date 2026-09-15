// Global route guard for the identity foundation.
//
// This is UX only — real authorization is enforced server-side by
// requireAuthenticatedUser(event). Here we resolve the session via
// GET /api/auth/me (the cookie is HttpOnly, so JS can't read it directly),
// then keep unauthenticated users out of protected pages and authenticated
// users out of the login/MFA pages.

// Pages reachable without an authenticated session.
const PUBLIC_ROUTES = new Set<string>(['/login', '/mfa/setup', '/mfa/verify'])

export default defineNuxtRouteMiddleware(async (to) => {
  const { user, fetchCurrentUser } = useAuth()

  // Resolve the session once per app load. `user` is shared via useState, so
  // after the first resolution subsequent navigations don't re-fetch unless it
  // was cleared (e.g. logout).
  const checked = useState<boolean>('auth:checked', () => false)
  if (!checked.value) {
    await fetchCurrentUser()
    checked.value = true
  }

  const isPublic = PUBLIC_ROUTES.has(to.path)
  const isAuthed = user.value !== null

  // Unauthenticated → only public routes allowed.
  if (!isAuthed && !isPublic) {
    return navigateTo('/login')
  }

  // Authenticated users shouldn't sit on the login page.
  if (isAuthed && to.path === '/login') {
    return navigateTo('/')
  }
})
