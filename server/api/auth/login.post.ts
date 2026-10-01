import { randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'
import { defineEventHandler, getRequestHeader, getRequestIP, readBody } from 'h3'

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
import type { UserRow } from '../../repositories/user.repository'
import { findById, findByEmailOrUsername } from '../../repositories/user.repository'
import { findByUserId as findMfaByUserId } from '../../repositories/user-mfa.repository'
import { record } from '../../services/audit.service'
import { buildAuditContext } from '../../utils/audit-context'
import type { Database } from '~~/database'
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

  const db = useDatabase()

  const parsed = LoginSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    await recordLoginFailure(event, db, { identifier: null, reason: 'INVALID_BODY' })
    throw apiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials')
  }

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
    await recordLoginFailure(event, db, { identifier, user: existing, reason: 'ACCOUNT_DISABLED' })
    throw apiError(403, 'ACCOUNT_DISABLED', 'Account is disabled. Please contact your administrator.')
  }

  const provider = resolveProvider(existing?.authProvider, env)
  if (!provider) {
    // No enabled provider can serve this attempt.
    await recordLoginFailure(event, db, { identifier, reason: 'NO_PROVIDER' })
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
      await recordLoginFailure(event, db, { identifier, user: existing ?? undefined, provider, reason: 'INVALID_CREDENTIALS' })
      throw apiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials')
    }
    // Account disabled — in NetOps or in the directory.
    if (err instanceof AccountDisabledError || err instanceof AdAccountDisabledError) {
      await recordLoginFailure(event, db, { identifier, user: existing ?? undefined, provider, reason: 'ACCOUNT_DISABLED' })
      throw apiError(403, 'ACCOUNT_DISABLED', 'Account is disabled. Please contact your administrator.')
    }
    // Directory unreachable — distinct, informative, with a safe error code.
    if (err instanceof DirectoryUnreachableError) {
      await recordLoginFailure(event, db, { identifier, provider, reason: 'AD_UNREACHABLE' })
      throw apiError(503, 'AD_UNREACHABLE', `Directory unreachable (${err.code})`)
    }
    // Unexpected internal error — not an auth-attempt outcome; do not audit here.
    throw err
  }

  // First factor verified. Record AUTH/LOGIN/SUCCESS now, BEFORE issuing the MFA
  // challenge — both the enrollment and the login branch count as a successful
  // first factor. The second factor is audited separately as AUTH/MFA_VERIFY.
  await recordLoginSuccess(event, db, { user, existing, provider })

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
 * Record exactly one AUTH / LOGIN / SUCCESS audit row for a successful first
 * factor (password or AD bind). Best-effort: a write failure is swallowed so it
 * can never change the HTTP status/body of the login response, and no password
 * is ever logged (`requestPayload` carries only the non-secret provider).
 *
 * The actor is resolved to a `UserRow` for the context snapshot: prefer the
 * pre-resolved `existing` row, otherwise re-fetch by id (AD users just-in-time
 * provisioned by sAMAccountName still resolve this way).
 */
async function recordLoginSuccess(
  event: H3Event,
  db: Database,
  args: { user: UserResponse, existing?: UserRow, provider: 'LOCAL' | 'AD' },
): Promise<void> {
  try {
    const actor = args.existing ?? (await findById(db, args.user.userId))
    const context = actor
      ? await buildAuditContext(db, event, actor)
      : {
          userId: args.user.userId,
          username: args.user.username ?? args.user.email,
          userRole: null,
          sourceIp: getRequestIP(event)?.slice(0, 64) ?? null,
          userAgent: getRequestHeader(event, 'user-agent')?.slice(0, 512) ?? null,
        }

    await record(db, {
      module: 'AUTH',
      action: 'LOGIN',
      status: 'SUCCESS',
      correlationId: randomUUID(),
      requestPayload: { provider: args.provider },
      ...context,
    })
  }
  catch {
    // Swallow: a failed audit write must never alter the login response.
  }
}

/**
 * Record exactly one AUTH / LOGIN / FAILED audit row for a failed login attempt.
 *
 * Best-effort and self-contained: a write failure is swallowed so it can never
 * change the HTTP status, body, or generic message of the login response, and no
 * secret is ever logged. NEVER pass a password into this helper — `requestPayload`
 * carries only the non-secret identifier, optional provider, and a machine reason.
 */
async function recordLoginFailure(
  event: H3Event,
  db: Database,
  args: {
    identifier: string | null
    user?: UserRow
    provider?: 'LOCAL' | 'AD'
    reason: 'INVALID_CREDENTIALS' | 'ACCOUNT_DISABLED' | 'AD_UNREACHABLE' | 'NO_PROVIDER' | 'INVALID_BODY'
  },
): Promise<void> {
  try {
    const context = args.user
      ? await buildAuditContext(db, event, args.user)
      : {
          userId: null,
          username: args.identifier,
          userRole: null,
          sourceIp: getRequestIP(event)?.slice(0, 64) ?? null,
          userAgent: getRequestHeader(event, 'user-agent')?.slice(0, 512) ?? null,
        }

    await record(db, {
      module: 'AUTH',
      action: 'LOGIN',
      status: 'FAILED',
      correlationId: randomUUID(),
      requestPayload: {
        identifier: args.identifier,
        ...(args.provider ? { provider: args.provider } : {}),
        reason: args.reason,
      },
      ...context,
    })
  }
  catch {
    // Swallow: a failed audit write must never alter the login response.
  }
}

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
