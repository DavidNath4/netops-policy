import { defineEventHandler, readBody } from 'h3'

import { LoginSchema } from '#shared/schemas/auth.schema'
import {
  AccountDisabledError,
  AdAccountDisabledError,
  AdCredentialsError,
  AuthError,
  DirectoryUnreachableError,
  verifyAdCredentials,
  verifyLocalCredentials,
} from '../../services/auth.service'
import { findByEmailOrUsername } from '../../repositories/user.repository'
import { findByUserId as findMfaByUserId } from '../../repositories/user-mfa.repository'
import { useDatabase } from '../../utils/db'
import { assertSameOrigin } from '../../utils/auth'
import { loadEnv } from '../../utils/config'
import { issueMfaChallenge } from '../../utils/mfa-challenge'
import { apiError, ok } from '../../utils/envelope'
import type { UserResponse } from '#shared/schemas/user.schema'

/**
 * POST /api/auth/login — first factor.
 *
 * Verifies the identifier + password against the appropriate provider (LOCAL
 * password or Active Directory bind), then — WITHOUT creating a session —
 * issues a short-lived MFA challenge and tells the client which MFA step is
 * next. Credential failures return the same generic 401 so accounts can't be
 * enumerated; a disabled account and an unreachable directory are distinct.
 *
 * Provider routing (server-only, never client-supplied):
 *   - identifier matches an existing LOCAL user  → LOCAL (if AUTH_LOCAL_ENABLED)
 *   - identifier matches an existing AD user      → AD    (if AD_ENABLED)
 *   - identifier unknown                          → AD    (if AD_ENABLED),
 *                                                   else LOCAL (if enabled)
 *
 * SECURITY TODO (hardening candidate): rate-limit this endpoint per IP/account.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)

  const parsed = LoginSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials')
  }

  const db = useDatabase()
  const env = loadEnv()
  const identifier = parsed.data.identifier
  const password = parsed.data.password

  // Resolve which provider verifies this attempt, based on any existing account.
  // Look up by email OR username (both stored lowercased) so a returning AD user
  // is recognized whether they typed their email or their AD username.
  const existing = await findByEmailOrUsername(db, identifier.toLowerCase())

  // Front-of-flow disabled gate: stop a deactivated NetOps account before any
  // credential verification (and, for AD, before contacting the directory).
  if (existing && !existing.isActive) {
    throw apiError(403, 'ACCOUNT_DISABLED', 'Account is disabled. Please contact your administrator.')
  }

  const provider = resolveProvider(existing?.authProvider, env)
  if (!provider) {
    // No enabled provider can serve this attempt.
    throw apiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials')
  }

  let user: UserResponse
  try {
    user = provider === 'AD'
      ? await verifyAdCredentials(db, identifier, password)
      : await verifyLocalCredentials(db, identifier.toLowerCase(), password)
  }
  catch (err) {
    // Generic credential failures (both providers).
    if (err instanceof AuthError || err instanceof AdCredentialsError) {
      throw apiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials')
    }
    // Account disabled — in NetOps or in the directory.
    if (err instanceof AccountDisabledError || err instanceof AdAccountDisabledError) {
      throw apiError(403, 'ACCOUNT_DISABLED', 'Account is disabled. Please contact your administrator.')
    }
    // Directory unreachable — distinct, informative, with a safe error code.
    if (err instanceof DirectoryUnreachableError) {
      throw apiError(503, 'AD_UNREACHABLE', `Directory unreachable (${err.code})`)
    }
    throw err
  }

  // Shared join point — identical for LOCAL and AD from here on.
  const mfa = await findMfaByUserId(db, user.userId)
  const mfaActive = mfa?.isEnabled === true

  if (!mfaActive) {
    const { expiresAt } = issueMfaChallenge(event, user.userId, 'MFA_ENROLLMENT')
    return ok({ status: 'MFA_SETUP_REQUIRED' as const, challengeExpiresAt: expiresAt })
  }

  const { expiresAt } = issueMfaChallenge(event, user.userId, 'MFA_LOGIN')
  return ok({ status: 'MFA_REQUIRED' as const, challengeExpiresAt: expiresAt })
})

/**
 * Decide which provider verifies a login, honoring the environment toggles.
 * Returns null when no enabled provider can serve the attempt.
 */
function resolveProvider(
  existingProvider: 'LOCAL' | 'AD' | undefined,
  env: ReturnType<typeof loadEnv>,
): 'LOCAL' | 'AD' | null {
  if (existingProvider === 'LOCAL') {
    return env.AUTH_LOCAL_ENABLED ? 'LOCAL' : null
  }
  if (existingProvider === 'AD') {
    return env.AD_ENABLED ? 'AD' : null
  }
  // Unknown identifier: prefer AD when enabled, else fall back to LOCAL.
  if (env.AD_ENABLED) return 'AD'
  if (env.AUTH_LOCAL_ENABLED) return 'LOCAL'
  return null
}
