import { randomUUID } from 'node:crypto'
import { defineEventHandler } from 'h3'

import { revokeSession, validateSession } from '../../services/session.service'
import { record } from '../../services/audit.service'
import { buildAuditContext } from '../../utils/audit-context'
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
 *
 * The actor is resolved from the session BEFORE revocation so the LOGOUT audit
 * row carries the username/role snapshot. A logout with no active session writes
 * no audit row and still returns success.
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)

  const db = useDatabase()
  const user = await validateSession(db, event)

  if (user) {
    // Best-effort audit: a write failure must never change the logout response.
    try {
      await record(db, {
        module: 'AUTH',
        action: 'LOGOUT',
        status: 'SUCCESS',
        correlationId: randomUUID(),
        requestPayload: null,
        ...(await buildAuditContext(db, event, user)),
      })
    }
    catch {
      // Swallow: logout must stay idempotent and never leak internal detail.
    }
  }

  await revokeSession(db, event)
  clearMfaChallenge(event)

  return ok({ loggedOut: true as const })
})
