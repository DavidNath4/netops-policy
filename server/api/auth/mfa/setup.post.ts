import { defineEventHandler } from 'h3'

import { prepareMfaEnrollment } from '../../../services/auth.service'
import { findByUserId as findMfaByUserId } from '../../../repositories/user-mfa.repository'
import { buildTotpUri, decryptSecret } from '../../../services/mfa.service'
import { findById as findUserById } from '../../../repositories/user.repository'
import { useDatabase } from '../../../utils/db'
import { assertSameOrigin } from '../../../utils/auth'
import { readMfaChallenge } from '../../../utils/mfa-challenge'
import { apiError, ok } from '../../../utils/envelope'

/**
 * POST /api/auth/mfa/setup — begin TOTP enrollment.
 *
 * Requires a valid MFA_ENROLLMENT challenge (i.e. the password step just
 * passed). Returns the otpauth:// URI for the authenticator app.
 *
 * Idempotent: if an unconfirmed enrollment already exists we reuse its secret
 * instead of creating a duplicate row (there's a UNIQUE constraint on user_id
 * anyway). We never touch an already-enabled enrollment here.
 *
 * SECURITY: the otpauth URI carries the TOTP secret — it is only returned while
 * the enrollment challenge is valid, and is never logged or persisted.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)

  const challenge = readMfaChallenge(event, 'MFA_ENROLLMENT')
  if (!challenge) {
    throw apiError(401, 'MFA_CHALLENGE_INVALID', 'MFA challenge invalid or expired')
  }

  const db = useDatabase()

  const existing = await findMfaByUserId(db, challenge.userId)

  // Reuse a pending (unconfirmed) enrollment so we stay idempotent and never
  // strand a half-set-up secret. A confirmed enrollment shouldn't reach setup,
  // but if it does we regenerate rather than leak the live secret.
  if (existing && !existing.isEnabled) {
    const user = await findUserById(db, challenge.userId)
    if (!user) {
      throw apiError(401, 'MFA_CHALLENGE_INVALID', 'MFA challenge invalid or expired')
    }
    const secret = decryptSecret(existing.secretEncrypted)
    return ok({ otpauthUri: buildTotpUri(secret, user.email) })
  }

  const { otpauthUri } = await prepareMfaEnrollment(db, challenge.userId)
  return ok({ otpauthUri })
})
