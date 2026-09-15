import { defineEventHandler } from 'h3'

import { getAuthenticatedUser } from '../../utils/auth'
import { toUserResponse } from '../../services/auth.service'
import { apiError, ok } from '../../utils/envelope'

/**
 * GET /api/auth/me — the current authenticated identity.
 *
 * Resolves the session cookie to an active user, or 401. Returns only the safe
 * user shape (no password hash, no secrets, no token).
 */
export default defineEventHandler(async (event) => {
  const user = await getAuthenticatedUser(event)
  if (!user) {
    throw apiError(401, 'UNAUTHENTICATED', 'Authentication required')
  }
  return ok({ user: toUserResponse(user) })
})
