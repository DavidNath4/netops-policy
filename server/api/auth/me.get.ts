import { defineEventHandler } from 'h3'

import { getAuthenticatedUser } from '../../utils/auth'
import { toUserResponse } from '../../services/auth.service'
import { getEffectivePermissions } from '../../services/permission.service'
import { findWithRoleById } from '../../repositories/user.repository'
import { useDatabase } from '../../utils/db'
import { apiError, ok } from '../../utils/envelope'

/**
 * GET /api/auth/me — the current authenticated identity + role + effective
 * permissions.
 *
 * Resolves the session cookie to an active user, or 401. Returns the safe user
 * shape (no password hash, no secrets, no token) enriched with the user's role
 * code/name, plus the resolved RBAC permission codes so the frontend can gate
 * menus and buttons. The server still re-enforces every permission per request.
 */
export default defineEventHandler(async (event) => {
  const user = await getAuthenticatedUser(event)
  if (!user) {
    throw apiError(401, 'UNAUTHENTICATED', 'Authentication required')
  }

  const db = useDatabase()
  const [withRole, permissions] = await Promise.all([
    findWithRoleById(db, user.userId),
    getEffectivePermissions(db, user.userId),
  ])

  return ok({
    user: {
      ...toUserResponse(user),
      roleCode: withRole?.roleCode ?? null,
      roleName: withRole?.roleName ?? null,
    },
    permissions: [...permissions],
  })
})
