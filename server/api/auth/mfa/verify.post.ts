import { defineEventHandler, readBody } from 'h3'

import { VerifyMfaSchema } from '#shared/schemas/mfa.schema'
import { toUserResponse, verifyMfaLogin } from '../../../services/auth.service'
import { findById as findUserById, updateLastLogin } from '../../../repositories/user.repository'
import { createSession } from '../../../services/session.service'
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

  const challenge = readMfaChallenge(event, 'MFA_LOGIN')
  if (!challenge) {
    throw apiError(401, 'MFA_CHALLENGE_INVALID', 'MFA challenge invalid or expired')
  }

  const parsed = VerifyMfaSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw apiError(401, 'INVALID_VERIFICATION_CODE', 'Invalid verification code')
  }

  const db = useDatabase()

  const valid = await verifyMfaLogin(db, challenge.userId, parsed.data.code)
  if (!valid) {
    throw apiError(401, 'INVALID_VERIFICATION_CODE', 'Invalid verification code')
  }

  const user = await findUserById(db, challenge.userId)
  if (!user || !user.isActive) {
    clearMfaChallenge(event)
    throw apiError(401, 'MFA_CHALLENGE_INVALID', 'MFA challenge invalid or expired')
  }

  clearMfaChallenge(event)
  await createSession(db, event, user.userId)
  await updateLastLogin(db, user.userId)

  return ok({ status: 'AUTHENTICATED' as const, user: toUserResponse(user) })
})
