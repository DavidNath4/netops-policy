import { defineEventHandler, readBody } from 'h3'

import { LoginSchema } from '#shared/schemas/auth.schema'
import { AuthError, verifyLocalCredentials } from '../../services/auth.service'
import { findByUserId as findMfaByUserId } from '../../repositories/user-mfa.repository'
import { useDatabase } from '../../utils/db'
import { assertSameOrigin } from '../../utils/auth'
import { issueMfaChallenge } from '../../utils/mfa-challenge'
import { apiError, ok } from '../../utils/envelope'

/**
 * POST /api/auth/login — first factor.
 *
 * Verifies email + password only. On success it does NOT create a session; it
 * issues a short-lived MFA challenge and tells the client which MFA step is
 * next. All failures return the same generic 401 so accounts can't be
 * enumerated.
 *
 * SECURITY TODO (hardening candidate): rate-limit this endpoint per IP/account.
 * Not implemented here (no distributed limiter / Redis in scope).
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)

  const parsed = LoginSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    // Uniform failure — don't reveal which field was wrong.
    throw apiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials')
  }

  const db = useDatabase()

  let user
  try {
    user = await verifyLocalCredentials(db, parsed.data.email, parsed.data.password)
  }
  catch (err) {
    if (err instanceof AuthError) {
      throw apiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials')
    }
    throw err
  }

  const mfa = await findMfaByUserId(db, user.userId)
  const mfaActive = mfa?.isEnabled === true

  if (!mfaActive) {
    // No enrollment, or an enrollment that was never confirmed → setup required.
    const { expiresAt } = issueMfaChallenge(event, user.userId, 'MFA_ENROLLMENT')
    return ok({ status: 'MFA_SETUP_REQUIRED' as const, challengeExpiresAt: expiresAt })
  }

  const { expiresAt } = issueMfaChallenge(event, user.userId, 'MFA_LOGIN')
  return ok({ status: 'MFA_REQUIRED' as const, challengeExpiresAt: expiresAt })
})
