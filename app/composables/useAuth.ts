// Real authentication composable (Development 1: User + Local Auth + MFA).
//
// Auth state is derived from GET /api/auth/me — the session lives only in the
// HttpOnly `netops_session` cookie, never in JS/localStorage. This composable
// never sees or stores a token.

/** Client-safe user shape returned by the auth endpoints (mirrors UserResponse). */
export interface AuthUser {
  userId: string
  email: string
  displayName: string
  authProvider: 'LOCAL' | 'AD'
  isActive: boolean
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

export type LoginStatus = 'MFA_SETUP_REQUIRED' | 'MFA_REQUIRED'
export type AuthedStatus = 'AUTHENTICATED'

interface Envelope<T> {
  success: boolean
  data: T
}

/** Pull the error code out of a thrown $fetch error, if present. */
function errorCode(err: unknown): string | undefined {
  const data = (err as { data?: { error?: { code?: string } } })?.data
  return data?.error?.code
}

export function useAuth() {
  // Shared across the app; SSR-safe via useState.
  const user = useState<AuthUser | null>('auth:user', () => null)
  const isLoading = useState<boolean>('auth:loading', () => false)
  const isAuthenticated = computed(() => user.value !== null)

  // Epoch-ms expiry of the current pre-auth MFA challenge (server-authoritative),
  // used by the MFA pages to show a countdown. Cleared once authenticated.
  const challengeExpiresAt = useState<number | null>('auth:challengeExpiresAt', () => null)

  async function login(email: string, password: string): Promise<LoginStatus> {
    const res = await $fetch<Envelope<{ status: LoginStatus, challengeExpiresAt: number }>>(
      '/api/auth/login',
      { method: 'POST', body: { email, password } },
    )
    challengeExpiresAt.value = res.data.challengeExpiresAt
    return res.data.status
  }

  async function setupMfa(): Promise<string> {
    const res = await $fetch<Envelope<{ otpauthUri: string }>>('/api/auth/mfa/setup', {
      method: 'POST',
    })
    return res.data.otpauthUri
  }

  async function verifyMfaSetup(code: string): Promise<AuthUser> {
    const res = await $fetch<Envelope<{ status: AuthedStatus, user: AuthUser }>>(
      '/api/auth/mfa/setup/verify',
      { method: 'POST', body: { code } },
    )
    user.value = res.data.user
    challengeExpiresAt.value = null
    return res.data.user
  }

  async function verifyMfa(code: string): Promise<AuthUser> {
    const res = await $fetch<Envelope<{ status: AuthedStatus, user: AuthUser }>>(
      '/api/auth/mfa/verify',
      { method: 'POST', body: { code } },
    )
    user.value = res.data.user
    challengeExpiresAt.value = null
    return res.data.user
  }

  /** Load the current user from the session cookie. Returns null when unauthenticated. */
  async function fetchCurrentUser(): Promise<AuthUser | null> {
    isLoading.value = true
    try {
      // Use a request-aware fetch so that during SSR (e.g. a browser refresh)
      // the incoming HttpOnly `netops_session` cookie is forwarded to the
      // internal /api/auth/me call. Plain $fetch drops cookies on the server,
      // which would make every refresh look unauthenticated.
      const requestFetch = useRequestFetch()
      const res = await requestFetch<Envelope<{ user: AuthUser }>>('/api/auth/me')
      user.value = res.data.user
      return user.value
    }
    catch (err) {
      if (errorCode(err) === 'UNAUTHENTICATED') {
        user.value = null
        return null
      }
      // Network or unexpected error: treat as unauthenticated but don't crash.
      user.value = null
      return null
    }
    finally {
      isLoading.value = false
    }
  }

  async function logout(): Promise<void> {
    try {
      await $fetch('/api/auth/logout', { method: 'POST' })
    }
    finally {
      user.value = null
      challengeExpiresAt.value = null
    }
  }

  return {
    user,
    isAuthenticated,
    isLoading,
    challengeExpiresAt,
    login,
    setupMfa,
    verifyMfaSetup,
    verifyMfa,
    fetchCurrentUser,
    logout,
  }
}
