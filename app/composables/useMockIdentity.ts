// Temporary mock identity for the frontend-first phase (no auth yet).
// Task 13.1 replaces this with the real useAuth()/usePermissions() composables
// that read the authenticated session from /api/auth/me.

export interface MockIdentity {
  username: string
  role: 'ADMIN' | 'L2' | 'NOC'
}

const MOCK_IDENTITY: MockIdentity = {
  username: 'admin',
  role: 'ADMIN',
}

/**
 * Returns a static mock identity. Shaped so callers can be swapped to the real
 * auth composable later without changing how they read `username` / `role`.
 */
export function useMockIdentity(): MockIdentity {
  return MOCK_IDENTITY
}
