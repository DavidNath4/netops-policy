import type { H3Event } from 'h3'
import { defineEventHandler, getRequestHeader, getRequestIP, readBody } from 'h3'

import { VerifyMfaSchema } from '#shared/schemas/mfa.schema'
import { randomUUID } from 'node:crypto'

import { toUserResponse, verifyMfaLogin } from '../../../services/auth.service'
import { findById as findUserById, updateLastLogin } from '../../../repositories/user.repository'
import { createSession } from '../../../services/session.service'
import { record } from '../../../services/audit.service'
import { buildAuditContext } from '../../../utils/audit-context'
import type { Database } from '~~/database'
import { useDatabase } from '../../../utils/db'
import { assertSameOrigin } from '../../../utils/auth'
import { clearMfaChallenge, readMfaChallenge } from '../../../utils/mfa-challenge'
import { apiError, ok } from '../../../utils/envelope'

/**
 * POST /api/auth/mfa/verify — second factor at login.
 *
 * Requires a valid MFA_LOGIN challenge. On a valid code: consume the challenge,
 * create the authenticated session cookie, and record last login. Invalid codes
 * return a generic 401.
 *
 * SECURITY TODO (hardening candidate): rate-limit OTP attempts. Not implemented.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)

  const db = useDatabase()

  const challenge = readMfaChallenge(event, 'MFA_LOGIN')
  if (!challenge) {
    // No known actor on an invalid/expired challenge.
    await recordMfaFailure(event, db, { userId: null, reason: 'MFA_CHALLENGE_INVALID' })
    throw apiError(401, 'MFA_CHALLENGE_INVALID', 'MFA challenge invalid or expired')
  }

  const parsed = VerifyMfaSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    await recordMfaFailure(event, db, { userId: challenge.userId, reason: 'INVALID_VERIFICATION_CODE' })
    throw apiError(401, 'INVALID_VERIFICATION_CODE', 'Invalid verification code')
  }

  const valid = await verifyMfaLogin(db, challenge.userId, parsed.data.code)
  if (!valid) {
    await recordMfaFailure(event, db, { userId: challenge.userId, reason: 'INVALID_VERIFICATION_CODE' })
    throw apiError(401, 'INVALID_VERIFICATION_CODE', 'Invalid verification code')
  }

  const user = await findUserById(db, challenge.userId)
  if (!user || !user.isActive) {
    clearMfaChallenge(event)
    await recordMfaFailure(event, db, { userId: challenge.userId, reason: 'MFA_CHALLENGE_INVALID' })
    throw apiError(401, 'MFA_CHALLENGE_INVALID', 'MFA challenge invalid or expired')
  }

  clearMfaChallenge(event)
  await createSession(db, event, user.userId)
  await updateLastLogin(db, user.userId)

  // Best-effort audit: a write failure must never change the AUTHENTICATED response.
  // Second factor is its own action (AUTH/MFA_VERIFY); the first factor was already
  // recorded as AUTH/LOGIN/SUCCESS in login.post.ts.
  try {
    await record(db, {
      module: 'AUTH',
      action: 'MFA_VERIFY',
      status: 'SUCCESS',
      correlationId: randomUUID(),
      requestPayload: { provider: user.authProvider },
      ...(await buildAuditContext(db, event, user)),
    })
  }
  catch {
    // Swallow: the login succeeded; audit failure must not break the response.
  }

  return ok({ status: 'AUTHENTICATED' as const, user: toUserResponse(user) })
})

/**
 * Record a failed second factor as TWO best-effort rows: AUTH/MFA_VERIFY/FAILED
 * and AUTH/LOGIN/FAILED. Both carry the same correlation id so they tie together.
 * Never changes the HTTP response and never persists the submitted code.
 */
async function recordMfaFailure(
  event: H3Event,
  db: Database,
  args: { userId: string | null, reason: 'INVALID_VERIFICATION_CODE' | 'MFA_CHALLENGE_INVALID' },
): Promise<void> {
  try {
    const actor = args.userId ? await findUserById(db, args.userId) : undefined
    const context = actor
      ? await buildAuditContext(db, event, actor)
      : {
          userId: null,
          username: null,
          userRole: null,
          sourceIp: getRequestIP(event)?.slice(0, 64) ?? null,
          userAgent: getRequestHeader(event, 'user-agent')?.slice(0, 512) ?? null,
        }

    const correlationId = randomUUID()
    const requestPayload = { reason: args.reason }

    await record(db, {
      module: 'AUTH',
      action: 'MFA_VERIFY',
      status: 'FAILED',
      correlationId,
      requestPayload,
      ...context,
    })
    await record(db, {
      module: 'AUTH',
      action: 'LOGIN',
      status: 'FAILED',
      correlationId,
      requestPayload,
      ...context,
    })
  }
  catch {
    // Swallow: a failed audit write must never alter the MFA response.
  }
}
