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
  roleCode: string | null
  roleName: string | null
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

export type LoginStatus = 'MFA_SETUP_REQUIRED' | 'MFA_REQUIRED'
export type AuthedStatus = 'AUTHENTICATED'

/** A user's enrolled MFA device as shown in the profile (no secret). */
export interface MfaDevice {
  mfaId: string
  label: string
  mfaType: 'TOTP'
  isEnabled: boolean
  verifiedAt: string | null
  createdAt: string
}

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
  const permissions = useState<string[]>('auth:permissions', () => [])
  const isLoading = useState<boolean>('auth:loading', () => false)
  const isAuthenticated = computed(() => user.value !== null)

  // Epoch-ms expiry of the current pre-auth MFA challenge (server-authoritative),
  // used by the MFA pages to show a countdown. Cleared once authenticated.
  const challengeExpiresAt = useState<number | null>('auth:challengeExpiresAt', () => null)

  // Shared with auth.global middleware: whether the session was resolved once.
  const checked = useState<boolean>('auth:checked', () => false)

  async function login(identifier: string, password: string): Promise<LoginStatus> {
    const res = await $fetch<Envelope<{ status: LoginStatus, challengeExpiresAt: number }>>(
      '/api/auth/login',
      { method: 'POST', body: { identifier, password } },
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
    challengeExpiresAt.value = null
    // The session now exists — load the full identity + effective permissions
    // so the sidebar/pages are correct on first navigation (no refresh needed).
    await fetchCurrentUser()
    return res.data.user
  }

  async function verifyMfa(code: string): Promise<AuthUser> {
    const res = await $fetch<Envelope<{ status: AuthedStatus, user: AuthUser }>>(
      '/api/auth/mfa/verify',
      { method: 'POST', body: { code } },
    )
    challengeExpiresAt.value = null
    // Load identity + permissions post-session so gating is correct immediately.
    await fetchCurrentUser()
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
      const res = await requestFetch<Envelope<{ user: AuthUser, permissions: string[] }>>('/api/auth/me')
      user.value = res.data.user
      permissions.value = res.data.permissions ?? []
      checked.value = true
      return user.value
    }
    catch (err) {
      if (errorCode(err) === 'UNAUTHENTICATED') {
        user.value = null
        permissions.value = []
        checked.value = true
        return null
      }
      // Network or unexpected error: treat as unauthenticated but don't crash.
      user.value = null
      permissions.value = []
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
      // Clear all auth state up front so the UI doesn't briefly render a
      // half-empty authenticated shell, then leave the current route.
      user.value = null
      permissions.value = []
      challengeExpiresAt.value = null
      checked.value = false
      await navigateTo('/login')
    }
  }

  // ---- Multi-device MFA management (post-auth, from the profile) ----------

  /** List the signed-in user's enrolled MFA devices (enabled + pending). */
  async function listMfaDevices(): Promise<MfaDevice[]> {
    const requestFetch = useRequestFetch()
    const res = await requestFetch<Envelope<{ devices: MfaDevice[] }>>('/api/auth/mfa/devices')
    return res.data.devices
  }

  /** Begin adding a device; returns its pending id + otpauth URI for the QR. */
  async function addMfaDeviceBegin(label?: string): Promise<{ mfaId: string, otpauthUri: string }> {
    const res = await $fetch<Envelope<{ mfaId: string, otpauthUri: string }>>(
      '/api/auth/mfa/devices',
      { method: 'POST', body: { label } },
    )
    return res.data
  }

  /** Confirm a newly-added device with its first 6-digit code. */
  async function verifyMfaDevice(mfaId: string, code: string): Promise<void> {
    await $fetch('/api/auth/mfa/devices/verify', {
      method: 'POST',
      body: { mfaId, code },
    })
  }

  /** Remove one of the user's devices (server refuses the last one). */
  async function deleteMfaDevice(mfaId: string): Promise<void> {
    await $fetch(`/api/auth/mfa/devices/${mfaId}`, { method: 'DELETE' })
  }

  return {
    user,
    permissions,
    isAuthenticated,
    isLoading,
    challengeExpiresAt,
    login,
    setupMfa,
    verifyMfaSetup,
    verifyMfa,
    fetchCurrentUser,
    logout,
    listMfaDevices,
    addMfaDeviceBegin,
    verifyMfaDevice,
    deleteMfaDevice,
  }
}
