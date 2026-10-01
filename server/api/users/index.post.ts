import { defineEventHandler } from 'h3'

import { PERMISSIONS } from '#shared/constants/rbac'
import { assertSameOrigin, requirePermission } from '../../utils/auth'
import { apiError } from '../../utils/envelope'

/**
 * POST /api/users — DISABLED. User creation is turned off for now.
 *
 * The route is kept (with its origin + ADMINISTRATION_MANAGE checks) so the
 * API contract and authorization stay stable, but it rejects before creating
 * anything. To re-enable, restore the AdminCreateUserSchema validation and the
 * createUser(...) call (see git history).
 */
export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  await requirePermission(event, PERMISSIONS.ADMINISTRATION_MANAGE)

  throw apiError(403, 'FORBIDDEN', 'User creation is currently disabled')
})
