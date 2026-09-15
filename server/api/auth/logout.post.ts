import { defineEventHandler } from 'h3'

import { revokeSession } from '../../services/session.service'
import { useDatabase } from '../../utils/db'
import { assertSameOrigin } from '../../utils/auth'
import { clearMfaChallenge } from '../../utils/mfa-challenge'
import { ok } from '../../utils/envelope'

/**
 * POST /api/auth/logout — end the session.
 *
 * Idempotent: deletes the DB session if present and clears both the session and
 * any lingering MFA-challenge cookie. Always reports success even if there was
 * nothing to remove.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)

  await revokeSession(useDatabase(), event)
  clearMfaChallenge(event)

  return ok({ loggedOut: true as const })
})
